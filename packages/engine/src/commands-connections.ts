import {
  ConnectionEstablishment,
  ConnectionFailure,
  type ConnectionId,
  type ConnectionMutationResult,
  Principal,
  type PrincipalId,
  pluginRequiringConnection,
  type WorkspaceId,
} from "@cogwork/contracts";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { publishAfter, publishPluginMutation } from "./commands";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import { ControlStore } from "./control-store";
import { CredentialStore } from "./credential-store";
import { DaemonEventPublisher } from "./event-publisher";
import { GranolaLogin } from "./granola-login";
import { PluginManager } from "./plugin";
import type { RegistryState } from "./projector";
import { WorkspaceRegistry } from "./registry-service";
import { SlackLogin } from "./slack-login";

const connectionFailure = (operation: string, connectionId: ConnectionId | null, error: unknown) =>
  new ConnectionFailure({
    operation,
    connectionId,
    message: error instanceof Error ? error.message : String(error),
  });

const isConnectionFailure = Schema.is(ConnectionFailure);

const mapConnectionFailure = (operation: string, connectionId: ConnectionId | null) =>
  Effect.mapError(
    (error): ConnectionFailure =>
      isConnectionFailure(error) ? error : connectionFailure(operation, connectionId, error),
  );

const publishConnections = Effect.fn("Daemon.publishConnections")(function* (
  danglingWorkspaces: readonly WorkspaceId[],
) {
  const connections = yield* ConnectionStore;
  const publisher = yield* DaemonEventPublisher;
  const overview = yield* connections.overview;
  yield* publisher.publishConnections(overview, danglingWorkspaces);
  return { overview, danglingWorkspaces } satisfies ConnectionMutationResult;
});

const publishControlStore = Effect.fn("Daemon.publishControlStore")(function* () {
  const publisher = yield* DaemonEventPublisher;
  const store = yield* ControlStore;
  yield* store.picture.pipe(
    Effect.flatMap(publisher.publishControlStore),
    Effect.catchTag("ControlStoreFailure", (error) =>
      Effect.logWarning("Control store broadcast failed", { message: error.message }),
    ),
  );
});

const publishConnectionMutation = Effect.fn("Daemon.publishConnectionMutation")(function* (
  danglingWorkspaces: readonly WorkspaceId[],
) {
  yield* publishControlStore();
  return yield* publishConnections(danglingWorkspaces);
});

const ensureRequiredPlugin = Effect.fn("Daemon.ensureRequiredPlugin")(function* (
  system: ConnectionEstablishment["system"],
  principalId: PrincipalId,
) {
  const plugins = yield* PluginManager;
  const overview = yield* plugins.overview;
  const plugin = pluginRequiringConnection(overview, system);
  if (!plugin || plugin.record) return;
  yield* publishPluginMutation(plugins.install(plugin.pluginId, principalId));
});

export const establishConnection = Effect.fn("Daemon.EstablishConnection")(function* (payload: {
  readonly establishment: ConnectionEstablishment;
}) {
  const { establishment } = payload;
  const connections = yield* ConnectionStore;
  const principal = yield* Principal;
  const existing = yield* connections.findSystem(establishment.system);
  if (existing) {
    return yield* connectionFailure(
      "establish Connection",
      existing.id,
      "Connection already exists. Use re-connect for the same account, or remove it before connecting to a different account.",
    );
  }
  return yield* Effect.uninterruptibleMask((restore) =>
    restore(
      connections.establish(establishment).pipe(mapConnectionFailure("establish Connection", null)),
    ).pipe(
      Effect.flatMap((connection) =>
        restore(ensureRequiredPlugin(establishment.system, principal.id)).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : connections
                  .remove(connection.id)
                  .pipe(Effect.ignore, Effect.andThen(publishConnectionMutation([]).pipe(Effect.ignore))),
          ),
          Effect.andThen(
            Effect.logInfo("Connection established", {
              connectionId: connection.id,
              system: connection.system,
              account: connection.account,
            }),
          ),
          Effect.andThen(publishConnectionMutation([])),
        ),
      ),
    ),
  );
});

export const reconnectConnection = Effect.fn("Daemon.ReconnectConnection")(function* (payload: {
  readonly establishment: ConnectionEstablishment;
}) {
  const connections = yield* ConnectionStore;
  const existing = yield* connections.findSystem(payload.establishment.system);
  if (!existing) {
    return yield* connectionFailure(
      "re-connect Connection",
      null,
      "Connection does not exist; establish it first",
    );
  }
  const requestedAccount = ConnectionEstablishment.match(payload.establishment, {
    github: () => null,
    linear: ({ account }) => account,
    granola: ({ account }) => account,
    slack: ({ account }) => account,
  });
  if (requestedAccount !== null && existing.account !== requestedAccount) {
    return yield* connectionFailure(
      "re-connect Connection",
      existing.id,
      `Connection is established for "${existing.account}". Remove it before connecting to "${requestedAccount}".`,
    );
  }
  return yield* publishAfter(
    connections
      .establish(payload.establishment, existing.account)
      .pipe(mapConnectionFailure("re-connect Connection", existing.id)),
    (connection) =>
      Effect.logInfo("Connection re-connected", {
        connectionId: connection.id,
        system: connection.system,
        account: connection.account,
      }).pipe(Effect.andThen(publishConnectionMutation([]))),
  );
});

const findGranolaConnection = Effect.fn("Daemon.findGranolaConnection")(function* (
  connections: ConnectionStoreService,
  account: string,
) {
  const connection = yield* connections.findSystem("granola");
  const accountChanged = connection !== null && connection.account !== account;
  if (!accountChanged) return connection;
  return yield* connectionFailure(
    "login Granola",
    connection.id,
    `Connection is established for "${connection.account}". Remove it before connecting to "${account}".`,
  );
});

export const loginGranola = Effect.fn("Daemon.LoginGranola")(function* (payload: {
  readonly account: string;
}) {
  const connections = yield* ConnectionStore;
  const existing = yield* findGranolaConnection(connections, payload.account);
  const credential = yield* (yield* GranolaLogin).login(payload.account);
  const store = yield* CredentialStore;
  const withStoredCredential = store.withStoredCredential;
  if (!withStoredCredential) {
    return yield* connectionFailure(
      "login Granola",
      existing?.id ?? null,
      "Credential store cannot stage a browser login",
    );
  }
  const current = yield* findGranolaConnection(connections, payload.account);
  const establishment = {
    system: "granola",
    account: payload.account,
    source: { _tag: "Stored" },
  } as const;
  const connect = current ? reconnectConnection({ establishment }) : establishConnection({ establishment });
  return yield* withStoredCredential(credential, connect).pipe(
    Effect.mapError((error) =>
      error._tag === "CredentialError"
        ? new ConnectionFailure({
            operation: "login Granola",
            connectionId: current?.id ?? null,
            message: error.message,
          })
        : error,
    ),
  );
});

const findSlackConnection = Effect.fn("Daemon.findSlackConnection")(function* (
  connections: ConnectionStoreService,
  account: string,
) {
  const connection = yield* connections.findSystem("slack");
  const accountChanged = connection !== null && connection.account !== account;
  if (!accountChanged) return connection;
  return yield* connectionFailure(
    "login Slack",
    connection.id,
    `Connection is established for "${connection.account}". Remove it before connecting to "${account}".`,
  );
});

const slackLoginGate = Semaphore.makeUnsafe(1);

const loginSlackUnlocked = Effect.fn("Daemon.LoginSlack.unlocked")(function* () {
  const connections = yield* ConnectionStore;
  const credential = yield* (yield* SlackLogin).login;
  const existing = yield* findSlackConnection(connections, credential.organization);
  const store = yield* CredentialStore;
  const withStoredCredential = store.withStoredCredential;
  if (!withStoredCredential) {
    return yield* connectionFailure(
      "login Slack",
      existing?.id ?? null,
      "Credential store cannot stage a browser login",
    );
  }
  const establishment = {
    system: "slack",
    account: credential.organization,
    source: { _tag: "Stored" },
  } as const;
  const connect = existing ? reconnectConnection({ establishment }) : establishConnection({ establishment });
  return yield* withStoredCredential(credential, connect).pipe(
    Effect.mapError((error) =>
      error._tag === "CredentialError"
        ? new ConnectionFailure({
            operation: "login Slack",
            connectionId: existing?.id ?? null,
            message: error.message,
          })
        : error,
    ),
  );
});

export const loginSlack = Effect.fn("Daemon.LoginSlack")(() =>
  slackLoginGate.withPermit(loginSlackUnlocked()),
);

const boundWorkspaceId = (workspace: RegistryState["workspaces"][number], connectionId: ConnectionId) => {
  if (workspace.config.issueTracker.connectionId === connectionId) return workspace.config.id;
  if (workspace.config.sourceControl?.connectionId === connectionId) return workspace.config.id;
  return null;
};

const boundFailureId = (failure: RegistryState["failures"][number], connectionId: ConnectionId) => {
  if (failure.id === undefined) return null;
  if (failure.issueTracker?.connectionId === connectionId) return failure.id;
  return failure.sourceControl?.connectionId === connectionId ? failure.id : null;
};

const boundWorkspaceIds = (registry: RegistryState, connectionId: ConnectionId) => [
  ...new Set([
    ...registry.workspaces.flatMap((workspace) => {
      const id = boundWorkspaceId(workspace, connectionId);
      return id ? [id] : [];
    }),
    ...registry.failures.flatMap((failure) => {
      const id = boundFailureId(failure, connectionId);
      return id ? [id] : [];
    }),
  ]),
];

export const removeConnection = Effect.fn("Daemon.RemoveConnection")(function* (payload: {
  readonly connectionId: ConnectionId;
}) {
  const connections = yield* ConnectionStore;
  const plugins = yield* PluginManager;
  const connection = yield* connections.find(payload.connectionId);
  if (!connection) {
    return yield* connectionFailure("remove Connection", payload.connectionId, "Connection not found");
  }
  const before = yield* plugins.overview;
  const requiring = before.plugins.filter(
    (plugin) => plugin.record && plugin.requiredConnections.includes(connection.system),
  );
  yield* Effect.forEach(requiring, (plugin) => publishPluginMutation(plugins.uninstall(plugin.pluginId)), {
    discard: true,
  });
  const registry = yield* (yield* WorkspaceRegistry).state;
  const danglingWorkspaces = boundWorkspaceIds(registry, payload.connectionId);
  return yield* publishAfter(
    connections
      .remove(payload.connectionId)
      .pipe(mapConnectionFailure("remove Connection", payload.connectionId)),
    () => publishConnectionMutation(danglingWorkspaces),
  );
});
