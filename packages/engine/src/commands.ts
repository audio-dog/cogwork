import {
  CancelRunError,
  type Connection,
  type ConnectionBindingId,
  type ConnectionId,
  type ConnectionSystem,
  ContributionSettingRefused,
  ContributionSettingScope,
  ContributionSettingUpdate,
  type ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  connectionSystemOf,
  type DaemonLimitUpdate,
  type HarnessName,
  HarnessNotRegistered,
  IssueTrackerError,
  IssueTrackerPerson,
  type OperationSettingBatch,
  type PluginFailure,
  type PluginId,
  type PluginMutationResult,
  type PluginOverview,
  Principal,
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConnectionStore } from "./connection";
import { ControlStore, type ControlStoreService } from "./control-store";
import { DaemonEventPublisher } from "./event-publisher";
import { GitHubClient } from "./github/client";
import { repoTargetFor as githubRepoTargetFor } from "./github/host";
import { Harness } from "./harness";
import { LinearClient } from "./linear/client";
import { accountTargetFor as linearAccountTargetFor } from "./linear/host";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import { workspaceInfoOf } from "./read-model";
import { WorkspaceManagement, type WorkspaceRegistrationChange } from "./registry-management";
import { WorkspaceRegistry } from "./registry-service";
import { RunControl } from "./run-control";
import { RunLedger } from "./run-ledger";
import { Scheduler } from "./scheduler";
import { WorkflowRun } from "./workflow-run";

const workspaceById = (registry: RegistryState, id: WorkspaceId) =>
  registry.workspaces.find((workspace) => workspace.config.id === id) ?? null;

const workspaceIsRegistered = (registry: RegistryState, id: WorkspaceId) =>
  workspaceById(registry, id) !== null || registry.failures.some((failure) => failure.id === id);

interface IssueTrackerReadRequest {
  readonly workspace: WorkspaceId;
  readonly connection: ConnectionBindingId;
}

const registeredWorkspace = Effect.fn("Daemon.registeredWorkspace")(function* (id: WorkspaceId) {
  const workspace = workspaceById(yield* (yield* WorkspaceRegistry).state, id);
  if (workspace) return workspace;
  return yield* new WorkspaceRegistryError({
    reason: "not-found",
    workspace: id,
    message: `Workspace ${id} is not registered`,
  });
});

const orUnavailable = <A>(target: A | null, message: string) =>
  target === null
    ? Effect.fail(new IssueTrackerError({ reason: "unavailable", message }))
    : Effect.succeed(target);

const githubRepoTarget = (workspace: RegisteredWorkspace, connection: ConnectionBindingId) =>
  orUnavailable(
    githubRepoTargetFor(workspace, connection),
    `Workspace ${workspace.config.id} has no GitHub repository`,
  );

export const getGitHubPriorityFields = Effect.fn("Daemon.GetGitHubPriorityFields")(function* (
  payload: IssueTrackerReadRequest,
) {
  const workspace = yield* registeredWorkspace(payload.workspace);
  const target = yield* githubRepoTarget(workspace, payload.connection);
  return yield* (yield* GitHubClient).listPriorityFields(target);
});

const githubPeople = Effect.fn("Daemon.githubPeople")(function* (
  workspace: RegisteredWorkspace,
  connection: ConnectionBindingId,
) {
  const target = yield* githubRepoTarget(workspace, connection);
  const logins = yield* (yield* GitHubClient).listAssignees(target);
  return logins.map((login) => ({ identity: login, label: login }));
});

const linearPeople = Effect.fn("Daemon.linearPeople")(function* (
  workspace: RegisteredWorkspace,
  connection: ConnectionBindingId,
) {
  const target = yield* orUnavailable(
    linearAccountTargetFor(workspace, connection),
    `Workspace ${workspace.config.id} has no Linear team`,
  );
  const users = yield* (yield* LinearClient).listActiveUsers(target);
  return users.map((user) => ({ identity: user.id, label: user.displayName.trim() || user.name }));
});

const issueTrackerPeople = new Map<string, typeof githubPeople | typeof linearPeople>([
  ["github", githubPeople],
  ["linear", linearPeople],
]);

const decodePerson = Schema.decodeUnknownOption(IssueTrackerPerson);

export const getIssueTrackerPeople = Effect.fn("Daemon.GetIssueTrackerPeople")(function* (
  payload: IssueTrackerReadRequest,
) {
  const workspace = yield* registeredWorkspace(payload.workspace);
  const tracker = workspace.config.issueTracker.type;
  if (connectionSystemOf(payload.connection) !== tracker) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: `Connection ${payload.connection} is not a ${tracker} Connection`,
    });
  }
  const people = yield* orUnavailable(
    issueTrackerPeople.get(tracker) ?? null,
    `Issue tracker ${tracker} has no people list`,
  );
  const listed = yield* people(workspace, payload.connection);
  return listed.flatMap((person) => Option.toArray(decodePerson(person)));
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
  const cancellation = yield* (yield* RunControl).cancel(payload.runId, { note: payload.note });
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

export const publishAfter = Effect.fn("Daemon.publishAfter")(
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
      return published.find((workspace) => workspace.id === payload.workspace) ?? state;
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

export const publishPluginMutation = Effect.fn("Daemon.publishPluginMutation")(function* (
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
