import {
  applyOperationSettingBatch,
  CancelRunError,
  CancelRunResult,
  type ClassifiedItem,
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
  HarnessName,
  HarnessNotRegistered,
  IssueTrackerError,
  LifecycleStage,
  ModelOptionSelections,
  type OperationSettingBatch,
  type OperationSettingCell,
  type OperationSettingName,
  OperationSettingRefused,
  OperationSettingScope,
  OperationSettingUpdate,
  type PluginFailure,
  type PluginId,
  type PluginMutationResult,
  type PluginOverview,
  Principal,
  type PrincipalId,
  pluginRequiringConnection,
  type RunId,
  type RunStatus,
  resolveOperationSetting,
  SettingLevel,
  type TriageRole,
  type WorkItemId,
  WorkItemNotFound,
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
import { ConnectionStore } from "./connection";
import { ControlStore, type ControlStoreService } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import { DaemonEventPublisher } from "./event-publisher";
import { GitHubClient } from "./github/client";
import { repoTargetFor as githubRepoTargetFor } from "./github/host";
import { Harness, type HarnessService } from "./harness";
import { IssueTracker, type ObservedItem, releaseClaim } from "./issue-tracker";
import { applyHandbackBarrier } from "./observe";
import {
  catalogMembershipRefusal,
  modelOptionsMembershipRefusal,
  operationSettingRefusal,
} from "./operation-policy";
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

const observedFor = (snapshot: ReconcileSnapshot, workspace: WorkspaceId, workItem: WorkItemId) =>
  snapshot.workspaces
    .find((state) => state.name === workspace)
    ?.observed.find((item) => item.id === workItem) ?? null;

const roleChanges = (roles: ReadonlyArray<TriageRole>, role: TriageRole) => ({
  remove: roles.filter((current) => current !== role),
  add: roles.includes(role) ? [] : [role],
});

const resolveObserved = Effect.fn("Daemon.resolveObserved")(function* (
  workspaceId: WorkspaceId,
  workItem: WorkItemId,
) {
  const registry = yield* (yield* WorkspaceRegistry).state;
  const workspace = workspaceById(registry, workspaceId);
  if (workspace === null) return yield* new WorkItemNotFound({ workspace: workspaceId, workItem });
  const snapshot = yield* (yield* ReconcileWorker).snapshot;
  const observed = observedFor(snapshot, workspaceId, workItem);
  if (observed === null) return yield* new WorkItemNotFound({ workspace: workspaceId, workItem });
  return { workspace, observed };
});

const publishChangedItem = Effect.fn("Daemon.publishChangedItem")(function* (
  workspace: WorkspaceId,
  item: ClassifiedItem | null,
) {
  if (item === null) return;
  const bus = yield* DaemonEventBus;
  yield* bus.publish({ _tag: "ItemChanged", workspace, item });
});

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
  if (run.status !== "running") {
    return yield* runAlreadyFinished(payload.runId, run.status);
  }

  const runControl = yield* RunControl;
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const cancellation = yield* runControl.cancel(payload.runId);
      const controlledWorkspace =
        cancellation._tag === "Interrupting" ? cancellation.workspace : Option.none();
      const drained =
        cancellation._tag === "NotFound"
          ? true
          : yield* cancellation.awaitTermination.pipe(
              Effect.timeoutOption(cancelDrainDeadline),
              Effect.map(Option.isSome),
            );

      const snapshot = yield* (yield* ReconcileWorker).snapshot;
      const observed = observedFor(snapshot, run.workspace, run.workItem);
      if (!drained) yield* Effect.logWarning("run cancellation still draining", { runId: payload.runId });

      const registry = yield* (yield* WorkspaceRegistry).state;
      const currentWorkspace = findWorkspaceIssueTrackerBinding(registry, run.workspace);
      const workspace = Option.getOrUndefined(controlledWorkspace) ?? currentWorkspace;
      const trackerClaim = workspace === undefined ? null : { workspace, issueTracker: yield* IssueTracker };
      const releaseRunClaim =
        trackerClaim === null
          ? Effect.void
          : releaseClaim(trackerClaim.issueTracker)(trackerClaim.workspace, run.workItem);
      const releaseAbandonedClaim = cancellation._tag === "NotFound" ? releaseRunClaim : Effect.void;

      const endedAtMillis = yield* Clock.currentTimeMillis;
      const settled = yield* ledger.getRun(payload.runId);
      if (settled === null) return yield* runNotFound(payload.runId);
      if (settled.status !== "running") {
        yield* releaseAbandonedClaim;
        return yield* runAlreadyFinished(payload.runId, settled.status);
      }
      yield* ledger.updateRun(payload.runId, {
        status: "interrupted",
        usage: run.usage,
        endedAtMillis,
      });

      if (trackerClaim !== null) {
        yield* trackerClaim.issueTracker
          .handOff(trackerClaim.workspace, run.workItem, { stage: run.stage, note: payload.note })
          .pipe(
            Effect.catchTag("IssueTrackerError", (error) =>
              Effect.logWarning("run hand-off failed", { message: error.message }),
            ),
          );
      }
      yield* releaseAbandonedClaim;

      const item = parkedItem(observed) ?? parkedNeedsHuman(run.workItem, run.workItem);
      if (currentWorkspace !== undefined) {
        const bus = yield* DaemonEventBus;
        yield* bus.publish({ _tag: "ItemChanged", workspace: run.workspace, item });
      }
      return drained
        ? CancelRunResult.cases.Cancelled.make({ item })
        : CancelRunResult.cases.StillDraining.make({ item });
    }),
  );
});

export const reclassify = Effect.fn("Daemon.Reclassify")(function* (payload: {
  readonly workspace: WorkspaceId;
  readonly workItem: WorkItemId;
  readonly role: TriageRole;
  readonly note?: string;
}) {
  const { workspace, observed } = yield* resolveObserved(payload.workspace, payload.workItem);

  const issueTracker = yield* IssueTracker;
  yield* issueTracker.reclassify(workspace, payload.workItem, {
    changes: roleChanges(observed.roles, payload.role),
    note: payload.note,
  });

  const item = classifiedItemWithPr({ ...observed, roles: [payload.role] });
  yield* publishChangedItem(payload.workspace, item);
  return item;
});

export const handBack = Effect.fn("Daemon.HandBack")(function* (payload: {
  readonly workspace: WorkspaceId;
  readonly workItem: WorkItemId;
  readonly role: TriageRole;
  readonly note?: string;
}) {
  const { workspace, observed } = yield* resolveObserved(payload.workspace, payload.workItem);
  const principal = yield* Principal;
  const record = { by: principal.id, atMillis: yield* Clock.currentTimeMillis };
  const issueTracker = yield* IssueTracker;
  yield* issueTracker.handBack(workspace, payload.workItem, {
    record,
    changes: roleChanges(observed.roles, payload.role),
    note: payload.note,
  });

  const item = classifiedItemWithPr(
    applyHandbackBarrier({ ...observed, roles: [payload.role], handback: record }),
  );
  yield* publishChangedItem(payload.workspace, item);
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

const publishSnapshotMutation = Effect.fn("Daemon.publishSnapshotMutation")(function* <E, R>(
  store: ControlStoreService,
  update: Effect.Effect<ControlStorePicture, ControlStoreFailure | E, R>,
) {
  const publisher = yield* DaemonEventPublisher;
  const worker = yield* ReconcileWorker;
  const published = yield* store.withWrite(
    update.pipe(
      Effect.tap(() => worker.invalidateAvailability()),
      Effect.flatMap(publisher.publishControlStore),
    ),
  );
  yield* publisher.requestSnapshotRefresh();
  return published;
});

type CatalogSettingName = Extract<OperationSettingName, "model" | "model-options" | "permission-profile">;

const catalogSettingNames = [
  "model",
  "model-options",
  "permission-profile",
] satisfies ReadonlyArray<CatalogSettingName>;

const isCatalogSettingName = (setting: OperationSettingName): setting is CatalogSettingName =>
  catalogSettingNames.some((candidate) => candidate === setting);

interface OperationSelectionChange {
  readonly workflow: string;
  readonly operation: LifecycleStage;
  readonly workspace: WorkspaceId | null;
  readonly setting: "harness" | CatalogSettingName;
  readonly requestedSet: boolean;
}

const selectionChangesForUpdate = (update: OperationSettingUpdate) => {
  const candidate = OperationSettingUpdate.match(update, {
    Clear: ({ cell }) => ({ cell, requestedSet: false }),
    Set: ({ row }) => ({ cell: row, requestedSet: true }),
  });
  const { cell, requestedSet } = candidate;
  const setting = cell.setting;
  const selectionSetting = setting === "harness" || isCatalogSettingName(setting);
  if (!selectionSetting) return [];
  const workspace = OperationSettingScope.match(cell.scope, {
    SettingsProfile: () => null,
    RuntimeHost: () => null,
    PrivateWorkspaceOverlay: ({ workspace }) => workspace,
  });
  const contexts = SettingLevel.match(cell.level, {
    Default: () => LifecycleStage.literals.map((operation) => ({ workflow: "coding", operation })),
    Workflow: ({ workflow }) => LifecycleStage.literals.map((operation) => ({ workflow, operation })),
    Operation: ({ workflow, operation }) => [{ workflow, operation }],
  });
  return contexts.map(
    (context) => ({ ...context, workspace, setting, requestedSet }) satisfies OperationSelectionChange,
  );
};

const operationSettingPositionKey = (cell: OperationSettingCell) => JSON.stringify([cell.level, cell.scope]);

const operationSettingCellOf = (update: OperationSettingUpdate) =>
  OperationSettingUpdate.match(update, {
    Clear: ({ cell }) => cell,
    Set: ({ row }) => row,
  });

const selectionAtPosition = (rows: ControlStorePicture["operationSettings"], cell: OperationSettingCell) => {
  const position = operationSettingPositionKey(cell);
  const selectionMatchesPosition = (row: ControlStorePicture["operationSettings"][number]) => {
    const matches = row.setting === cell.setting && operationSettingPositionKey(row) === position;
    return matches;
  };
  return rows.find(selectionMatchesPosition)?.value ?? null;
};

const modelOptionResetScopes = (
  rows: ControlStorePicture["operationSettings"],
  scope: OperationSettingCell["scope"],
) => {
  const privateScopes = rows
    .filter(({ setting }) => setting === "model-options")
    .flatMap((row) =>
      OperationSettingScope.match(row.scope, {
        SettingsProfile: () => [],
        RuntimeHost: () => [],
        PrivateWorkspaceOverlay: (privateScope) => [privateScope],
      }),
    )
    .filter(
      (privateScope, index, scopes) =>
        scopes.findIndex(({ workspace }) => workspace === privateScope.workspace) === index,
    );
  return OperationSettingScope.match(scope, {
    SettingsProfile: (profileScope) => [profileScope],
    RuntimeHost: () => [
      { _tag: "SettingsProfile" } satisfies OperationSettingCell["scope"],
      ...privateScopes,
    ],
    PrivateWorkspaceOverlay: (privateScope) => [privateScope],
  });
};

const withModelContextOptionResets = (
  rows: ControlStorePicture["operationSettings"],
  updates: OperationSettingBatch,
) => {
  const explicitModelOptionCells = new Set(
    updates
      .map(operationSettingCellOf)
      .filter(({ setting }) => setting === "model-options")
      .map(operationSettingPositionKey),
  );
  const updatedRows = applyOperationSettingBatch(rows, updates);
  return updates.flatMap((update) => {
    const cell = operationSettingCellOf(update);
    const changesModelContext = cell.setting === "harness" || cell.setting === "model";
    if (!changesModelContext) return [update];
    const keepsOptions = selectionAtPosition(rows, cell) === selectionAtPosition(updatedRows, cell);
    if (keepsOptions) return [update];
    const resetCells = modelOptionResetScopes(rows, cell.scope)
      .map(
        (scope) =>
          ({
            level: cell.level,
            setting: "model-options",
            scope,
          }) satisfies OperationSettingCell,
      )
      .filter((optionCell) => !explicitModelOptionCells.has(operationSettingPositionKey(optionCell)));
    const resets = resetCells.map((optionCell) =>
      OperationSettingUpdate.match(update, {
        Clear: () =>
          ({
            _tag: "Clear",
            cell: optionCell,
          }) satisfies OperationSettingUpdate,
        Set: () =>
          ({
            _tag: "Set",
            row: { ...optionCell, value: {} },
          }) satisfies OperationSettingUpdate,
      }),
    );
    return [update, ...resets];
  });
};

const isModelOptionSelections = Schema.is(ModelOptionSelections);

const validateSelectionContext = Effect.fn("Daemon.validateSelectionContext")(function* (
  harness: HarnessService,
  rows: ControlStorePicture["operationSettings"],
  change: OperationSelectionChange,
) {
  if (!change.requestedSet) return;
  const effectiveValue = resolveOperationSetting(rows, change.setting, change);
  const selectedHarness =
    change.setting === "harness" ? effectiveValue : resolveOperationSetting(rows, "harness", change);
  if (selectedHarness === null) {
    return yield* OperationSettingRefused.make({
      setting: change.setting,
      source: "Harness selection",
      reason: "No Harness is selected for this setting",
    });
  }
  const registeredHarness = Schema.is(HarnessName)(selectedHarness)
    ? { name: selectedHarness, catalog: harness.catalogs.get(selectedHarness) }
    : null;
  if (!registeredHarness?.catalog) {
    return yield* OperationSettingRefused.make({
      setting: "harness",
      source: "Harness registry",
      reason: `Unknown Harness ${selectedHarness}`,
    });
  }
  const { name, catalog } = registeredHarness;
  if (change.setting === "harness") return;
  const selectedValue = effectiveValue;
  const effectiveModel = resolveOperationSetting(rows, "model", change);
  const selectedModel = typeof effectiveModel === "string" ? effectiveModel : null;
  const hasModelOptionsSelection =
    change.setting === "model-options" && isModelOptionSelections(selectedValue);
  const modelOptionsRefusal = hasModelOptionsSelection
    ? modelOptionsMembershipRefusal(selectedValue, selectedModel, name, catalog)
    : null;
  if (modelOptionsRefusal !== null) return yield* modelOptionsRefusal;
  const skipsCatalogMembership = change.setting === "model-options" || typeof selectedValue !== "string";
  if (skipsCatalogMembership) return;
  const refusal = catalogMembershipRefusal(change.setting, selectedValue, name, catalog);
  if (refusal !== null) return yield* refusal;
});

const validateOperationSettingBatch = Effect.fn("Daemon.validateOperationSettingBatch")(function* (
  store: ControlStoreService,
  requestedUpdates: OperationSettingBatch,
) {
  const picture = yield* store.picture;
  const harness = yield* Harness;
  const updates = withModelContextOptionResets(picture.operationSettings, requestedUpdates);
  const rows = applyOperationSettingBatch(picture.operationSettings, updates);
  yield* Effect.forEach(
    requestedUpdates.flatMap(selectionChangesForUpdate),
    (change) => validateSelectionContext(harness, rows, change),
    { discard: true },
  );
  return updates;
});

export const setOperationSetting = Effect.fn("Daemon.SetOperationSetting")(function* (payload: {
  readonly updates: OperationSettingBatch;
}) {
  const refusal = payload.updates.map(operationSettingRefusal).find((candidate) => candidate !== null);
  if (refusal !== undefined) return yield* refusal;
  const store = yield* ControlStore;
  return yield* publishSnapshotMutation(
    store,
    validateOperationSettingBatch(store, payload.updates).pipe(
      Effect.flatMap((updates) => store.updateOperationSettings(updates)),
    ),
  );
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
  return yield* publishSnapshotMutation(store, store.setHarnessEnabled(payload.harness, payload.enabled));
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
  const publisher = yield* DaemonEventPublisher;
  const worker = yield* ReconcileWorker;
  const controlStore = yield* store.withWrite(
    Effect.gen(function* () {
      const updated = yield* store.updateContributionSetting(payload.update);
      yield* worker.invalidateAvailability();
      return updated;
    }),
  );
  yield* worker.submitAfterCurrent().pipe(Effect.ignore);
  const published = yield* publisher.publishControlStore(controlStore);
  yield* publisher.publishWorkspaces();
  return published;
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
  const worker = yield* ReconcileWorker;
  const change = yield* management.update(payload.workspace, payload.update);
  const state = workspaceStateFromChange(change);
  yield* worker.submitAfterCurrent().pipe(Effect.ignore);
  const published = yield* publisher.publishWorkspaces();
  yield* publisher.publishScheduler();
  return published.find((workspace) => workspace.name === payload.workspace) ?? state;
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
  const worker = yield* ReconcileWorker;
  const completed = yield* mutation;
  const result = yield* store.withWrite(
    Effect.gen(function* () {
      const overview = yield* plugins.overview;
      const notices = samePluginMembership(completed.overview, overview) ? completed.notices : [];
      yield* worker.invalidateAvailability();
      return { overview, notices };
    }),
  );
  yield* worker.submitAfterCurrent().pipe(Effect.ignore);
  yield* publisher.publishPlugins(result.overview, result.notices);
  yield* store.picture.pipe(Effect.flatMap(publisher.publishControlStore), Effect.ignore);
  yield* publisher.publishWorkspaces();
  return result;
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

const ensureRequiredPlugin = Effect.fn("Daemon.ensureRequiredPlugin")(function* (
  system: ConnectionEstablishment["system"],
  principalId: PrincipalId,
  rollback: Effect.Effect<void, never>,
) {
  const plugins = yield* PluginManager;
  const overview = yield* plugins.overview;
  const plugin = pluginRequiringConnection(overview, system);
  if (!plugin || plugin.record) return;
  yield* publishPluginMutation(plugins.install(plugin.pluginId, principalId)).pipe(
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
  );
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
  const requestedAccount = ConnectionEstablishment.match(payload.establishment, {
    github: () => null,
    linear: ({ account }) => account,
  });
  if (requestedAccount !== null && existing.account !== requestedAccount) {
    return yield* connectionFailure(
      "re-connect Connection",
      existing.id,
      `Connection is established for "${existing.account}". Remove it before connecting to "${requestedAccount}".`,
    );
  }
  const connection = yield* connections
    .establish(payload.establishment, existing.account)
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
  yield* connections
    .remove(payload.connectionId)
    .pipe(mapConnectionFailure("remove Connection", payload.connectionId));
  yield* publishControlStore();
  return yield* publishConnections(danglingWorkspaces);
});
