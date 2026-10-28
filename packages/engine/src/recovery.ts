import {
  type AvailabilityCause,
  codingOperation,
  type LifecycleStage,
  PollState,
  type RunPlanObservation,
  type RunRecord,
  type SessionId,
  sessionHandle,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { availabilityCauseSummary } from "./availability";
import {
  consecutiveFailures,
  type EligibleWork,
  eligibleWork,
  maxAttemptsPerOperation,
  observedStage,
} from "./classify";
import { type HandoffCause, handoffNote, handoffSession, recoveryReason } from "./comments";
import { isStalledFollowUp } from "./follow-up";
import { Harness } from "./harness";
import { IssueTracker, releaseClaim as makeReleaseClaim, type ObservedItem } from "./issue-tracker";
import { OperationResolution } from "./operation-resolution";
import type { RegisteredWorkspace } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker, type WorkspaceReconcileState } from "./reconcile";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { Scheduler } from "./scheduler";

const maxCrashesPerItem = 3;
const crashLoopsCapped = Metric.counter("cogwork_recovery_crash_loops_capped_total", {
  description: "Recovery crash loops capped before another resume.",
});

const correlationOf = (item: ObservedItem) => {
  const correlation = { item: item.id };
  const stage = observedStage(item);
  return stage ? { ...correlation, stage } : correlation;
};

const accountedRunFor = (item: ObservedItem, run: RunRecord | null) =>
  run && run.startedAtMillis >= (item.claim?.claimedAtMillis ?? 0) ? run : null;

const claimedStage = (item: ObservedItem) =>
  item.claim?.operation.workflow === "coding" ? (item.claim.operation.operation as LifecycleStage) : null;

export const make = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  const worker = yield* ReconcileWorker;
  const issueTracker = yield* IssueTracker;
  const ledger = yield* RunLedger;
  const harness = yield* Harness;
  const scheduler = yield* Scheduler;
  const operationResolution = yield* OperationResolution;
  const releaseClaim = makeReleaseClaim(issueTracker);
  const recoveredWorkspaces = yield* Ref.make<ReadonlySet<WorkspaceId>>(new Set());
  const recoveredGenerations = yield* Ref.make<ReadonlyMap<WorkspaceId, number>>(new Map());
  const orphanSweepComplete = yield* Ref.make(false);
  const recoveryGate = Semaphore.makeUnsafe(1);

  const handOffExhausted = Effect.fn("Recovery.handOffExhausted")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage,
    cause: HandoffCause,
    session: SessionId | null,
  ) {
    const storedSession = session ? yield* ledger.getSession(session) : null;
    const handle = sessionHandle(storedSession);
    const humanAttach = storedSession
      ? harness.capabilities(storedSession.harness)?.session.humanAttach
      : undefined;
    yield* issueTracker.handOff(workspace, item.id, {
      stage,
      note: handoffNote({
        workspace,
        item,
        stage,
        cause,
        reason: recoveryReason,
        session: handoffSession(handle, humanAttach),
      }),
    });
  });

  const noteStaleRecovery = Effect.fn("Recovery.noteStaleRecovery")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
  ) {
    yield* Effect.logInfo("recovered stale claim");
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
    const attempts = consecutiveFailures(item, codingOperation(stage)) + 1;
    const exhausted = attempts >= maxAttemptsPerOperation;
    yield* Effect.logWarning("recovered stale claim", {
      reason: recoveryReason,
      attempts,
      exhausted,
    });
    yield* issueTracker.attemptFailed(workspace, item.id, {
      ...codingOperation(stage),
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
    observation: RunPlanObservation,
  ) {
    const observed = eligibleWork(item, stage);
    const work: EligibleWork = session
      ? { ...observed, recovery: reason, resume: { session, reason } }
      : { ...observed, recovery: reason };
    yield* Effect.logInfo("rescheduled resumable run", {
      reason,
    });
    yield* scheduler.admit(workspace, work, observation);
  });

  const handoffCrashLoop = Effect.fn("Recovery.handoffCrashLoop")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    stage: LifecycleStage,
    crashes: number,
    session: SessionId | null,
  ) {
    yield* Metric.update(Metric.withAttributes(crashLoopsCapped, { stage }), 1);
    yield* Effect.logWarning("crash loop capped", {
      crashes,
    });
    yield* handOffExhausted(workspace, item, stage, { kind: "crash-loop", crashes }, session);
    yield* releaseClaim(workspace, item.id);
  });

  const recoverCrashed = Effect.fn("Recovery.recoverCrashed")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    currentStage: LifecycleStage,
    crashedStage: LifecycleStage,
    session: SessionId | null,
    observation: RunPlanObservation,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* ledger.crashRunning(workspace.config.name, item.id, endedAtMillis);
    const crashes = yield* ledger.consecutiveCrashes(
      workspace.config.name,
      item.id,
      item.handback?.atMillis ?? 0,
    );
    if (crashes < maxCrashesPerItem) {
      return yield* reschedule(workspace, item, currentStage, "crashed", session, observation);
    }
    yield* handoffCrashLoop(workspace, item, crashedStage, crashes, session);
  });

  const rejectRecovery = Effect.fn("Recovery.rejectRecovery")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    causes: ReadonlyArray<AvailabilityCause>,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* ledger.closeRunning(workspace.config.name, item.id, endedAtMillis);
    const detail = causes.map((cause) => `- ${availabilityCauseSummary(cause)}`).join("\n");
    yield* issueTracker
      .note(
        workspace,
        item.id,
        [
          "> *This was posted by cogwork.*",
          "",
          "**Released a stale claim because the Operation is unavailable.**",
          "",
          detail,
        ].join("\n"),
      )
      .pipe(Effect.ignore);
    yield* releaseClaim(workspace, item.id);
  });

  const recoverItem = Effect.fn("Recovery.recoverItem")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
    observation: RunPlanObservation,
  ) {
    const last = yield* ledger.latestRunForItem(workspace.config.name, item.id);
    const accountedRun = accountedRunFor(item, last);
    const currentStage = observedStage(item);
    const work = currentStage ? eligibleWork(item, currentStage) : null;
    if (work && !isStalledFollowUp(work.stage, work.followUp)) {
      const availability = yield* operationResolution.availabilityOf(workspace, work);
      if (!availability.available) {
        return yield* rejectRecovery(workspace, item, availability.causes);
      }
    }
    if (currentStage && last?.status === "interrupted") {
      return yield* reschedule(workspace, item, currentStage, "interrupted", last.session, observation);
    }
    if (currentStage && last?.status === "running") {
      return yield* recoverCrashed(workspace, item, currentStage, last.stage, last.session, observation);
    }
    const staleStage = currentStage ? (accountedRun?.stage ?? claimedStage(item) ?? currentStage) : null;
    yield* recoverStale(workspace, item, staleStage, accountedRun?.session ?? null);
  });

  const recoverWorkspace = Effect.fn("Recovery.recoverWorkspace")(function* (
    workspace: RegisteredWorkspace,
    observed: ReadonlyArray<ObservedItem>,
    observation: RunPlanObservation,
  ) {
    const ours = observed.filter((item) => item.claimedByUs);
    yield* Effect.forEach(
      ours,
      (item) => {
        const correlation = correlationOf(item);
        return recoverItem(workspace, item, observation).pipe(
          Effect.annotateLogs(correlation),
          Effect.annotateSpans(correlation),
        );
      },
      { discard: true },
    );
  });

  const pollDetail = (poll: PollState) =>
    PollState.match(poll, {
      ok: () => ({ poll: "ok" }),
      pending: () => ({ poll: "pending" }),
      paused: ({ reason }) => ({ poll: "paused", reason }),
    });

  const recoverOrphan = Effect.fn("Recovery.recoverOrphan")(function* (
    workspace: RegisteredWorkspace,
    item: ObservedItem,
  ) {
    if (yield* scheduler.isInFlight(workspace, item.id)) return;
    const latest = yield* ledger.latestRunForItem(workspace.config.name, item.id);
    if (latest?.status === "running" || latest?.status === "interrupted") return;
    yield* releaseClaim(workspace, item.id);
  });

  const recoverOrphans = Effect.fn("Recovery.recoverOrphans")(function* (
    workspace: RegisteredWorkspace,
    observed: ReadonlyArray<ObservedItem>,
  ) {
    yield* Effect.forEach(
      observed.filter((item) => item.claimedByUs),
      (item) => {
        const correlation = correlationOf(item);
        return recoverOrphan(workspace, item).pipe(
          Effect.annotateLogs(correlation),
          Effect.annotateSpans(correlation),
        );
      },
      { discard: true },
    );
  });

  const recoverState = (
    workspace: RegisteredWorkspace,
    state: WorkspaceReconcileState,
    recoverObserved: typeof recoverWorkspace,
    observation: RunPlanObservation,
  ) => {
    if (!PollState.guards.ok(state.poll)) {
      return Effect.logWarning("claim recovery deferred; workspace poll is not ok", {
        ...pollDetail(state.poll),
      }).pipe(Effect.map(() => null));
    }
    return recoverObserved(workspace, state.observed, observation).pipe(
      Effect.map(() => workspace.config.name),
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("claim recovery skipped", {
          message: error.message,
        }).pipe(Effect.map(() => null)),
      ),
    );
  };

  const recoverSnapshot = Effect.fn("Recovery.recoverSnapshot")(function* (
    snapshot: ReconcileSnapshot,
    completed: ReadonlySet<WorkspaceId>,
    generations: ReadonlyMap<WorkspaceId, number>,
  ) {
    const state = yield* registry.state;
    const byName = new Map(state.workspaces.map((workspace) => [workspace.config.name, workspace]));
    const observation = {
      generation: snapshot.generation,
      observedAtMillis: snapshot.observedAtMillis,
    };
    const results = yield* Effect.forEach(snapshot.workspaces, (state) => {
      if (generations.get(state.name) === snapshot.generation) return Effect.succeed(null);
      const workspace = byName.get(state.name);
      if (!workspace) return Effect.succeed(null);
      const recoverObserved = completed.has(state.name) ? recoverOrphans : recoverWorkspace;
      const correlation = { workspace: workspace.config.name };
      return recoverState(workspace, state, recoverObserved, observation).pipe(
        Effect.annotateLogs(correlation),
        Effect.annotateSpans(correlation),
      );
    });
    return results.filter((workspace): workspace is WorkspaceId => workspace !== null);
  });

  const recover = Effect.fn("Recovery.recover")(function* () {
    const snapshot = yield* worker.snapshot;
    yield* recoverSnapshot(snapshot, new Set<WorkspaceId>(), new Map());
  });

  const recoverWhenLiveUnlocked = Effect.fn("Recovery.recoverWhenLive")(function* () {
    const { paused } = yield* scheduler.stats;
    if (paused) return;
    const snapshot = yield* worker.snapshot;
    if (snapshot.generation === 0) return;
    const sweepComplete = yield* Ref.get(orphanSweepComplete);
    // Captured before recovery so runs it re-admits survive the startup interruption sweep.
    const orphanCutoffMillis = sweepComplete ? null : yield* Clock.currentTimeMillis;
    const completed = yield* Ref.get(recoveredWorkspaces);
    const generations = yield* Ref.get(recoveredGenerations);
    const recovered = yield* recoverSnapshot(snapshot, completed, generations);
    yield* Ref.update(recoveredWorkspaces, (current) => new Set([...current, ...recovered]));
    yield* Ref.update(
      recoveredGenerations,
      (current) =>
        new Map([...current, ...recovered.map((workspace) => [workspace, snapshot.generation] as const)]),
    );
    if (orphanCutoffMillis === null) return;
    yield* ledger.interruptRunningBefore(orphanCutoffMillis, yield* Clock.currentTimeMillis);
    yield* Ref.set(orphanSweepComplete, true);
  });

  const recoverWhenLive = () => recoveryGate.withPermit(recoverWhenLiveUnlocked());

  return { recover, recoverWhenLive };
});

export class Recovery extends Context.Service<Recovery, Effect.Success<typeof make>>()(
  "@cogwork/engine/recovery",
) {}

export const layer = Layer.effect(Recovery, make);
