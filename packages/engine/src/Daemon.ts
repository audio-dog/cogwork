import { DaemonRpcs } from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Executor } from "./Executor";
import type { RegisteredWorkspace } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker, type WorkspaceReconcileState } from "./Reconcile";
import { WorkspaceRegistry } from "./Registry";
import { RunLedger } from "./RunLedger";
import { ticketSlug, WorktreeManager } from "./Worktree";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "@clanker-forge/engine/Daemon/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

const okPoll = { status: "ok" as const };

const statesByName = (snapshot: ReconcileSnapshot) =>
  new Map(snapshot.workspaces.map((state) => [state.name, state]));

const workspaceInfo = (workspace: RegisteredWorkspace, state: WorkspaceReconcileState | undefined) => ({
  name: workspace.config.name,
  checkoutPath: workspace.config.checkoutPath,
  workSource: workspace.config.workSource.type,
  harness: workspace.config.harness.preferred,
  poll: state?.poll ?? okPoll,
  eligible: state?.eligible ?? [],
  claimed: state?.claimed ?? [],
  blocked: state?.blocked ?? [],
});

export const handlersLayer = DaemonRpcs.toLayer({
  GetStatus: Effect.fn("Daemon.GetStatus")(function* () {
    const registry = yield* WorkspaceRegistry;
    const info = yield* DaemonInfo;
    const worker = yield* ReconcileWorker;
    const snapshot = yield* worker.snapshot;
    const now = yield* Clock.currentTimeMillis;
    const stateByName = statesByName(snapshot);
    return {
      health: "running" as const,
      startedAtMillis: info.startedAtMillis,
      uptimeMillis: now - info.startedAtMillis,
      workspaces: registry.workspaces.map((w) => workspaceInfo(w, stateByName.get(w.config.name))),
      failures: registry.failures.map((f) => ({ source: f.source, message: f.message })),
    };
  }),
  ListRuns: Effect.fn("Daemon.ListRuns")(function* () {
    const ledger = yield* RunLedger;
    return yield* ledger.listRuns(50);
  }),
  GetRunEvents: Effect.fn("Daemon.GetRunEvents")(function* (payload) {
    const ledger = yield* RunLedger;
    return yield* ledger.events(payload.id);
  }),
});

interface ReconcilableWorkspace {
  readonly workspace: RegisteredWorkspace;
  readonly state: WorkspaceReconcileState;
}

const activeTicketKeys = (state: WorkspaceReconcileState) =>
  state.observed.map((item) => ticketSlug(item.id));

const maintainWorktrees = Effect.fn("Daemon.maintainWorktrees")(function* () {
  const registry = yield* WorkspaceRegistry;
  const manager = yield* WorktreeManager;
  const worker = yield* ReconcileWorker;
  const snapshot = yield* worker.snapshot;
  const now = yield* Clock.currentTimeMillis;
  const stateByName = statesByName(snapshot);
  const reconcilable = registry.workspaces
    .map((workspace) => ({ workspace, state: stateByName.get(workspace.config.name) }))
    .filter(
      (entry): entry is ReconcilableWorkspace =>
        entry.workspace.config.worktrees !== undefined && entry.state?.poll.status === "ok",
    );
  yield* Effect.forEach(
    reconcilable,
    ({ workspace, state }) =>
      manager.reconcile(workspace, activeTicketKeys(state), now).pipe(
        Effect.tap((outcome) =>
          Effect.logInfo("worktree maintenance", { workspace: workspace.config.name, ...outcome }),
        ),
        Effect.catchTag("GitError", (error) =>
          Effect.logWarning("worktree maintenance failed", {
            workspace: workspace.config.name,
            message: error.message,
          }),
        ),
      ),
    { discard: true },
  );
});

export const reconcileHeartbeat = Effect.gen(function* () {
  const worker = yield* ReconcileWorker;
  const receipt = yield* worker.submit();
  yield* Effect.logInfo("reconcile tick", receipt);
  yield* maintainWorktrees();
}).pipe(Effect.repeat(Schedule.spaced("5 seconds")));

const triageEligible = (state: WorkspaceReconcileState) =>
  state.eligible.find((item) => item.stage === "triage");

export const executeHeartbeat = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  const worker = yield* ReconcileWorker;
  const executor = yield* Executor;
  const snapshot = yield* worker.snapshot;
  const byName = new Map(registry.workspaces.map((workspace) => [workspace.config.name, workspace]));
  const runState = Effect.fn("Daemon.runState")(function* (state: WorkspaceReconcileState) {
    const workspace = byName.get(state.name);
    const item = triageEligible(state);
    if (workspace && item) yield* executor.runIfIdle(workspace, item);
  });
  yield* Effect.forEach(snapshot.workspaces, runState);
}).pipe(Effect.repeat(Schedule.spaced("5 seconds")));
