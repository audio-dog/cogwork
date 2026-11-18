import { keyOf, WorkflowTouchpointFailure } from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { Coordination, maxLineageHops } from "./coordination";
import type { HarnessRunnerEnv } from "./harness";
import { IssueTracker } from "./issue-tracker";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { SlackWrite } from "./slack-write";
import { SourceControlProvider } from "./source-control";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { WorkflowNotifications } from "./workflow-notification";
import { makeCheckout } from "./workflow-run-checkout";
import { ClaimState, makeClaim } from "./workflow-run-claim";
import { makeExecute } from "./workflow-run-execute";
import { makeAdmittedSkills } from "./workflow-run-skills";
import { makeTouchpoints, touchpoint } from "./workflow-run-touchpoint";
import { WorktreeManager } from "./worktree";

export type WorkflowRunOutcome = "completed" | "retry" | "skipped" | "waiting";

interface AdmissionExecutionState {
  readonly current: TriggerAdmission | null;
  readonly outcome: WorkflowRunOutcome;
}

export const make = Effect.gen(function* () {
  const coordination = yield* Coordination;
  const ledger = yield* RunLedger;
  const notifications = yield* WorkflowNotifications;
  const actionPlans = yield* WorkflowActionPlanStore;
  const artifacts = yield* WorkflowArtifactStore;
  const issueTracker = yield* IssueTracker;
  const registry = yield* WorkspaceRegistry;
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
  const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));
  const observationStore = yield* TriggerObservationStore;
  const slack = yield* SlackWrite;
  const harnessContext = yield* Effect.context<HarnessRunnerEnv>();
  const coreExecutionContext = harnessContext.pipe(
    Context.add(Coordination, coordination),
    Context.add(IssueTracker, issueTracker),
    Context.add(RunLedger, ledger),
    Context.add(WorkflowActionPlanStore, actionPlans),
    Context.add(WorkflowArtifactStore, artifacts),
    Context.add(WorkflowNotifications, notifications),
    Context.add(WorkspaceRegistry, registry),
    Context.add(SlackWrite, slack),
    Context.add(TriggerObservationStore, observationStore),
  );
  const sourceControlExecutionContext =
    sourceControl === null
      ? coreExecutionContext
      : Context.add(coreExecutionContext, SourceControlProvider, sourceControl);
  const executionContext =
    worktrees === null
      ? sourceControlExecutionContext
      : Context.add(sourceControlExecutionContext, WorktreeManager, worktrees);
  const previousResultIssues = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const claim = yield* makeClaim(previousResultIssues);
  const { complete, recoverClaimed, settleClaimed } = claim;
  const checkout = yield* makeCheckout(claim);
  const admittedSkills = yield* makeAdmittedSkills;
  const { executeRaw } = yield* makeExecute({ ...claim, ...checkout, admittedSkills, previousResultIssues });
  const touchpointGate = Semaphore.makeUnsafe(1);

  const executeToOutcome = Effect.fn("WorkflowRun.executeToOutcome")(function* (admission: TriggerAdmission) {
    const claimed = yield* Ref.make<ClaimState>(ClaimState.Idle());
    return yield* executeRaw(admission, claimed).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => recoverClaimed(admission, claimed, cause),
      ),
      Effect.onInterrupt(() =>
        Effect.flatMap(Ref.get(claimed), (state) =>
          settleClaimed(claimed, ClaimState.$is("Attempted")(state) ? state.status : "interrupted"),
        ),
      ),
    );
  });

  const executeAdmission = (admission: TriggerAdmission) =>
    observationStore.admissions.pipe(
      Effect.map(
        (admissions) =>
          admissions.find(
            (candidate) =>
              keyOf(candidate.event.key) === keyOf(admission.event.key) &&
              candidate.event.revision === admission.event.revision &&
              candidate.subscription.workflow === admission.subscription.workflow &&
              candidate.subscription.trigger === admission.subscription.trigger,
          ) ?? admission,
      ),
      Effect.flatMap((current) =>
        Effect.reduce(
          Array.from({ length: maxLineageHops + 1 }),
          (): AdmissionExecutionState => ({ current, outcome: "completed" }),
          (state) => {
            if (state.current === null) return Effect.succeed(state);
            return executeToOutcome(state.current).pipe(
              Effect.scoped,
              Effect.flatMap((next) => {
                if (typeof next === "string") {
                  return Effect.succeed<AdmissionExecutionState>({ current: null, outcome: next });
                }
                return observationStore
                  .putAll([next])
                  .pipe(
                    Effect.map((): AdmissionExecutionState => ({ current: next, outcome: state.outcome })),
                  );
              }),
            );
          },
        ),
      ),
      Effect.provide(executionContext),
      Effect.map(({ outcome }) => outcome),
    );

  const { refreshReviewPlansRaw, approve, reject, chooseAnswer, handBack } = yield* makeTouchpoints({
    complete,
    executeAdmission,
    pullRequestBuildInput: checkout.pullRequestBuildInput,
  });

  const runTouchpoint = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    touchpointGate.withPermit(touchpoint(effect).pipe(Effect.provide(executionContext)));

  return {
    execute: executeAdmission,
    refreshReviewPlans: () => touchpointGate.withPermit(refreshReviewPlansRaw()),
    approve: (payload: Parameters<typeof approve>[0]) => runTouchpoint(approve(payload)),
    reject: (payload: Parameters<typeof reject>[0]) => runTouchpoint(reject(payload)),
    chooseAnswer: (payload: Parameters<typeof chooseAnswer>[0]) => runTouchpoint(chooseAnswer(payload)),
    handBack: (payload: Parameters<typeof handBack>[0]) => runTouchpoint(handBack(payload)),
  } as const;
});

export const WorkflowRun = Context.Reference<Effect.Success<typeof make>>(
  "@cogwork/engine/workflow-run/WorkflowRun",
  {
    defaultValue: () => ({
      execute: () => Effect.succeed("completed" as const),
      refreshReviewPlans: () => Effect.void,
      approve: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
      reject: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
      chooseAnswer: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
      handBack: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
    }),
  },
);

export const layer = Layer.effect(WorkflowRun, make);
