import type { LifecycleStage, SessionId } from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  consecutiveFailures,
  type EligibleWork,
  eligibleWork,
  maxAttemptsPerStage,
  observedStage,
} from "./classify";
import { recoveryReason } from "./comments";
import { claimant } from "./executor";
import { handToHuman, releaseClaim as makeReleaseClaim } from "./hand-to-human";
import { IssueTracker, type ObservedItem } from "./issue-tracker";
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
  const handoff = handToHuman(issueTracker);
  const releaseClaim = makeReleaseClaim(issueTracker);

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
        "> *This was posted by clanker-forge.*",
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
    yield* issueTracker.recordAttempt(
      workspace,
      item.id,
      { stage, outcome: "failed", atMillis: endedAtMillis },
      recoveryReason,
    );
    if (!exhausted) return;
    yield* handoff({
      workspace,
      item,
      stage,
      cause: { kind: "max-attempts", attempts },
      reason: recoveryReason,
      session: yield* handleOf(ledger, session),
    });
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
    yield* handoff({
      workspace,
      item,
      stage,
      cause: { kind: "crash-loop", crashes },
      reason: recoveryReason,
      session: yield* handleOf(ledger, session),
    });
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
    const owner = claimant(workspace);
    const claimedByUs = observed.filter((item) => item.claim?.by === owner);
    yield* Effect.forEach(claimedByUs, (item) => recoverItem(workspace, item), { discard: true });
  });

  const recoverState = (workspace: RegisteredWorkspace, state: WorkspaceReconcileState) => {
    if (state.poll.status !== "ok") {
      return Effect.logWarning("claim recovery deferred; workspace poll paused", {
        workspace: workspace.config.name,
        reason: state.poll.reason,
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

  return { recover } as const;
});

export class Recovery extends Context.Service<Recovery, Effect.Success<typeof make>>()(
  "@clanker-forge/engine/recovery",
) {}

export const layer = Layer.effect(Recovery, make);
