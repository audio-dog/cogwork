import {
  Connection,
  ConnectionEstablishment,
  ConnectionFailure,
  type ConnectionId,
  ConnectionNotReady,
  type ConnectionOverview,
  type ConnectionReadiness,
  ConnectionSystem,
  connectionIdOf,
  type IssueTrackerError,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ConnectionVerifier } from "./connection-verify";
import { ControlStore } from "./control-store";
import {
  type Credential,
  type CredentialAccount,
  type CredentialError,
  CredentialStore,
} from "./credential-store";

const knownSystems: ReadonlyArray<ConnectionSystem> = ConnectionSystem.literals;

const tokenEnvs: Record<ConnectionSystem, string> = {
  github: "GITHUB_TOKEN",
  linear: "LINEAR_API_KEY",
  granola: "GRANOLA_API_KEY",
  slack: "SLACK_TOKEN",
};

const systemLabels: Record<ConnectionSystem, string> = {
  github: "GitHub",
  linear: "Linear",
  granola: "Granola",
  slack: "Slack",
};

export const connectionOverview = (
  connections: ReadonlyArray<Connection>,
  readinessById: ReadonlyMap<string, ConnectionReadiness>,
): ConnectionOverview => ({
  connections: knownSystems.map((system) => {
    const connection = connections.find((candidate) => candidate.system === system) ?? null;
    const readiness = connection
      ? (readinessById.get(connection.id) ??
        ({ _tag: "NotReady", reason: "Connection unavailable" } satisfies ConnectionReadiness))
      : ({ _tag: "NotReady", reason: "Not connected" } satisfies ConnectionReadiness);
    return { system, connection, readiness };
  }),
});

export const credentialAccountFor = (connection: Connection): CredentialAccount => ({
  connectionId: connection.id,
  key: connection.id,
  issueTracker: connection.system,
  organization: connection.account === "default" ? null : connection.account,
  tokenEnv: tokenEnvs[connection.system],
  clientCredentials: null,
  oauthClientId: null,
});

const credentialAccountForEstablishment = (input: ConnectionEstablishment) =>
  ConnectionEstablishment.match(input, {
    github: () => ({
      key: "github",
      issueTracker: "github",
      organization: null,
      tokenEnv: "GITHUB_TOKEN",
      clientCredentials: null,
      oauthClientId: null,
    }),
    linear: ({ account }) => ({
      key: `linear/${account}`,
      issueTracker: "linear",
      organization: account,
      tokenEnv: "LINEAR_API_KEY",
      clientCredentials: null,
      oauthClientId: null,
    }),
    granola: ({ account }) => ({
      key: `granola/${account}`,
      issueTracker: "granola",
      organization: account,
      tokenEnv: "GRANOLA_API_KEY",
      clientCredentials: null,
      oauthClientId: null,
    }),
    slack: ({ account }) => ({
      key: `slack/${account}`,
      issueTracker: "slack",
      organization: account,
      tokenEnv: "SLACK_TOKEN",
      clientCredentials: null,
      oauthClientId: null,
    }),
  });

const knownConnectionId = (input: ConnectionEstablishment, expectedAccount?: string) => {
  const requested = ConnectionEstablishment.match(input, {
    github: () => null,
    linear: ({ account }) => account,
    granola: ({ account }) => account,
    slack: ({ account }) => account,
  });
  if (requested !== null) return connectionIdOf(input.system, requested);
  if (expectedAccount !== undefined) return connectionIdOf(input.system, expectedAccount);
  return null;
};

const accountsMatch = (system: ConnectionSystem, account: string, expectedAccount: string) =>
  system === "github" ? account.toLowerCase() === expectedAccount.toLowerCase() : account === expectedAccount;

const unavailable = (operation: string, connectionId: ConnectionId | null, message: string) =>
  new ConnectionFailure({ operation, connectionId, message });

const unreadable = (connectionId: ConnectionId | null, error: { readonly message: string }) =>
  new ConnectionNotReady({
    connectionId,
    message: `Cogwork could not read the credential: ${error.message}`,
  });

const refused = (
  connectionId: ConnectionId | null,
  system: ConnectionSystem,
  error: { readonly message: string },
) =>
  new ConnectionNotReady({
    connectionId,
    message: `${systemLabels[system]} rejected the credential: ${error.message}`,
  });

export interface ConnectionStoreService {
  readonly overview: Effect.Effect<ConnectionOverview, ConnectionFailure>;
  readonly find: (connectionId: ConnectionId) => Effect.Effect<Connection | null, ConnectionFailure>;
  readonly findSystem: (system: ConnectionSystem) => Effect.Effect<Connection | null, ConnectionFailure>;
  readonly bearer: (
    connectionId: ConnectionId,
  ) => Effect.Effect<Credential, ConnectionFailure | ConnectionNotReady | CredentialError>;
  readonly readiness: (connectionId: ConnectionId) => Effect.Effect<ConnectionReadiness>;
  readonly requireReady: (
    connectionId: ConnectionId,
  ) => Effect.Effect<void, ConnectionNotReady | ConnectionFailure>;
  readonly requireSystemReady: (
    system: ConnectionSystem,
  ) => Effect.Effect<void, ConnectionNotReady | ConnectionFailure>;
  // `ConnectionNotReady` is the rejected-credential case: nothing was written. Only its message
  // survives the RPC seam, so the message alone has to say what happened.
  readonly establish: (
    input: ConnectionEstablishment,
    expectedAccount?: string,
  ) => Effect.Effect<Connection, ConnectionFailure | ConnectionNotReady | CredentialError>;
  readonly revoke: (connectionId: ConnectionId) => Effect.Effect<void, ConnectionFailure>;
  readonly remove: (connectionId: ConnectionId) => Effect.Effect<void, ConnectionFailure | CredentialError>;
}

const missingStore: ConnectionStoreService = {
  overview: Effect.fail(unavailable("read Connections", null, "Connection store unavailable")),
  find: (connectionId) =>
    Effect.fail(unavailable("find Connection", connectionId, "Connection store unavailable")),
  findSystem: () => Effect.succeed(null),
  bearer: (connectionId) =>
    Effect.fail(unavailable("read Connection credential", connectionId, "Connection store unavailable")),
  readiness: () => Effect.succeed({ _tag: "NotReady", reason: "Connection store unavailable" }),
  requireReady: (connectionId) =>
    Effect.fail(new ConnectionNotReady({ connectionId, message: "Connection store unavailable" })),
  requireSystemReady: (_system) =>
    Effect.fail(
      new ConnectionNotReady({
        connectionId: null,
        message: "Connection store unavailable",
      }),
    ),
  establish: (input) =>
    Effect.fail(
      unavailable("establish Connection", knownConnectionId(input), "Connection store unavailable"),
    ),
  revoke: (connectionId) =>
    Effect.fail(unavailable("revoke Connection", connectionId, "Connection store unavailable")),
  remove: (connectionId) =>
    Effect.fail(unavailable("remove Connection", connectionId, "Connection store unavailable")),
};

export const ConnectionStore = Context.Reference<ConnectionStoreService>(
  "@cogwork/engine/connection/ConnectionStore",
  { defaultValue: () => missingStore },
);

export const layer = Layer.effect(
  ConnectionStore,
  Effect.gen(function* () {
    const controlStore = yield* ControlStore;
    const credentials = yield* CredentialStore;
    const verifier = yield* ConnectionVerifier;

    const picture = Effect.fn("ConnectionStore.picture")(function* () {
      return yield* controlStore.picture.pipe(
        Effect.mapError((error) => unavailable("read Connections", null, error.message)),
      );
    });

    const find = Effect.fn("ConnectionStore.find")(function* (connectionId: ConnectionId) {
      return (yield* picture()).connections.find((connection) => connection.id === connectionId) ?? null;
    });

    const findSystem = Effect.fn("ConnectionStore.findSystem")(function* (system: ConnectionSystem) {
      return (yield* picture()).connections.find((connection) => connection.system === system) ?? null;
    });

    const bearer = Effect.fn("ConnectionStore.bearer")(function* (connectionId: ConnectionId) {
      const connection = yield* find(connectionId);
      if (!connection) {
        return yield* new ConnectionNotReady({ connectionId, message: "Connection does not exist" });
      }
      if (connection.status !== "established") {
        return yield* new ConnectionNotReady({ connectionId, message: "Connection needs re-connect" });
      }
      return yield* credentials.bearerToken(credentialAccountFor(connection));
    });

    const verifyGranolaWhenAvailable = (credential: Credential) =>
      verifier.verify("granola", credential).pipe(
        Effect.catchIf(
          (error) => error.reason === "unavailable",
          () => Effect.succeed(null),
        ),
      );

    const readinessVerifiers: Record<
      ConnectionSystem,
      (credential: Credential) => Effect.Effect<string | null, IssueTrackerError>
    > = {
      github: (_credential) => Effect.succeed(null),
      linear: (_credential) => Effect.succeed(null),
      granola: verifyGranolaWhenAvailable,
      slack: (_credential) => Effect.succeed(null),
    };
    const verifyReadiness = (connection: Connection, credential: Credential) =>
      readinessVerifiers[connection.system](credential);

    const establishmentVerifiers: Record<
      ConnectionSystem,
      (credential: Credential) => Effect.Effect<string | null, IssueTrackerError>
    > = {
      github: (credential) => verifier.verify("github", credential),
      linear: (credential) => verifier.verify("linear", credential),
      granola: verifyGranolaWhenAvailable,
      slack: (_credential) => Effect.succeed(null),
    };

    const readiness = Effect.fn("ConnectionStore.readiness")(function* (connectionId: ConnectionId) {
      return yield* find(connectionId).pipe(
        Effect.flatMap((connection) =>
          connection
            ? bearer(connectionId).pipe(
                Effect.flatMap((credential) => verifyReadiness(connection, credential)),
                Effect.mapError((error) =>
                  error._tag === "IssueTrackerError"
                    ? refused(connectionId, connection.system, error)
                    : error,
                ),
              )
            : Effect.fail(new ConnectionNotReady({ connectionId, message: "Connection does not exist" })),
        ),
        Effect.match({
          onFailure: (error) => ({ _tag: "NotReady", reason: error.message }) satisfies ConnectionReadiness,
          onSuccess: () => ({ _tag: "Ready" }) satisfies ConnectionReadiness,
        }),
      );
    });

    const requireReady = Effect.fn("ConnectionStore.requireReady")(function* (connectionId: ConnectionId) {
      const state = yield* readiness(connectionId);
      if (state._tag === "Ready") return;
      return yield* new ConnectionNotReady({ connectionId, message: state.reason });
    });

    const requireSystemReady = Effect.fn("ConnectionStore.requireSystemReady")(function* (
      system: ConnectionSystem,
    ) {
      const connection = yield* findSystem(system);
      if (connection) return yield* requireReady(connection.id);
      return yield* new ConnectionNotReady({
        connectionId: null,
        message: `${system} Connection is not established`,
      });
    });

    const establish = Effect.fn("ConnectionStore.establish")(function* (
      input: ConnectionEstablishment,
      expectedAccount?: string,
    ) {
      const expectedConnectionId = knownConnectionId(input, expectedAccount);
      const previous = expectedConnectionId ? yield* find(expectedConnectionId) : null;
      const invalidGranolaKey =
        input.system === "granola" &&
        input.source._tag === "ApiKey" &&
        !Redacted.value(input.source.key).startsWith("grn_");
      if (invalidGranolaKey) {
        return yield* new ConnectionNotReady({
          connectionId: expectedConnectionId,
          message: "Granola API keys must start with grn_",
        });
      }
      // Verification precedes both writes. The Control store writes first so its failure cannot replace a
      // working source; a source-write failure restores the prior Control record.
      const candidate = yield* credentials
        .resolveSource(credentialAccountForEstablishment(input), input.source)
        .pipe(Effect.mapError((error) => unreadable(expectedConnectionId, error)));
      const discoveredAccount = yield* establishmentVerifiers[input.system](candidate).pipe(
        Effect.mapError((error) => refused(expectedConnectionId, input.system, error)),
      );
      const account = ConnectionEstablishment.match(input, {
        github: () => discoveredAccount,
        linear: ({ account }) => account,
        granola: ({ account }) => account,
        slack: ({ account }) => account,
      });
      if (!account) {
        return yield* new ConnectionNotReady({
          connectionId: null,
          message: "GitHub did not report the authenticated account",
        });
      }
      if (expectedAccount !== undefined && !accountsMatch(input.system, account, expectedAccount)) {
        return yield* new ConnectionNotReady({
          connectionId: connectionIdOf(input.system, expectedAccount),
          message: `Connection is established for "${expectedAccount}". Switch back to that account or remove it before connecting to "${account}".`,
        });
      }
      const establishedAccount = expectedAccount ?? account;
      const id = connectionIdOf(input.system, establishedAccount);
      const connection = Connection.make({
        id,
        system: input.system,
        account: establishedAccount,
        status: "established",
      });
      const rollback = previous
        ? controlStore.establishConnection(previous)
        : controlStore.removeConnection(connection.id);
      yield* Effect.uninterruptibleMask((restore) =>
        restore(
          controlStore
            .establishConnection(connection)
            .pipe(Effect.mapError((error) => unavailable("establish Connection", id, error.message))),
        ).pipe(
          Effect.andThen(
            credentials
              .configureConnection(id, input.source)
              .pipe(Effect.onError(() => rollback.pipe(Effect.ignore))),
          ),
        ),
      );
      return connection;
    });

    const revoke = Effect.fn("ConnectionStore.revoke")(function* (connectionId: ConnectionId) {
      yield* controlStore
        .revokeConnection(connectionId)
        .pipe(Effect.mapError((error) => unavailable("revoke Connection", connectionId, error.message)));
    });

    const remove = Effect.fn("ConnectionStore.remove")(function* (connectionId: ConnectionId) {
      yield* credentials.removeConnection(connectionId);
      yield* controlStore
        .removeConnection(connectionId)
        .pipe(Effect.mapError((error) => unavailable("remove Connection", connectionId, error.message)));
    });

    const overview = Effect.fn("ConnectionStore.overview")(function* () {
      const connections = (yield* picture()).connections;
      const states = yield* Effect.forEach(connections, (connection) => readiness(connection.id));
      return connectionOverview(
        connections,
        new Map(
          connections.map((connection, index) => [
            connection.id,
            states[index] ?? { _tag: "NotReady", reason: "Connection unavailable" },
          ]),
        ),
      );
    });

    return {
      overview: overview(),
      find,
      findSystem,
      bearer,
      readiness,
      requireReady,
      requireSystemReady,
      establish,
      revoke,
      remove,
    };
  }),
);
