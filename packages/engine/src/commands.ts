import {
  CancelRunError,
  type Connection,
  type ConnectionBindingId,
  ConnectionEstablishment,
  ConnectionFailure,
  type ConnectionId,
  type ConnectionMutationResult,
  type ConnectionSystem,
  ContributionSettingRefused,
  ContributionSettingScope,
  ContributionSettingUpdate,
  type ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  type DaemonLimitUpdate,
  type HarnessName,
  HarnessNotRegistered,
  IssueTrackerError,
  type OperationSettingBatch,
  type PluginFailure,
  type PluginId,
  type PluginMutationResult,
  type PluginOverview,
  Principal,
  type PrincipalId,
  pluginRequiringConnection,
  type RunId,
  type RunStatus,
  type WorkItemRef,
  type WorkspaceId,
  type WorkspaceRegistration,
  WorkspaceRegistrationError,
  WorkspaceRegistryError,
  type WorkspaceUpdate,
  workspaceFailureState,
  workspaceStateFromInfo,
} from "@cogwork/contracts";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import { ControlStore, type ControlStoreService } from "./control-store";
import { CredentialStore } from "./credential-store";
import { DaemonEventPublisher } from "./event-publisher";
import { GitHubClient } from "./github/client";
import { repoTargetFor as githubRepoTargetFor } from "./github/host";
import { GranolaLogin } from "./granola-login";
import { Harness } from "./harness";
import { PluginManager } from "./plugin";
import type { RegistryState } from "./projector";
import { workspaceInfoOf } from "./read-model";
import { WorkspaceManagement, type WorkspaceRegistrationChange, WorkspaceRegistry } from "./registry";
import { RunControl } from "./run-control";
import { RunLedger } from "./run-ledger";
import { Scheduler } from "./scheduler";
import { SlackLogin } from "./slack-login";
import { WorkflowRun } from "./workflow-run";

const workspaceById = (registry: RegistryState, name: WorkspaceId) =>
  registry.workspaces.find((workspace) => workspace.config.name === name) ?? null;

const workspaceIsRegistered = (registry: RegistryState, name: WorkspaceId) =>
  workspaceById(registry, name) !== null || registry.failures.some((failure) => failure.name === name);

export const getGitHubPriorityFields = Effect.fn("Daemon.GetGitHubPriorityFields")(function* (payload: {
  readonly workspace: WorkspaceId;
  readonly connection: ConnectionBindingId;
}) {
  const registry = yield* (yield* WorkspaceRegistry).state;
  const workspace = workspaceById(registry, payload.workspace);
  if (!workspace) {
    return yield* new WorkspaceRegistryError({
      reason: "not-found",
      workspace: payload.workspace,
      message: `Workspace ${payload.workspace} is not registered`,
    });
  }
  const target = githubRepoTargetFor(workspace, payload.connection);
  if (!target) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: `Workspace ${payload.workspace} has no GitHub repository`,
    });
  }
  return yield* (yield* GitHubClient).listPriorityFields(target);
});

const pluginMembership = (overview: PluginOverview) =>
  overview.plugins.map((plugin) => `${plugin.pluginId}:${plugin.record?.resolvedIdentity ?? ""}`);

const samePluginMembership = (left: PluginOverview, right: PluginOverview) => {
  const leftMembership = pluginMembership(left);
  const rightMembership = pluginMembership(right);
  return (
    leftMembership.length === rightMembership.length &&
    leftMembership.every((membership, index) => membership === rightMembership[index])
  );
};

const cancelDrainDeadline = "5 seconds";

const runNotFound = (runId: RunId) => new CancelRunError({ reason: "not-found", runId });

const runAlreadyFinished = (runId: RunId, status: RunStatus) =>
  new CancelRunError({ reason: "already-finished", runId, status });

export const cancelRun = Effect.fn("Daemon.CancelRun")(function* (payload: {
  readonly runId: RunId;
  readonly note?: string;
}) {
  const ledger = yield* RunLedger;
  const run = yield* ledger.getRun(payload.runId);
  if (run === null) return yield* runNotFound(payload.runId);
  if (run.status !== "running") return yield* runAlreadyFinished(payload.runId, run.status);
  const cancellation = yield* (yield* RunControl).cancel(payload.runId);
  const drained =
    cancellation._tag === "NotFound" ||
    Option.isSome(yield* cancellation.awaitTermination.pipe(Effect.timeoutOption(cancelDrainDeadline)));
  if (!drained) yield* Effect.logWarning("run cancellation still draining", { runId: payload.runId });
  const settled = yield* ledger.getRun(payload.runId);
  if (settled === null) return yield* runNotFound(payload.runId);
  if (settled.status !== "running") return;
  yield* ledger.updateRun(payload.runId, {
    status: "interrupted",
    usage: settled.usage,
    endedAtMillis: yield* Clock.currentTimeMillis,
  });
});

export const handBack = Effect.fn("Daemon.HandBack")(function* (payload: {
  readonly item: WorkItemRef;
  readonly note?: string;
}) {
  yield* (yield* WorkflowRun).handBack(payload);
});

export const setScheduling = Effect.fn("Daemon.SetScheduling")(function* (payload: {
  readonly desired: "running" | "paused";
}) {
  const scheduler = yield* Scheduler;
  const publisher = yield* DaemonEventPublisher;
  yield* scheduler.setScheduling(payload.desired);
  return yield* publisher.publishScheduler();
});

export const setDaemonLimit = Effect.fn("Daemon.SetDaemonLimit")(function* (payload: {
  readonly update: DaemonLimitUpdate;
}) {
  const store = yield* ControlStore;
  const scheduler = yield* Scheduler;
  const publisher = yield* DaemonEventPublisher;
  return yield* store.withWrite(
    Effect.gen(function* () {
      const controlStore = yield* store.setDaemonLimit(payload.update);
      yield* scheduler.setLimit(payload.update);
      const published = yield* publisher.publishControlStore(controlStore);
      yield* publisher.publishScheduler();
      return published;
    }),
  );
});

const publishAfter = Effect.fn("Daemon.publishAfter")(
  <A, E, R, B, E2, R2>(write: Effect.Effect<A, E, R>, publish: (written: A) => Effect.Effect<B, E2, R2>) =>
    Effect.uninterruptibleMask((restore) => restore(write).pipe(Effect.flatMap(publish))),
);

const publishControlStoreMutation = Effect.fn("Daemon.publishControlStoreMutation")(function* <E, R>(
  store: ControlStoreService,
  update: Effect.Effect<ControlStorePicture, ControlStoreFailure | E, R>,
) {
  const publisher = yield* DaemonEventPublisher;
  return yield* store.withWrite(update.pipe(Effect.tap(publisher.publishControlStore)));
});

export const setOperationSetting = Effect.fn("Daemon.SetOperationSetting")(function* (payload: {
  readonly updates: OperationSettingBatch;
}) {
  const store = yield* ControlStore;
  return yield* publishControlStoreMutation(store, store.updateOperationSettings(payload.updates));
});

export const setHarnessEnabled = Effect.fn("Daemon.SetHarnessEnabled")(function* (payload: {
  readonly harness: HarnessName;
  readonly enabled: boolean;
}) {
  const harness = yield* Harness;
  if (!harness.catalogs.has(payload.harness)) {
    return yield* HarnessNotRegistered.make({ harness: payload.harness });
  }
  const store = yield* ControlStore;
  return yield* publishControlStoreMutation(store, store.setHarnessEnabled(payload.harness, payload.enabled));
});

const workspaceStateFromChange = (change: WorkspaceRegistrationChange) => {
  if (change._tag === "Failed") return workspaceFailureState(change.failure);
  return workspaceStateFromInfo(workspaceInfoOf(change.workspace, undefined));
};

const connectionBindingFailure = (
  connection: Connection | null,
  connectionId: ConnectionId,
  system: ConnectionSystem,
) => {
  if (!connection) return `${connectionId} is not an established Connection`;
  if (connection.system !== system) {
    return `${connectionId} is a ${connection.system} Connection, not ${system}`;
  }
  return `${connectionId} is not an established Connection`;
};

const requireBinding = Effect.fn("Daemon.requireConnectionBinding")(function* (
  connectionId: ConnectionId,
  system: ConnectionSystem,
) {
  const connections = yield* ConnectionStore;
  const connection = yield* connections
    .find(connectionId)
    .pipe(Effect.mapError((error) => new WorkspaceRegistrationError({ message: error.message })));
  if (connection?.system === system && connection.status === "established") return;
  return yield* new WorkspaceRegistrationError({
    message: connectionBindingFailure(connection, connectionId, system),
  });
});

const connectionSystemFor = Effect.fn("Daemon.connectionSystemFor")(function* (type: string) {
  if (type === "github" || type === "linear") return type;
  return yield* new WorkspaceRegistrationError({ message: `${type} has no Connection system` });
});

// An unbound registration and a bad binding fail for different reasons, and only one of them is
// about the Connection: "unbound" means the registration never named one, so pointing the reader at
// their Connections sends them to look at something that is very likely already fine.
const requireConfiguredBinding = Effect.fn("Daemon.requireConfiguredConnectionBinding")(function* (
  connectionId: WorkspaceRegistration["issueTracker"]["connectionId"],
  system: ConnectionSystem,
  field: string,
) {
  if (connectionId === "unbound") {
    return yield* new WorkspaceRegistrationError({
      message: `${field} names no Connection: set "${field}.connectionId" to an established ${system} Connection id, such as "${system}/<account>"`,
    });
  }
  return yield* requireBinding(connectionId, system);
});

const contributionSettingRefusal = (update: ContributionSettingUpdate, registry: RegistryState) => {
  const cell = ContributionSettingUpdate.match(update, {
    Set: ({ row }) => row,
    Clear: ({ cell }) => cell,
  });
  const overlayWorkspace = ContributionSettingScope.match(cell.scope, {
    SettingsProfile: () => null,
    PrivateWorkspaceOverlay: ({ workspace }) => workspace,
  });
  if (overlayWorkspace && !workspaceIsRegistered(registry, overlayWorkspace)) {
    return ContributionSettingRefused.make({
      contribution: cell.contribution.id,
      source: "Workspace registry",
      reason: `Workspace ${overlayWorkspace} is not registered`,
    });
  }
  return null;
};

export const setContributionSetting = Effect.fn("Daemon.SetContributionSetting")(function* (payload: {
  readonly update: ContributionSettingUpdate;
}) {
  const registry = yield* (yield* WorkspaceRegistry).state;
  const refusal = contributionSettingRefusal(payload.update, registry);
  if (refusal) return yield* refusal;
  const store = yield* ControlStore;
  return yield* publishControlStoreMutation(store, store.updateContributionSetting(payload.update));
});

export const registerWorkspace = Effect.fn("Daemon.RegisterWorkspace")(function* (payload: {
  readonly registration: WorkspaceRegistration;
}) {
  const { issueTracker, sourceControl } = payload.registration;
  yield* requireConfiguredBinding(
    issueTracker.connectionId,
    yield* connectionSystemFor(issueTracker.type),
    "issueTracker",
  );
  if (sourceControl) {
    yield* requireConfiguredBinding(sourceControl.connectionId, "github", "sourceControl");
  }
  const management = yield* WorkspaceManagement;
  const publisher = yield* DaemonEventPublisher;
  return yield* publishAfter(management.register(payload.registration), (change) =>
    publisher.publishWorkspaces().pipe(Effect.map(() => workspaceStateFromChange(change))),
  );
});

export const deregisterWorkspace = Effect.fn("Daemon.DeregisterWorkspace")(function* (payload: {
  readonly workspace: WorkspaceId;
}) {
  const management = yield* WorkspaceManagement;
  const publisher = yield* DaemonEventPublisher;
  const store = yield* ControlStore;
  return yield* publishAfter(management.deregister(payload.workspace), (workspace) =>
    Effect.gen(function* () {
      yield* publisher.publishWorkspaceRemoved(workspace);
      const controlStore = yield* store.picture.pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceRegistryError({
              reason: "management-failed",
              workspace,
              operation: "deregister workspace",
              message: error.message,
            }),
        ),
      );
      yield* publisher.publishControlStore(controlStore);
      return workspace;
    }),
  );
});

export const updateWorkspace = Effect.fn("Daemon.UpdateWorkspace")(function* (payload: {
  readonly workspace: WorkspaceId;
  readonly update: WorkspaceUpdate;
}) {
  const { issueTracker, sourceControl } = payload.update;
  yield* requireConfiguredBinding(
    issueTracker.connectionId,
    yield* connectionSystemFor(issueTracker.type),
    "issueTracker",
  );
  if (sourceControl) {
    yield* requireConfiguredBinding(sourceControl.connectionId, "github", "sourceControl");
  }
  const management = yield* WorkspaceManagement;
  const publisher = yield* DaemonEventPublisher;
  return yield* publishAfter(management.update(payload.workspace, payload.update), (change) =>
    Effect.gen(function* () {
      const state = workspaceStateFromChange(change);
      const published = yield* publisher.publishWorkspaces();
      yield* publisher.publishScheduler();
      return published.find((workspace) => workspace.name === payload.workspace) ?? state;
    }),
  ).pipe(Effect.uninterruptible);
});

export const rebindWorkspace = Effect.fn("Daemon.RebindWorkspace")(function* (payload: {
  readonly workspace: WorkspaceId;
  readonly checkoutPath: string;
}) {
  const management = yield* WorkspaceManagement;
  const publisher = yield* DaemonEventPublisher;
  const change = yield* management.rebind(payload.workspace, payload.checkoutPath);
  const state = workspaceStateFromChange(change);
  yield* publisher.publishWorkspaces();
  return state;
});

const publishPluginMutation = Effect.fn("Daemon.publishPluginMutation")(function* (
  mutation: Effect.Effect<PluginMutationResult, PluginFailure>,
) {
  const publisher = yield* DaemonEventPublisher;
  const plugins = yield* PluginManager;
  const store = yield* ControlStore;
  return yield* publishAfter(mutation, (completed) =>
    Effect.gen(function* () {
      const result = yield* store.withWrite(
        plugins.overview.pipe(
          Effect.map((overview) => ({
            overview,
            notices: samePluginMembership(completed.overview, overview) ? completed.notices : [],
          })),
        ),
      );
      yield* publisher.publishPlugins(result.overview, result.notices);
      yield* store.picture.pipe(Effect.flatMap(publisher.publishControlStore), Effect.ignore);
      yield* publisher.publishWorkspaces();
      return result;
    }),
  );
});

export const installPlugin = Effect.fn("Daemon.InstallPlugin")(function* (payload: {
  readonly pluginId: PluginId;
}) {
  const plugins = yield* PluginManager;
  const principal = yield* Principal;
  return yield* publishPluginMutation(plugins.install(payload.pluginId, principal.id));
});

export const uninstallPlugin = Effect.fn("Daemon.UninstallPlugin")(function* (payload: {
  readonly pluginId: PluginId;
}) {
  const plugins = yield* PluginManager;
  return yield* publishPluginMutation(plugins.uninstall(payload.pluginId));
});

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

const boundWorkspaceName = (workspace: RegistryState["workspaces"][number], connectionId: ConnectionId) => {
  if (workspace.config.issueTracker.connectionId === connectionId) return workspace.config.name;
  if (workspace.config.sourceControl?.connectionId === connectionId) return workspace.config.name;
  return null;
};

const boundFailureName = (failure: RegistryState["failures"][number], connectionId: ConnectionId) => {
  if (failure.name === undefined) return null;
  if (failure.issueTracker?.connectionId === connectionId) return failure.name;
  return failure.sourceControl?.connectionId === connectionId ? failure.name : null;
};

const boundWorkspaceIds = (registry: RegistryState, connectionId: ConnectionId) => [
  ...new Set([
    ...registry.workspaces.flatMap((workspace) => {
      const name = boundWorkspaceName(workspace, connectionId);
      return name ? [name] : [];
    }),
    ...registry.failures.flatMap((failure) => {
      const name = boundFailureName(failure, connectionId);
      return name ? [name] : [];
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
