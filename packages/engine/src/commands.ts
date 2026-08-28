import {
  type ClassifiedItem,
  type DaemonLimitUpdate,
  RunAlreadyFinished,
  type RunId,
  RunNotFound,
  type TriageRole,
  type WorkItemId,
  WorkItemNotFound,
  type WorkspaceId,
  type WorkspaceRegistration,
  workspaceFailureState,
  workspaceStateFromInfo,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ControlStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import { DaemonEventPublisher } from "./event-publisher";
import { IssueTracker, type ObservedItem } from "./issue-tracker";
import type { RegistryState } from "./projector";
import { classifiedItemWithPr, workspaceInfoOf } from "./read-model";
import { type ReconcileSnapshot, ReconcileWorker } from "./reconcile";
import { WorkspaceManagement, WorkspaceRegistry } from "./registry";
import { RunControl } from "./run-control";
import { RunLedger } from "./run-ledger";
import { Scheduler } from "./scheduler";

const workspaceById = (registry: RegistryState, name: WorkspaceId) =>
  registry.workspaces.find((workspace) => workspace.config.name === name) ?? null;

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

  const registry = yield* WorkspaceRegistry;
  const workspace = workspaceById(registry, run.workspace);
  if (workspace === null) {
    return yield* Effect.die(
      new Error(`cancel: run ${payload.runId} names unregistered workspace ${run.workspace}`),
    );
  }

  const runControl = yield* RunControl;
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

  const issueTracker = yield* IssueTracker;
  yield* issueTracker
    .handOff(workspace, run.workItem, { stage: run.stage, note: payload.note })
    .pipe(Effect.andThen(issueTracker.release(workspace, run.workItem)), Effect.orDie);

  const snapshot = yield* (yield* ReconcileWorker).snapshot;
  const observed = observedFor(snapshot, run.workspace, run.workItem);
  const item = parkedItem(observed) ?? parkedNeedsHuman(run.workItem, run.workItem);
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

export const registerWorkspace = Effect.fn("Daemon.RegisterWorkspace")(function* (payload: {
  readonly registration: WorkspaceRegistration;
}) {
  const management = yield* WorkspaceManagement;
  const publisher = yield* DaemonEventPublisher;
  const change = yield* management.register(payload.registration);
  const state =
    change._tag === "Registered"
      ? workspaceStateFromInfo(workspaceInfoOf(change.workspace, undefined))
      : workspaceFailureState(change.failure);
  yield* publisher.publishWorkspaces();
  return state;
});
