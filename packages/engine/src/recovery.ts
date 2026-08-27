import type { LifecycleStage, PollState, SessionId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  consecutiveFailures,
  type EligibleWork,
  eligibleWork,
  maxAttemptsPerStage,
  observedStage,
} from "./classify";
import { type HandoffCause, handoffNote, recoveryReason } from "./comments";
import { IssueTracker, releaseClaim as makeReleaseClaim, type ObservedItem } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { ReconcileWorker, type WorkspaceReconcileState } from "./reconcile";
import { WorkspaceRegistry } from "./registry";
import { handleOf, RunLedger } from "./run-ledger";
import { Scheduler } from "./scheduler";

const maxCrashesPerItem = 3;

export const make = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  const worker = yield* ReconcileWorker;
  const issueTracker = yield* IssueTracker;
  const ledger = yield* RunLedger;
  const scheduler = yield* Scheduler;
  const releaseClaim = makeReleaseClaim(issueTracker);
  const recovered = yield* Ref.make(false);

  const handOffExhausted = Effect.fn("Recovery.handOffExhausted")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage,
    cause: HandoffCause,
    session: SessionId | null,
  ) {
    yield* issueTracker.handOff(workspace, item.id, {
      stage,
      note: handoffNote({
        workspace,
        item,
        stage,
        cause,
        reason: recoveryReason,
        session: yield* handleOf(ledger, session),
      }),
    });
  });

  const noteStaleRecovery = Effect.fn("Recovery.noteStaleRecovery")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
  ) {
    yield* Effect.logInfo("recovered stale claim", {
      workspace: workspace.config.name,
      item: item.id,
    });
    yield* issueTracker.note(
      workspace,
      item.id,
      [
        "> *This was posted by cogwork.*",
        "",
        "**Recovered a stale claim after a daemon restart.**",
        "",
        `Last failure: ${recoveryReason}`,
      ].join("\n"),
    );
  });

  const recordStaleFailure = Effect.fn("Recovery.recordStaleFailure")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage,
    endedAtMillis: number,
    session: SessionId | null,
  ) {
    const attempts = consecutiveFailures(item, stage) + 1;
    const exhausted = attempts >= maxAttemptsPerStage;
    yield* Effect.logWarning("recovered stale claim", {
      workspace: workspace.config.name,
      item: item.id,
      stage,
      reason: recoveryReason,
      attempts,
      exhausted,
    });
    yield* issueTracker.attemptFailed(workspace, item.id, {
      stage,
      atMillis: endedAtMillis,
      reason: recoveryReason,
    });
    if (!exhausted) return;
    yield* handOffExhausted(workspace, item, stage, { kind: "max-attempts", attempts }, session);
  });

  const recoverStale = Effect.fn("Recovery.recoverStale")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage | null,
    session: SessionId | null,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* ledger.closeRunning(workspace.config.name, item.id, endedAtMillis);
    const recover = stage
      ? recordStaleFailure(workspace, item, stage, endedAtMillis, session)
      : noteStaleRecovery(workspace, item);
    yield* recover;
    yield* releaseClaim(workspace, item.id);
  });

  const reschedule = Effect.fn("Recovery.reschedule")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage,
    reason: "interrupted" | "crashed",
    session: SessionId | null,
  ) {
    const observed = eligibleWork(item, stage);
    const work: EligibleWork = session ? { ...observed, resume: { session, reason } } : observed;
    yield* Effect.logInfo("rescheduled resumable run", {
      workspace: workspace.config.name,
      item: item.id,
      stage,
      reason,
    });
    yield* scheduler.admit(workspace, work);
  });

  const handoffCrashLoop = Effect.fn("Recovery.handoffCrashLoop")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage,
    crashes: number,
    session: SessionId | null,
  ) {
    yield* Effect.logWarning("crash loop capped", {
      workspace: workspace.config.name,
      item: item.id,
      stage,
      crashes,
    });
    yield* handOffExhausted(workspace, item, stage, { kind: "crash-loop", crashes }, session);
    yield* releaseClaim(workspace, item.id);
  });

  const recoverCrashed = Effect.fn("Recovery.recoverCrashed")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage,
    session: SessionId | null,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* ledger.crashRunning(workspace.config.name, item.id, endedAtMillis);
    const crashes = yield* ledger.consecutiveCrashes(workspace.config.name, item.id);
    if (crashes < maxCrashesPerItem) {
      return yield* reschedule(workspace, item, stage, "crashed", session);
    }
    yield* handoffCrashLoop(workspace, item, stage, crashes, session);
  });

  const recoverItem = Effect.fn("Recovery.recoverItem")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
  ) {
    const last = yield* ledger.latestRunForItem(workspace.config.name, item.id);
    const stage = observedStage(item);
    if (stage && last?.status === "interrupted") {
      return yield* reschedule(workspace, item, stage, "interrupted", last.session);
    }
    if (stage && last?.status === "running") {
      return yield* recoverCrashed(workspace, item, stage, last.session);
    }
    yield* recoverStale(workspace, item, stage, last?.session ?? null);
  });

  const recoverWorkspace = Effect.fn("Recovery.recoverWorkspace")(function* (
    workspace: RegisteredWorkspace,
    observed: ReadonlyArray<ObservedItem>,
  ) {
    const ours = observed.filter((item) => item.claimedByUs);
    yield* Effect.forEach(ours, (item) => recoverItem(workspace, item), { discard: true });
  });

  const pollDetail = (poll: PollState) =>
    poll.status === "paused" ? { poll: poll.status, reason: poll.reason } : { poll: poll.status };

  const recoverState = (workspace: RegisteredWorkspace, state: WorkspaceReconcileState) => {
    if (state.poll.status !== "ok") {
      return Effect.logWarning("claim recovery deferred; workspace poll is not ok", {
        workspace: workspace.config.name,
        ...pollDetail(state.poll),
      });
    }
    return recoverWorkspace(workspace, state.observed).pipe(
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("claim recovery skipped", {
          workspace: workspace.config.name,
          message: error.message,
        }),
      ),
    );
  };

  const recover = Effect.fn("Recovery.recover")(function* () {
    const snapshot = yield* worker.snapshot;
    const byName = new Map(registry.workspaces.map((workspace) => [workspace.config.name, workspace]));
    yield* Effect.forEach(
      snapshot.workspaces,
      (state) => {
        const workspace = byName.get(state.name);
        return workspace ? recoverState(workspace, state) : Effect.void;
      },
      { discard: true },
    );
  });

  const recoverWhenLive = Effect.fn("Recovery.recoverWhenLive")(function* () {
    const { paused } = yield* scheduler.stats;
    if (paused) return;
    const { generation } = yield* worker.snapshot;
    if (generation === 0) return;
    if (yield* Ref.getAndSet(recovered, true)) return;
    // Captured before recover() so the runs it re-admits (started after) survive the sweep below.
    const orphanCutoffMillis = yield* Clock.currentTimeMillis;
    yield* recover();
    yield* ledger.interruptRunningBefore(orphanCutoffMillis, yield* Clock.currentTimeMillis);
  });

  return { recover, recoverWhenLive };
});

export class Recovery extends Context.Service<Recovery, Effect.Success<typeof make>>()(
  "@cogwork/engine/recovery",
) {}

export const layer = Layer.effect(Recovery, make);
