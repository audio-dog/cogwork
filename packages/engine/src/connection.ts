import {
  Connection,
  type ConnectionEstablishment,
  ConnectionFailure,
  type ConnectionId,
  ConnectionNotReady,
  type ConnectionOverview,
  type ConnectionReadiness,
  type ConnectionSystem,
  connectionIdOf,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ConnectionVerifier } from "./connection-verify";
import { ControlStore } from "./control-store";
import {
  type Credential,
  type CredentialAccount,
  type CredentialError,
  CredentialStore,
} from "./credential-store";

const knownSystems: ReadonlyArray<ConnectionSystem> = ["github", "linear"];

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
  tokenEnv: connection.system === "github" ? "GITHUB_TOKEN" : "LINEAR_API_KEY",
  clientCredentials: null,
  oauthClientId: null,
});

const unavailable = (operation: string, connectionId: ConnectionId | null, message: string) =>
  new ConnectionFailure({ operation, connectionId, message });

const unreadable = (connectionId: ConnectionId, error: { readonly message: string }) =>
  new ConnectionNotReady({
    connectionId,
    message: `Cogwork could not read the credential: ${error.message}`,
  });

const refused = (connectionId: ConnectionId, system: ConnectionSystem, error: { readonly message: string }) =>
  new ConnectionNotReady({
    connectionId,
    message: `${system === "github" ? "GitHub" : "Linear"} rejected the credential: ${error.message}`,
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
      unavailable(
        "establish Connection",
        connectionIdOf(input.system, input.account),
        "Connection store unavailable",
      ),
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

    const readiness = Effect.fn("ConnectionStore.readiness")(function* (connectionId: ConnectionId) {
      return yield* bearer(connectionId).pipe(
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

    const establish = Effect.fn("ConnectionStore.establish")(function* (input: ConnectionEstablishment) {
      const id = connectionIdOf(input.system, input.account);
      const connection = Connection.make({
        id,
        system: input.system,
        account: input.account,
        status: "established",
      });
      // Resolve and check the proposed credential *before* configuring it. Persisting first and
      // checking after would leave a rejected credential on disk, and on a re-connect it would have
      // already overwritten the working one it was meant to replace.
      const candidate = yield* credentials
        .resolveSource(credentialAccountFor(connection), input.source)
        .pipe(Effect.mapError((error) => unreadable(id, error)));
      yield* verifier
        .verify(input.system, candidate)
        .pipe(Effect.mapError((error) => refused(id, input.system, error)));
      yield* credentials.configureConnection(id, input.source);
      yield* controlStore
        .establishConnection(connection)
        .pipe(Effect.mapError((error) => unavailable("establish Connection", id, error.message)));
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
