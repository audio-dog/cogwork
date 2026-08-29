import {
  type ClassifiedItem,
  type Connection,
  type ConnectionEstablishment,
  ConnectionFailure,
  type ConnectionId,
  type ConnectionMutationResult,
  type ConnectionSystem,
  type DaemonLimitUpdate,
  type OperationSettingUpdate,
  type PluginFailure,
  type PluginId,
  type PluginMutationResult,
  type PluginOverview,
  Principal,
  type PrincipalId,
  RunAlreadyFinished,
  type RunId,
  RunNotFound,
  type TriageRole,
  type WorkItemId,
  WorkItemNotFound,
  type WorkspaceId,
  WorkspaceManagementError,
  type WorkspaceRegistration,
  WorkspaceRegistrationError,
  workspaceFailureState,
  workspaceStateFromInfo,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ConnectionStore, requiringPluginId } from "./connection";
import { ControlStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import { DaemonEventPublisher } from "./event-publisher";
import { IssueTracker, type ObservedItem } from "./issue-tracker";
import { operationSettingRefusal } from "./operation-policy";
import { PluginManager } from "./plugin";
import type { RegistryState } from "./projector";
import { classifiedItemWithPr, workspaceInfoOf } from "./read-model";
import { type ReconcileSnapshot, ReconcileWorker } from "./reconcile";
import {
  findWorkspaceIssueTrackerBinding,
  WorkspaceManagement,
  type WorkspaceRegistrationChange,
  WorkspaceRegistry,
} from "./registry";
import { RunControl } from "./run-control";
import { RunLedger } from "./run-ledger";
import { Scheduler } from "./scheduler";

const workspaceById = (registry: RegistryState, name: WorkspaceId) =>
  registry.workspaces.find((workspace) => workspace.config.name === name) ?? null;

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

const observedFor = (snapshot: ReconcileSnapshot, workspace: WorkspaceId, workItem: WorkItemId) =>
  snapshot.workspaces
    .find((state) => state.name === workspace)
    ?.observed.find((item) => item.id === workItem) ?? null;

const parkedNeedsHuman = (id: WorkItemId, title: string): ClassifiedItem => ({
  _tag: "NeedsHuman",
  id,
  title,
  reason: "ready-for-human",
  proposal: null,
  url: null,
});

const parkedItem = (observed: ObservedItem | null) => {
  if (observed === null) return null;
  const roles = [...observed.roles.filter((role) => role !== "ready-for-human"), "ready-for-human" as const];
  return classifiedItemWithPr({
    ...observed,
    roles,
    claim: null,
    claimLabeled: false,
    claimedByUs: false,
  });
};

export const cancelRun = Effect.fn("Daemon.CancelRun")(function* (payload: {
  readonly runId: RunId;
  readonly note?: string;
}) {
  const ledger = yield* RunLedger;
  const run = yield* ledger.getRun(payload.runId);
  if (run === null) return yield* new RunNotFound({ runId: payload.runId });
  if (run.status !== "running") {
    return yield* new RunAlreadyFinished({ runId: payload.runId, status: run.status });
  }

  const runControl = yield* RunControl;
  const controlledWorkspace = yield* runControl.workspaceFor(payload.runId);
  yield* runControl.cancel(payload.runId);

  const endedAtMillis = yield* Clock.currentTimeMillis;
  const settled = yield* ledger.getRun(payload.runId);
  if (settled?.status === "running") {
    yield* ledger.updateRun(payload.runId, {
      status: "interrupted",
      usage: run.usage,
      endedAtMillis,
    });
  }

  const registry = yield* WorkspaceRegistry;
  const currentWorkspace = findWorkspaceIssueTrackerBinding(registry, run.workspace);
  const workspace = Option.getOrUndefined(controlledWorkspace) ?? currentWorkspace;
  if (workspace !== undefined) {
    const issueTracker = yield* IssueTracker;
    yield* issueTracker
      .handOff(workspace, run.workItem, { stage: run.stage, note: payload.note })
      .pipe(Effect.andThen(issueTracker.release(workspace, run.workItem)), Effect.orDie);
  }

  const snapshot = yield* (yield* ReconcileWorker).snapshot;
  const observed = observedFor(snapshot, run.workspace, run.workItem);
  const item = parkedItem(observed) ?? parkedNeedsHuman(run.workItem, run.workItem);
  if (currentWorkspace === undefined) return item;
  const bus = yield* DaemonEventBus;
  yield* bus.publish({ _tag: "ItemChanged", workspace: run.workspace, item });
  return item;
});

export const reclassify = Effect.fn("Daemon.Reclassify")(function* (payload: {
  readonly workspace: WorkspaceId;
  readonly workItem: WorkItemId;
  readonly role: TriageRole;
  readonly note?: string;
}) {
  const registry = yield* WorkspaceRegistry;
  const workspace = workspaceById(registry, payload.workspace);
  if (workspace === null) {
    return yield* new WorkItemNotFound({ workspace: payload.workspace, workItem: payload.workItem });
  }

  const snapshot = yield* (yield* ReconcileWorker).snapshot;
  const observed = observedFor(snapshot, payload.workspace, payload.workItem);
  if (observed === null) {
    return yield* new WorkItemNotFound({ workspace: payload.workspace, workItem: payload.workItem });
  }

  const issueTracker = yield* IssueTracker;
  const remove = observed.roles.filter((role) => role !== payload.role);
  const add = observed.roles.includes(payload.role) ? [] : [payload.role];
  yield* issueTracker.reclassify(workspace, payload.workItem, {
    changes: { remove, add },
    note: payload.note,
  });

  const item = classifiedItemWithPr({ ...observed, roles: [payload.role] });
  if (item !== null) {
    const bus = yield* DaemonEventBus;
    yield* bus.publish({ _tag: "ItemChanged", workspace: payload.workspace, item });
  }
  return item;
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

export const setOperationSetting = Effect.fn("Daemon.SetOperationSetting")(function* (payload: {
  readonly update: OperationSettingUpdate;
}) {
  const refusal = operationSettingRefusal(payload.update);
  if (refusal !== null) return yield* refusal;
  const store = yield* ControlStore;
  const publisher = yield* DaemonEventPublisher;
  return yield* store.withWrite(
    Effect.flatMap(store.updateOperationSetting(payload.update), (controlStore) =>
      publisher.publishControlStore(controlStore),
    ),
  );
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

const requireConfiguredBinding = Effect.fn("Daemon.requireConfiguredConnectionBinding")(function* (
  connectionId: WorkspaceRegistration["issueTracker"]["connectionId"],
  system: ConnectionSystem,
) {
  if (connectionId === "unbound") {
    return yield* new WorkspaceRegistrationError({ message: `${system} needs an established Connection` });
  }
  return yield* requireBinding(connectionId, system);
});

export const registerWorkspace = Effect.fn("Daemon.RegisterWorkspace")(function* (payload: {
  readonly registration: WorkspaceRegistration;
}) {
  const { issueTracker, sourceControl } = payload.registration;
  yield* requireConfiguredBinding(issueTracker.connectionId, yield* connectionSystemFor(issueTracker.type));
  if (sourceControl) yield* requireConfiguredBinding(sourceControl.connectionId, "github");
  const management = yield* WorkspaceManagement;
  const publisher = yield* DaemonEventPublisher;
  const change = yield* management.register(payload.registration);
  const state = workspaceStateFromChange(change);
  yield* publisher.publishWorkspaces();
  return state;
});

export const deregisterWorkspace = Effect.fn("Daemon.DeregisterWorkspace")(function* (payload: {
  readonly workspace: WorkspaceId;
}) {
  const management = yield* WorkspaceManagement;
  const publisher = yield* DaemonEventPublisher;
  const store = yield* ControlStore;
  const workspace = yield* management.deregister(payload.workspace);
  yield* publisher.publishWorkspaceRemoved(workspace);
  const controlStore = yield* store.picture.pipe(
    Effect.mapError(
      (error) => new WorkspaceManagementError({ operation: "deregister workspace", message: error.message }),
    ),
  );
  yield* publisher.publishControlStore(controlStore);
  return workspace;
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
  const completed = yield* mutation;
  return yield* store.withWrite(
    Effect.gen(function* () {
      const overview = yield* plugins.overview;
      const notices = samePluginMembership(completed.overview, overview) ? completed.notices : [];
      yield* publisher.publishPlugins(overview, notices);
      yield* store.picture.pipe(Effect.flatMap(publisher.publishControlStore), Effect.ignore);
      return { overview, notices };
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
  const plugins = yield* PluginManager;
  const publisher = yield* DaemonEventPublisher;
  const pluginOverview = yield* plugins.overview;
  const overview = yield* connections.overview(pluginOverview);
  yield* publisher.publishConnections(overview, danglingWorkspaces);
  return { overview, danglingWorkspaces } satisfies ConnectionMutationResult;
});

const publishControlStore = Effect.fn("Daemon.publishControlStore")(function* () {
  const publisher = yield* DaemonEventPublisher;
  const store = yield* ControlStore;
  yield* store.picture.pipe(Effect.flatMap(publisher.publishControlStore), Effect.ignore);
});

const ensureRequiredPlugin = Effect.fn("Daemon.ensureRequiredPlugin")(function* (
  system: ConnectionEstablishment["system"],
  principalId: PrincipalId,
  rollback: Effect.Effect<void, never>,
) {
  const plugins = yield* PluginManager;
  const overview = yield* plugins.overview;
  const pluginId = requiringPluginId(overview, system);
  if (!pluginId) return;
  const plugin = overview.plugins.find((item) => item.pluginId === pluginId);
  if (plugin?.record) return;
  yield* publishPluginMutation(plugins.install(pluginId, principalId)).pipe(Effect.tapError(() => rollback));
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
  const connection = yield* connections
    .establish(establishment)
    .pipe(mapConnectionFailure("establish Connection", null));
  yield* ensureRequiredPlugin(
    establishment.system,
    principal.id,
    connections.remove(connection.id).pipe(Effect.ignore),
  );
  yield* publishControlStore();
  yield* Effect.logInfo("Connection established", {
    connectionId: connection.id,
    system: connection.system,
    account: connection.account,
  });
  return yield* publishConnections([]);
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
  if (existing.account !== payload.establishment.account) {
    return yield* connectionFailure(
      "re-connect Connection",
      existing.id,
      `Connection is established for "${existing.account}". Remove it before connecting to "${payload.establishment.account}".`,
    );
  }
  const connection = yield* connections
    .establish(payload.establishment)
    .pipe(mapConnectionFailure("re-connect Connection", existing.id));
  yield* publishControlStore();
  yield* Effect.logInfo("Connection re-connected", {
    connectionId: connection.id,
    system: connection.system,
    account: connection.account,
  });
  return yield* publishConnections([]);
});

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
  const registry = yield* WorkspaceRegistry;
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
  const danglingWorkspaces = boundWorkspaceIds(registry, payload.connectionId);
  yield* connections
    .remove(payload.connectionId)
    .pipe(mapConnectionFailure("remove Connection", payload.connectionId));
  yield* publishControlStore();
  return yield* publishConnections(danglingWorkspaces);
});
