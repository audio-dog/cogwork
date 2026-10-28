import { randomUUID } from "node:crypto";
import type {
  AvailabilityCause,
  HarnessName,
  RunPlanObservation,
  RunRecord,
  StageResult,
  TokenUsage,
} from "@cogwork/contracts";
import {
  AgUiEvent,
  agUiIsSessionHandleEvent,
  agUiIsStructuredOutputComplete,
  codingOperation,
  FollowUpStageResult,
  ImplementStageResult,
  issueTrackerErrorIsPermanent,
  type LifecycleStage,
  RunId,
  type StageResultCompletionSchema,
  sessionHandle,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Availability, availabilityCauseSummary } from "./availability";
import { type AdmittedWork, type EligibleWork, maxAttemptsPerOperation } from "./classify";
import {
  followUpNoteBody,
  handoffNote,
  handoffSession,
  prepareFailureReason,
  triageProposalBody,
} from "./comments";
import { ContextAssembler } from "./context-assembler";
import { ControlStore } from "./control-store";
import * as Cooldown from "./cooldown";
import { CredentialStore } from "./credential-store";
import { type FollowUpContext, isStalledFollowUp, noProgressAfterRound } from "./follow-up";
import { Harness, HarnessError, type HarnessRequest, type HarnessRunnerEnv } from "./harness";
import { HarnessReadinessCache } from "./harness-readiness";
import { IssueTracker, type IssueTrackerError, releaseClaim as makeReleaseClaim } from "./issue-tracker";
import * as OperationResolution from "./operation-resolution";
import { OperationOutcome, type OperationOutcomeTable } from "./playbook";
import type { RegisteredWorkspace } from "./projector";
import { defaultRunBudget } from "./provider-runner";
import {
  decideRetry,
  nonRetryableDecision,
  type PrepareError,
  type RetryDecision,
  type RetryFailure,
} from "./retry-policy";
import { RunControl } from "./run-control";
import {
  encodeRunEventOperation,
  handleOf,
  RunLedger,
  type RunLedgerError,
  type RunUpdate,
} from "./run-ledger";
import type { ResolvedOperation } from "./run-plan";
import type { PreparedRun } from "./run-preparation";
import * as RunPreparation from "./run-preparation";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { SourceControlProvider } from "./source-control";
import { branchName, PullRequestReadiness, WorktreeManager } from "./worktree";

export const harnessEventFoldDuration = Metric.timer("cogwork_harness_event_fold_duration", {
  description: "Time to fold one harness event into Run state.",
});

interface RunAccumulator {
  readonly handle: string | null;
  readonly usage: TokenUsage | null;
  readonly structuredOutputs: ReadonlyArray<unknown>;
  readonly deferredTerminal: AgUiEvent | null;
}

interface AcceptedRun extends PreparedRun {
  readonly record: RunRecord;
}

type HarnessAdmission<A> =
  | { readonly cause: AvailabilityCause; readonly value: null }
  | { readonly cause: null; readonly value: A };

const emptyAccumulator: RunAccumulator = {
  handle: null,
  usage: null,
  structuredOutputs: [],
  deferredTerminal: null,
};

export { meteredTotalTokens } from "./resume-policy";

class SessionRestarted extends Data.TaggedError("SessionRestarted")<Record<string, never>> {}

const defaultFollowUp: FollowUpContext = {
  previousMarker: null,
  checks: "pending",
  humanCommentAtMillis: 0,
  botTriggerAtMillis: 0,
  noProgress: 0,
  stalled: false,
  fresh: false,
  baseDivergence: "none",
};

const withHandle = (acc: RunAccumulator, handle: string | null) => ({ ...acc, handle });

const mergeEvent = (acc: RunAccumulator, event: AgUiEvent, handle: string | null): RunAccumulator =>
  AgUiEvent.matchOrElse(
    event,
    {
      CUSTOM: (event) => ({
        ...withHandle(acc, handle),
        structuredOutputs: agUiIsStructuredOutputComplete(event)
          ? [...acc.structuredOutputs, event.value]
          : acc.structuredOutputs,
      }),
      RUN_FINISHED: ({ usage }) => {
        if (!usage) return withHandle(acc, handle);
        return {
          ...withHandle(acc, handle),
          usage: {
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            ...(usage.estimated ? { estimated: true } : {}),
          },
        };
      },
    },
    () => withHandle(acc, handle),
  );

const failedTerminal: AgUiEvent = { type: "RUN_FINISHED", finishReason: "failed" };
const successfulTerminal = (event: AgUiEvent) =>
  AgUiEvent.guards.RUN_FINISHED(event) && event.finishReason !== "failed";

const withFailureTerminal = <R>(stream: Stream.Stream<AgUiEvent, HarnessError, R>) =>
  Stream.catchCause(stream, (cause) =>
    Stream.concat(Stream.succeed(failedTerminal), Stream.failCause(cause)),
  );

const decodeRunId = Schema.decodeUnknownEffect(RunId);
const hasInterruptsOnly = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

const admitHarness = <A, E, R>(
  cause: AvailabilityCause | null,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<HarnessAdmission<A>, E, R> => {
  if (cause) return Effect.succeed({ cause, value: null });
  return effect.pipe(Effect.map((value) => ({ cause: null, value })));
};

export const make = Effect.gen(function* () {
  const issueTracker = yield* IssueTracker;
  const harness = yield* Harness;
  const harnessReadiness = yield* HarnessReadinessCache;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const worktrees = yield* WorktreeManager;
  const operationResolution = yield* OperationResolution.OperationResolution;
  const runControl = yield* RunControl;
  const sourceControl = yield* SourceControlProvider;
  const contextAssembler = yield* ContextAssembler;
  const controlStore = yield* ControlStore;
  const runPreparation = yield* RunPreparation.make;
  const harnessRunnerContext = yield* Effect.context<HarnessRunnerEnv>().pipe(
    Effect.map(
      Context.pick(
        SessionStore,
        ContextAssembler,
        CredentialStore,
        FileSystem.FileSystem,
        Path.Path,
        HttpClient.HttpClient,
      ),
    ),
  );
  const releaseClaim = makeReleaseClaim(issueTracker);
  const releaseClaimUnlessInterrupted = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) =>
    effect.pipe(
      Effect.onExit((exit) => (hasInterruptsOnly(exit) ? Effect.void : releaseClaim(workspace, item.id))),
    );
  const claimCooldowns = yield* Cooldown.make;
  const admissionCooldowns = yield* Cooldown.make;

  const cleanupRunContext = (runId: RunId) =>
    contextAssembler
      .cleanup(runId)
      .pipe(
        Effect.catchTag("ContextFsError", (error) =>
          Effect.logWarning("run context cleanup failed", { message: error.message }),
        ),
      );

  const nextRunId = () =>
    Effect.sync(() => `run-${randomUUID()}`).pipe(Effect.flatMap(decodeRunId), Effect.orDie);

  const claimScope = (workspace: RegisteredWorkspace, item: EligibleWork) =>
    `${workspace.config.name}:${item.id}:${item.stage}`;

  const holdOffItem = Effect.fn("Executor.holdOffItem")(function* (
    cooldowns: typeof claimCooldowns,
    scope: string,
    item: EligibleWork,
    error: IssueTrackerError,
  ) {
    const { retryAtMillis } = yield* cooldowns.enter(scope, error.retryAfterMillis);
    yield* Effect.logWarning(
      "issue-tracker operation failed; holding this item off until the window expires",
      {
        stage: item.stage,
        item: item.id,
        retryAtMillis,
        error,
      },
    );
  });

  const logParkStep = (step: string, item: EligibleWork, error: IssueTrackerError) =>
    Effect.logWarning("could not park a refused claim", {
      step,
      stage: item.stage,
      item: item.id,
      error,
    });

  // The note goes first and on its own: the role writes can hit the very refusal being reported, and
  // a human surface that survives that is the whole point of parking.
  const parkRefusedClaim = Effect.fn("Executor.parkRefusedClaim")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    error: IssueTrackerError,
  ) {
    yield* issueTracker
      .note(
        workspace,
        item.id,
        handoffNote({
          workspace,
          item,
          stage: item.stage,
          cause: { kind: "refused-claim" },
          reason: error.message,
          session: null,
        }),
      )
      .pipe(Effect.catchTag("IssueTrackerError", (error) => logParkStep("note", item, error)));
    yield* issueTracker
      .handOff(workspace, item.id, { stage: item.stage })
      .pipe(Effect.catchTag("IssueTrackerError", (error) => logParkStep("roles", item, error)));
  });

  const declineClaim = Effect.fn("Executor.declineClaim")(function* (
    scope: string,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    error: IssueTrackerError,
  ) {
    yield* holdOffItem(claimCooldowns, scope, item, error);
    if (issueTrackerErrorIsPermanent(error)) yield* parkRefusedClaim(workspace, item, error);
    return false;
  });

  const tryClaim = Effect.fn("Executor.tryClaim")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    at: number,
  ) {
    const scope = claimScope(workspace, item);
    const heldUntil = yield* Effect.all([
      claimCooldowns.heldUntil(scope),
      admissionCooldowns.heldUntil(scope),
    ]);
    if (heldUntil.some((until) => until !== null)) return false;
    return yield* issueTracker.claim(workspace, item.id, { claimedAtMillis: at, stage: item.stage }).pipe(
      Effect.matchEffect({
        onFailure: (error) => declineClaim(scope, workspace, item, error),
        onSuccess: () => claimCooldowns.clear(scope).pipe(Effect.map(() => true)),
      }),
    );
  });

  const settleRun = (runId: RunId, update: RunUpdate) => ledger.updateRun(runId, update);

  const foldEvent = Effect.fn("Executor.foldEvent")(function* (
    record: RunRecord,
    acc: RunAccumulator,
    event: AgUiEvent,
    deferTerminal: boolean,
  ) {
    if (deferTerminal && successfulTerminal(event)) {
      return { ...mergeEvent(acc, event, acc.handle), deferredTerminal: event };
    }
    const handle = yield* recorder.record(record, event);
    return mergeEvent(acc, event, handle);
  });

  const foldStream = <A, E, R>(
    record: RunRecord,
    request: HarnessRequest,
    initial: A,
    step: (acc: A, event: AgUiEvent) => Effect.Effect<A, E, R>,
  ) => {
    const budget = defaultRunBudget(request.plan.harness.profile);
    return Stream.runFoldEffect(
      withFailureTerminal(harness.run(request)).pipe(Stream.provideContext(harnessRunnerContext)),
      () => initial,
      (acc, event) => step(acc, event).pipe(Effect.trackDuration(harnessEventFoldDuration)),
    ).pipe(
      Effect.timeout(budget),
      Effect.catchTag("TimeoutError", () =>
        recorder.record(record, failedTerminal).pipe(
          Effect.andThen(
            Effect.fail(
              new HarnessError({
                reason: "turn",
                retryable: true,
                message: `${request.plan.operation} harness run timed out after ${budget}`,
              }),
            ),
          ),
        ),
      ),
    );
  };

  const guardResume = (event: AgUiEvent, expected: string) => {
    if (!agUiIsSessionHandleEvent(event) || event.value.sessionId === expected) return Effect.void;
    return Effect.fail(new SessionRestarted({}));
  };

  const rejectedResume = (record: RunRecord) =>
    recorder.record(record, failedTerminal).pipe(
      Effect.andThen(
        Effect.fail(
          new HarnessError({
            reason: "turn",
            retryable: true,
            message: "harness restarted instead of resuming its session",
          }),
        ),
      ),
    );

  const foldHarness = Effect.fn("Executor.foldHarness")(function* (
    record: RunRecord,
    request: HarnessRequest,
    deferTerminal: boolean,
  ) {
    const expected = yield* handleOf(ledger, request.session);
    const fold = foldStream(record, request, emptyAccumulator, (acc, event) => {
      if (!expected) return foldEvent(record, acc, event, deferTerminal);
      return guardResume(event, expected).pipe(Effect.andThen(foldEvent(record, acc, event, deferTerminal)));
    });
    return yield* fold.pipe(Effect.catchTag("SessionRestarted", () => rejectedResume(record)));
  });

  const handOffAllowed = Effect.fn("Executor.handOffAllowed")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    if (item.stage !== "implement") return true;
    const headBranch = branchName(item);
    const openPullRequest = yield* sourceControl.findOpenPullRequest(workspace, headBranch).pipe(
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("open pull request lookup failed before handoff", {
          headBranch,
          message: error.message,
        }).pipe(Effect.map(() => null)),
      ),
    );
    return openPullRequest === null;
  });

  const reportDecidedFailure = Effect.fn("Executor.reportDecidedFailure")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    decision: RetryDecision,
    reason: string,
    harnessName: HarnessName,
    handle: string | null,
    checkoutPath: string | undefined,
  ) {
    const failedFollowUp =
      item.stage === "follow-up" ? yield* followUpContextAtFailure(workspace, item) : null;
    const endedAtMillis = yield* Clock.currentTimeMillis;
    const attempts = item.priorFailures + 1;
    const { retryable, handoffCause } = decision;
    const exhausted = !retryable || attempts >= maxAttemptsPerOperation;
    yield* Effect.logWarning("stage attempt failed", {
      reason,
      retryable,
      exhausted,
    });
    yield* issueTracker.attemptFailed(workspace, item.id, {
      ...codingOperation(item.stage),
      atMillis: endedAtMillis,
      reason,
      ...(item.stage === "follow-up"
        ? {
            marker: failedFollowUpMarker(failedFollowUp ?? defaultFollowUp, endedAtMillis),
          }
        : {}),
    });
    if (exhausted && (yield* handOffAllowed(workspace, item))) {
      yield* issueTracker.handOff(workspace, item.id, {
        stage: item.stage,
        note: handoffNote({
          workspace,
          item,
          stage: item.stage,
          cause: handoffCause,
          reason,
          session: handoffSession(handle, harness.capabilities(harnessName)?.session.humanAttach),
          checkoutPath,
        }),
      });
    }
    return {
      status: exhausted ? "exhausted" : "failed",
      usage: null,
      endedAtMillis,
    } satisfies RunUpdate;
  });

  const reportFailureAtCheckout = (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    failure: RetryFailure,
    harnessName: HarnessName,
    handle: string | null,
    checkoutPath: string | undefined,
  ) =>
    reportDecidedFailure(
      workspace,
      item,
      decideRetry({ failure, attempts: item.priorFailures + 1 }),
      prepareFailureReason(failure),
      harnessName,
      handle,
      checkoutPath,
    );

  const reportFailure = (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    failure: RetryFailure,
    harnessName: HarnessName,
    handle: string | null,
    checkoutPath: string,
  ) => reportFailureAtCheckout(workspace, item, failure, harnessName, handle, checkoutPath);

  const reportUnpreparedFailure = (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    failure: RetryFailure,
    harnessName: HarnessName,
    handle: string | null,
    checkoutPath: string,
  ) => reportFailureAtCheckout(workspace, item, failure, harnessName, handle, checkoutPath);

  const applyFailure = Effect.fn("Executor.applyFailure")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    failure: RetryFailure,
    handle: string | null,
  ) {
    return yield* settleReportedFailure(
      accepted.record.id,
      reportFailure(workspace, item, failure, accepted.record.harness, handle, accepted.checkoutPath),
    );
  });

  const settleReportedRun = (
    runId: RunId,
    reported: Effect.Effect<RunUpdate, IssueTrackerError>,
    updateRun: (update: RunUpdate) => RunUpdate,
  ) =>
    reported.pipe(
      Effect.tapError(() =>
        Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
          settleRun(runId, { status: "failed", usage: null, endedAtMillis }),
        ),
      ),
      Effect.flatMap((update) => settleRun(runId, updateRun(update))),
    );

  const settleReportedFailure = (runId: RunId, reported: Effect.Effect<RunUpdate, IssueTrackerError>) =>
    settleReportedRun(runId, reported, (update) => update);

  const structuredResultError = (message: string) =>
    new HarnessError({ reason: "turn", retryable: true, message });

  const expectSingleStructuredResult = Effect.fn("Executor.expectSingleStructuredResult")(function* (
    stage: "triage" | "implement" | "follow-up",
    acc: Pick<RunAccumulator, "structuredOutputs">,
  ) {
    if (acc.structuredOutputs.length !== 1) {
      return yield* structuredResultError(
        `expected exactly one structured ${stage} result, received ${acc.structuredOutputs.length}`,
      );
    }
    return acc.structuredOutputs[0];
  });

  const followUpMarker = (context: FollowUpContext, noProgress: number, attemptAtMillis: number) => ({
    checks: context.checks,
    humanCommentAtMillis: context.humanCommentAtMillis,
    botTriggerAtMillis: context.botTriggerAtMillis,
    attemptAtMillis,
    noProgress,
    baseDivergence: context.baseDivergence,
  });

  const failedFollowUpMarker = (context: FollowUpContext, attemptAtMillis: number) =>
    followUpMarker(
      {
        ...context,
        humanCommentAtMillis: context.previousMarker?.humanCommentAtMillis ?? 0,
        botTriggerAtMillis: context.previousMarker?.botTriggerAtMillis ?? 0,
      },
      Math.max(context.noProgress - 1, 0),
      attemptAtMillis,
    );

  const followUpContextAtFailure = Effect.fn("Executor.followUpContextAtFailure")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const baseDivergence = yield* sourceControl.observe(workspace, [{ id: item.id, title: item.title }]).pipe(
      Effect.map((signals) => signals.get(item.id)?.baseDivergence ?? "conflict"),
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("failed to refresh pull request before recording follow-up failure", {
          message: error.message,
        }).pipe(Effect.map(() => "conflict" as const)),
      ),
    );
    return { ...(item.followUp ?? defaultFollowUp), baseDivergence };
  });

  const postFollowUpSummary = Effect.fn("Executor.postFollowUpSummary")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    summary: string,
  ) {
    yield* sourceControl
      .comment(workspace, { id: item.id, title: item.title }, followUpNoteBody(summary))
      .pipe(
        Effect.catchTag("IssueTrackerError", (error) =>
          Effect.logWarning("follow-up summary comment failed", {
            message: error.message,
          }),
        ),
      );
  });

  const outcomeForResult = (table: OperationOutcomeTable, result: string) =>
    table.outcomes.find((outcome) => outcome.result === result) ?? null;

  const decodeOperationOutcome = (
    stage: LifecycleStage,
    schema: StageResultCompletionSchema,
    table: OperationOutcomeTable,
    acc: RunAccumulator,
  ) =>
    expectSingleStructuredResult(stage, acc).pipe(
      Effect.flatMap((input) => Schema.decodeUnknownEffect(schema)(input)),
      Effect.mapError((error) =>
        structuredResultError(`invalid structured ${stage} result: ${error.message}`),
      ),
      Effect.flatMap((completion) => {
        const outcome = outcomeForResult(table, completion.object.resultKey);
        if (outcome) {
          return Effect.succeed({
            detail: completion.object.detail,
            outcome,
            result: completion.object,
          });
        }
        return Effect.fail(structuredResultError("structured result has no declared operation outcome"));
      }),
    );

  const applyTriaged = Effect.fn("Executor.applyTriaged")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    proposal: string,
    outcome: Extract<OperationOutcome, { readonly _tag: "Triaged" }>,
    atMillis: number,
  ) {
    yield* issueTracker.triaged(workspace, item.id, {
      role: outcome.result,
      proposal: triageProposalBody(proposal),
      atMillis,
    });
  });

  const applyImplemented = Effect.fn("Executor.applyImplemented")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    atMillis: number,
  ) {
    yield* issueTracker.implemented(workspace, item.id, { atMillis });
  });

  const applyFollowedUp = Effect.fn("Executor.applyFollowedUp")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    result: StageResult,
    atMillis: number,
  ) {
    if (!Schema.is(FollowUpStageResult)(result)) {
      return yield* Effect.die(new Error("follow-up outcome did not carry a follow-up result"));
    }
    const shouldPost = FollowUpStageResult.match(result, {
      pushed: () => true,
      noop: ({ speak }) => speak,
      stuck: () => false,
    });
    if (shouldPost) yield* postFollowUpSummary(workspace, item, result.summary);
    const context = item.followUp ?? defaultFollowUp;
    yield* issueTracker.followedUp(workspace, item.id, {
      marker: followUpMarker(context, noProgressAfterRound(context, result.outcome), atMillis),
      summary: result.summary,
      atMillis,
    });
  });

  const applySuccessfulOutcome = Effect.fn("Executor.applySuccessfulOutcome")(function* <R>(
    record: RunRecord,
    acc: RunAccumulator,
    apply: (atMillis: number) => Effect.Effect<void, IssueTrackerError, R>,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* apply(endedAtMillis);
    yield* settleRun(record.id, {
      status: "succeeded",
      usage: acc.usage,
      endedAtMillis,
    });
  });

  const retryableOperationDecision = (attempts: number) =>
    ({ retryable: true, handoffCause: { kind: "max-attempts", attempts } }) satisfies RetryDecision;

  const declinePullRequest = Effect.fn("Executor.declinePullRequest")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
    reason: string,
  ) {
    const { record } = accepted;
    yield* Effect.logWarning("pull request gate declined", { reason });
    return yield* settleReportedRun(
      record.id,
      reportDecidedFailure(
        workspace,
        item,
        retryableOperationDecision(item.priorFailures + 1),
        reason,
        record.harness,
        acc.handle,
        accepted.checkoutPath,
      ),
      (update) => ({
        ...update,
        status: "declined",
        usage: acc.usage,
      }),
    );
  });

  const settleImplemented = (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
  ) =>
    applySuccessfulOutcome(accepted.record, acc, (atMillis) => applyImplemented(workspace, item, atMillis));

  const settleWriteFailure = Effect.fn("Executor.settleWriteFailure")(function* (
    accepted: AcceptedRun,
    acc: RunAccumulator,
    error: { readonly message: string },
  ) {
    yield* Effect.logError("pull request write failed", { message: error.message });
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* settleRun(accepted.record.id, {
      status: "failed",
      usage: acc.usage,
      endedAtMillis,
    });
  });

  const createPullRequest = Effect.fn("Executor.createPullRequest")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
    result: Extract<StageResult, { readonly outcome: "ready-for-pr" }>,
    headBranch: string,
    baseBranch: string,
  ) {
    return yield* worktrees.pushBranch(workspace, headBranch).pipe(
      Effect.andThen(
        sourceControl.findOpenPullRequest(workspace, headBranch).pipe(
          Effect.flatMap((existing) =>
            existing
              ? Effect.succeed(existing)
              : sourceControl.openPullRequest(workspace, {
                  headBranch,
                  baseBranch,
                  title: result.title,
                  body: result.body,
                }),
          ),
        ),
      ),
      Effect.matchEffect({
        onFailure: (error) => settleWriteFailure(accepted, acc, error),
        onSuccess: () => settleImplemented(workspace, item, accepted, acc),
      }),
    );
  });

  const createReadyPullRequest = Effect.fn("Executor.createReadyPullRequest")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
    result: Extract<StageResult, { readonly outcome: "ready-for-pr" }>,
  ) {
    return yield* worktrees.pullRequestReadiness(workspace, item).pipe(
      Effect.matchEffect({
        onFailure: (error) => applyFailure(workspace, item, accepted, error, acc.handle),
        onSuccess: (readiness) =>
          PullRequestReadiness.$match(readiness, {
            Declined: ({ reason }) => declinePullRequest(workspace, item, accepted, acc, reason),
            Ready: ({ headBranch, baseBranch }) =>
              createPullRequest(workspace, item, accepted, acc, result, headBranch, baseBranch),
          }),
      }),
    );
  });

  const openPullRequest = Effect.fn("Executor.openPullRequest")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
    result: StageResult,
  ) {
    if (!ImplementStageResult.guards["ready-for-pr"](result)) {
      return yield* applyFailure(
        workspace,
        item,
        accepted,
        structuredResultError("ready-for-pr outcome has no pull request content"),
        acc.handle,
      );
    }
    return yield* createReadyPullRequest(workspace, item, accepted, acc, result);
  });

  const operationDecision = (
    outcome: Extract<OperationOutcome, { readonly _tag: "Failed" }>,
    attempts: number,
  ) => {
    if (!outcome.retryable) return nonRetryableDecision;
    return retryableOperationDecision(attempts);
  };

  const applyOperationFailure = Effect.fn("Executor.applyOperationFailure")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
    detail: string,
    outcome: Extract<OperationOutcome, { readonly _tag: "Failed" }>,
  ) {
    const { record } = accepted;
    return yield* settleReportedFailure(
      record.id,
      reportDecidedFailure(
        workspace,
        item,
        operationDecision(outcome, item.priorFailures + 1),
        detail,
        record.harness,
        acc.handle,
        accepted.checkoutPath,
      ),
    );
  });

  const applyOperationOutcome = Effect.fn("Executor.applyOperationOutcome")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
    detail: string,
    outcome: OperationOutcome,
    result: StageResult,
  ) {
    const { record } = accepted;
    return yield* OperationOutcome.$match(outcome, {
      Failed: (outcome) => applyOperationFailure(workspace, item, accepted, acc, detail, outcome),
      FollowedUp: () =>
        applySuccessfulOutcome(record, acc, (atMillis) => applyFollowedUp(workspace, item, result, atMillis)),
      Implemented: () =>
        applySuccessfulOutcome(record, acc, (atMillis) => applyImplemented(workspace, item, atMillis)),
      PullRequestReady: () => openPullRequest(workspace, item, accepted, acc, result),
      Triaged: (outcome) =>
        applySuccessfulOutcome(record, acc, (atMillis) =>
          applyTriaged(workspace, item, detail, outcome, atMillis),
        ),
    });
  });

  const completeOperation = Effect.fn("Executor.completeOperation")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
    acc: RunAccumulator,
  ) {
    const { record } = accepted;
    const { outcomeTable, resultSchema } = accepted.operation.stage;
    const recordCompletionTerminal = (status: "failed" | "succeeded") => {
      if (item.stage !== "triage") return Effect.succeed(null);
      if (status === "failed") return recorder.record(record, failedTerminal);
      return recorder.record(record, acc.deferredTerminal ?? { type: "RUN_FINISHED", finishReason: "stop" });
    };
    return yield* decodeOperationOutcome(item.stage, resultSchema.completion, outcomeTable, acc).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          recordCompletionTerminal("failed").pipe(
            Effect.andThen(applyFailure(workspace, item, accepted, error, acc.handle)),
          ),
        onSuccess: ({ detail, outcome, result }) =>
          recordCompletionTerminal("succeeded").pipe(
            Effect.andThen(applyOperationOutcome(workspace, item, accepted, acc, detail, outcome, result)),
          ),
      }),
    );
  });

  const handoffStalled = Effect.fn("Executor.handoffStalled")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const context = yield* followUpContextAtFailure(workspace, item);
    const atMillis = yield* Clock.currentTimeMillis;
    // The count is spent the moment the hand-off lands: a human owns the PR now, and while it wears
    // `ready-for-human` no poll can reach a follow-up round to move the count again. Parking it at 0
    // makes the hand-off a door that opens both ways — whoever hands it back, by any route, gets a
    // fresh three rounds instead of an item that claims and abandons in the same breath. The detail
    // still reports the count that parked it.
    yield* issueTracker.stalled(workspace, item.id, {
      marker: followUpMarker(context, 0, atMillis),
      atMillis,
      detail: `Follow-up made no progress after ${context.noProgress} attempts — neither the checks turned green nor a human responded. Handing this to a human.`,
    });
  });

  const settleOutcome = Effect.fn("Executor.settleOutcome")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    accepted: AcceptedRun,
  ) {
    const { record, request } = accepted;
    const recordEncodingFailureTerminal = (error: PrepareError | HarnessError) => {
      if (error._tag !== "RunLedgerError" || error.operation !== encodeRunEventOperation) {
        return Effect.succeed(null);
      }
      return recorder.record(record, failedTerminal);
    };

    const settleFailure = (error: PrepareError | HarnessError) => {
      const readinessFailure =
        error._tag === "HarnessError" && ["credential", "launch"].includes(error.reason) ? error : null;
      const refreshReadiness = readinessFailure
        ? harnessReadiness.requestOne(record.harness, readinessFailure)
        : Effect.void;
      return refreshReadiness.pipe(
        Effect.andThen(recordEncodingFailureTerminal(error)),
        Effect.andThen(handleOf(ledger, record.session)),
        Effect.flatMap((handle) => applyFailure(workspace, item, accepted, error, handle)),
      );
    };

    const settleCompletionFailure = (error: RunLedgerError) => {
      if (error.operation === encodeRunEventOperation) return settleFailure(error);
      return Effect.fail(error);
    };

    const settle = <A, R>(
      attempt: Effect.Effect<A, PrepareError | HarnessError, R>,
      complete: (acc: A) => Effect.Effect<void, IssueTrackerError | RunLedgerError>,
    ) =>
      attempt.pipe(
        Effect.matchEffect({
          onFailure: settleFailure,
          onSuccess: (acc) => complete(acc).pipe(Effect.catchTag("RunLedgerError", settleCompletionFailure)),
        }),
      );

    const settleRecordedRun = (status: "failed" | "succeeded", usage: TokenUsage | null) =>
      Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
        settleRun(record.id, { status, usage, endedAtMillis }),
      );

    const settleRecorded = <R>(attempt: Effect.Effect<RunAccumulator, PrepareError | HarnessError, R>) =>
      attempt.pipe(
        Effect.matchEffect({
          onFailure: () => settleRecordedRun("failed", null),
          onSuccess: (acc) => settleRecordedRun("succeeded", acc.usage),
        }),
      );

    if (record.harness === "replay") {
      yield* settleRecorded(foldHarness(record, request, false));
      return;
    }
    return yield* settle(foldHarness(record, request, item.stage === "triage"), (acc) =>
      completeOperation(workspace, item, accepted, acc),
    );
  });

  const acceptPlannedRun = Effect.fn("Executor.acceptPlannedRun")(function* (
    runId: RunId,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    startedAtMillis: number,
    prepared: PreparedRun,
  ) {
    const record: RunRecord = {
      id: runId,
      workspace: workspace.config.name,
      workItem: item.id,
      stage: item.stage,
      harness: prepared.operation.stage.harness,
      branch: prepared.branch,
      session: prepared.session,
      usage: null,
      status: "running",
      startedAtMillis,
      endedAtMillis: null,
    };
    yield* ledger.acceptRun(record, prepared.plan);
    return { ...prepared, record } satisfies AcceptedRun;
  });

  const acceptEnabledHarnessRun = Effect.fn("Executor.acceptEnabledHarnessRun")(function* (
    runId: RunId,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    startedAtMillis: number,
    prepared: PreparedRun,
  ) {
    const admission = yield* controlStore.withWrite(
      operationResolution
        .harnessCause(prepared.operation.stage.harness)
        .pipe(
          Effect.flatMap((cause) =>
            admitHarness(cause, acceptPlannedRun(runId, workspace, item, startedAtMillis, prepared)),
          ),
        ),
    );
    if (!admission.cause) return admission.value;
    yield* noteUnavailableResume(workspace, item, [admission.cause]);
    return null;
  });

  const claimEnabledItem = Effect.fn("Executor.claimEnabledItem")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const admission = yield* controlStore.withWrite(
      operationResolution
        .currentHarnessCause(workspace, item.stage)
        .pipe(Effect.flatMap((cause) => admitHarness(cause, tryClaim(workspace, item, startedAtMillis)))),
    );
    if (!admission.cause) return { claimed: admission.value, startedAtMillis };
    return { claimed: yield* decline(workspace, item, [admission.cause]), startedAtMillis };
  });

  const handoffClaimedStalled = Effect.fn("Executor.handoffClaimedStalled")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    yield* releaseClaimUnlessInterrupted(handoffStalled(workspace, item), workspace, item);
    return true;
  });

  const refreshWorkContext = Effect.fn("Executor.refreshWorkContext")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const prose = yield* issueTracker.readProse(workspace, item.id);
    return { ...item, workContext: { ...item.workContext, prose } } satisfies AdmittedWork;
  });

  const rejectAdmission = Effect.fn("Executor.rejectAdmission")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    operation: ResolvedOperation,
    error: IssueTrackerError,
  ) {
    yield* holdOffItem(admissionCooldowns, claimScope(workspace, item), item, error);
    yield* Effect.logWarning("Run admission rejected because the issue-tracker Connection failed", {
      workspace: workspace.config.name,
      item: item.id,
      connection: operation.issueTrackerBinding,
      message: error.message,
    });
    if (issueTrackerErrorIsPermanent(error)) {
      yield* issueTracker
        .handOff(workspace, item.id, {
          stage: item.stage,
          note: `Work Context admission failed: ${error.message}`,
        })
        .pipe(
          Effect.catchTag("IssueTrackerError", (handoffError) =>
            Effect.logWarning("could not hand off failed admission", {
              workspace: workspace.config.name,
              item: item.id,
              error: handoffError,
            }),
          ),
        );
    }
    return null;
  });

  const execute = Effect.fn("Executor.execute")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    observation: RunPlanObservation,
  ) {
    if (isStalledFollowUp(item.stage, item.followUp)) {
      const admission = yield* claimEnabledItem(workspace, item);
      if (!admission.claimed) return false;
      return yield* handoffClaimedStalled(workspace, item);
    }
    const checked = yield* operationResolution.inspect(workspace, item.stage);
    if (!checked.resolved || !checked.availability.available) {
      return yield* decline(workspace, item, checked.availability.causes);
    }
    const operation = checked.resolved;
    const admission = yield* claimEnabledItem(workspace, item);
    if (!admission.claimed) return false;
    const admitted = yield* refreshWorkContext(workspace, item).pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : releaseClaim(workspace, item.id))),
      Effect.matchEffect({
        onFailure: (error) => rejectAdmission(workspace, item, operation, error),
        onSuccess: (admittedItem) => Effect.succeed(admittedItem),
      }),
    );
    if (admitted === null) return false;
    yield* admissionCooldowns.clear(claimScope(workspace, item));
    return yield* runClaimed(workspace, admitted, operation, admission.startedAtMillis, observation).pipe(
      Effect.map(() => true),
      Effect.tap(() => releaseClaim(workspace, item.id)),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || hasInterruptsOnly(exit) ? Effect.void : releaseClaim(workspace, item.id),
      ),
    );
  });

  const runClaimed = Effect.fn("Executor.runClaimed")(function* (
    workspace: RegisteredWorkspace,
    item: AdmittedWork,
    operation: ResolvedOperation,
    startedAtMillis: number,
    observation: RunPlanObservation,
  ) {
    const runId = yield* nextRunId();
    type PreparationFailure = Effect.Error<ReturnType<typeof runPreparation.prepare>>;
    const correlation = {
      workspace: workspace.config.name,
      item: item.id,
      stage: item.stage,
      runId,
    };
    const acceptPreparedRun = Effect.fn("Executor.acceptPreparedRun")(function* (prepared: PreparedRun) {
      const accepted = yield* acceptEnabledHarnessRun(runId, workspace, item, startedAtMillis, prepared).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            reportFailure(
              workspace,
              item,
              error,
              prepared.failureSession?.harness ?? prepared.operation.stage.harness,
              sessionHandle(prepared.failureSession),
              prepared.checkoutPath,
            ).pipe(Effect.map(() => null)),
          onSuccess: Effect.succeed,
        }),
      );
      return accepted;
    });
    const settleAcceptedRun = Effect.fn("Executor.settleAcceptedRun")(function* (
      accepted: AcceptedRun | null,
    ) {
      if (!accepted) return;
      return yield* settleOutcome(workspace, item, accepted);
    });
    const reportPreparationFailure = Effect.fn("Executor.reportPreparationFailure")(function* ({
      error,
      session,
      checkoutPath,
    }: PreparationFailure) {
      if (error._tag === "OperationUnavailable") {
        yield* noteUnavailableResume(workspace, item, error.availability.causes);
        return null;
      }
      yield* reportUnpreparedFailure(
        workspace,
        item,
        error,
        session?.harness ?? operation.stage.harness,
        sessionHandle(session),
        checkoutPath,
      );
      return null;
    });
    return yield* runControl.run(
      runId,
      workspace,
      worktrees.withRunOwnershipLock(
        runPreparation
          .prepare({
            runId,
            workspace,
            item,
            operation,
            startedAtMillis,
            observation,
          })
          .pipe(
            Effect.matchEffect({
              onFailure: reportPreparationFailure,
              onSuccess: acceptPreparedRun,
            }),
            Effect.onInterrupt(() => releaseClaim(workspace, item.id)),
            Effect.flatMap(settleAcceptedRun),
            Effect.ensuring(cleanupRunContext(runId)),
            Effect.annotateLogs(correlation),
            Effect.annotateSpans(correlation),
          ),
      ),
      releaseClaim(workspace, item.id),
    );
  });

  const noteUnavailableResume = Effect.fn("Executor.noteUnavailableResume")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    causes: ReadonlyArray<AvailabilityCause>,
  ) {
    if (!item.recovery && !item.resume) return;
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
  });

  const decline = Effect.fn("Executor.decline")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    causes: ReadonlyArray<AvailabilityCause>,
  ) {
    if (item.recovery || item.resume) {
      yield* noteUnavailableResume(workspace, item, causes);
      yield* releaseClaim(workspace, item.id);
    }
    return false;
  });

  return { execute };
});

export class Executor extends Context.Service<Executor, Effect.Success<typeof make>>()(
  "@cogwork/engine/executor",
) {}

export const layer = Layer.effect(Executor, make).pipe(
  Layer.provide(OperationResolution.layer),
  Layer.provide(Availability.layer),
);
