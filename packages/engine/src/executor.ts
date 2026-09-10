import { randomUUID } from "node:crypto";
import type {
  AvailabilityCause,
  HarnessName,
  RunPlanObservation,
  RunRecord,
  Session,
  SessionId,
  StageResult,
  TokenUsage,
} from "@cogwork/contracts";
import {
  AgUiEvent,
  agUiIsSessionHandleEvent,
  agUiIsStructuredOutputComplete,
  decodeStageResultCompletion,
  ImplementStageResult,
  issueTrackerErrorIsPermanent,
  type LifecycleStage,
  RunId,
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
import type { EligibleWork } from "./classify";
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
import { isExhausted } from "./exhaustion";
import { type FollowUpContext, isStalledFollowUp, noProgressAfterRound } from "./follow-up";
import type { GitError } from "./git";
import { Harness, HarnessError, type HarnessRequest, type HarnessRunnerEnv } from "./harness";
import { IssueTracker, type IssueTrackerError, releaseClaim as makeReleaseClaim } from "./issue-tracker";
import * as OperationResolution from "./operation-resolution";
import {
  buildContinuationNudge,
  buildFollowUpPrompt,
  buildImplementPrompt,
  buildTriagePrompt,
  OperationOutcome,
  type OperationOutcomeTable,
} from "./playbook";
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
import type { ResolvedOperation, ResolvedStage } from "./run-plan";
import { RunRecorder } from "./run-recorder";
import { SessionChoice } from "./session-choice";
import { SessionStore } from "./session-store";
import { type OpenedPullRequest, SourceControlProvider } from "./source-control";
import { branchName, PullRequestReadiness, WorktreeManager } from "./worktree";

export const harnessEventFoldDuration = Metric.timer("cogwork_harness_event_fold_duration", {
  description: "Time to fold one harness event into Run state.",
});

const isReplayHarness = (harness: HarnessName) => harness === "replay";

interface RunAccumulator {
  readonly handle: string | null;
  readonly usage: TokenUsage | null;
  readonly structuredOutputs: ReadonlyArray<unknown>;
  readonly deferredTerminal: AgUiEvent | null;
}

interface PreparedRun {
  readonly checkoutPath: string;
  readonly session: SessionId | null;
  readonly prompt: string;
  readonly worktreeRecreated?: boolean;
  readonly resumeCandidate?: PreparedResumeCandidate;
}

interface PreparedResumeCandidate {
  readonly session: Session | null;
  readonly lastRunStartedAtMillis: number | null;
  readonly lastRunTotalTokens: number | null;
  readonly worktreeRecreated: boolean;
  readonly fresh: boolean;
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

// A best-guess estimate undercounts the real transcript, so it must never trip the
// resume token cap — only metered usage from the harness can gate the resume decision.
export const meteredTotalTokens = (usage: TokenUsage | null | undefined) =>
  usage && !usage.estimated ? (usage.totalTokens ?? null) : null;

interface StageOps {
  readonly resolved: ResolvedStage;
  readonly planStage: ResolvedOperation;
  readonly branch: string | null;
  readonly prepare: Effect.Effect<PreparedRun, PrepareError>;
  readonly fullPrompt: string;
  readonly resumePolicy: boolean;
}

declare const emptyClaimDisposition: unique symbol;
type EmptyClaimDisposition = { readonly [emptyClaimDisposition]?: never };

type ClaimDisposition = Data.TaggedEnum<{
  Release: EmptyClaimDisposition;
  Hold: EmptyClaimDisposition;
}>;

const ClaimDisposition = Data.taggedEnum<ClaimDisposition>();

class SessionRestarted extends Data.TaggedError("SessionRestarted")<Record<string, never>> {}

const defaultFollowUp: FollowUpContext = {
  checks: "pending",
  humanCommentAtMillis: 0,
  botTriggerAtMillis: 0,
  noProgress: 0,
  stalled: false,
  fresh: false,
  baseDivergence: "none",
};

const resumeWorktreeOptions = (item: EligibleWork) => {
  if (item.stage === "follow-up" && item.followUpBranch) {
    return { resume: true, branch: item.followUpBranch };
  }
  return { resume: true };
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
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const worktrees = yield* WorktreeManager;
  const operationResolution = yield* OperationResolution.OperationResolution;
  const runControl = yield* RunControl;
  const sourceControl = yield* SourceControlProvider;
  const contextAssembler = yield* ContextAssembler;
  const controlStore = yield* ControlStore;
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

  const latestResumableBranchRun = (workspace: RegisteredWorkspace, branch: string) =>
    Effect.all([
      ledger.sessionForBranch(workspace.config.name, branch),
      ledger.latestRunByBranch(workspace.config.name, branch),
    ]).pipe(Effect.map(([session, run]) => (session === run?.session ? run : null)));

  const candidateSession = (workspace: RegisteredWorkspace, item: EligibleWork, branch: string | null) => {
    const resumedSession = item.resume?.session;
    if (resumedSession) return Effect.succeed(resumedSession);
    if (!branch) return Effect.succeed(null);
    return latestResumableBranchRun(workspace, branch).pipe(Effect.map((run) => run?.session ?? null));
  };

  const logSessionChoice = Effect.fn("Executor.logSessionChoice")(function* (
    ops: StageOps,
    session: Session | null,
    choice: SessionChoice,
  ) {
    if (!session) return;
    if (session.harness !== ops.resolved.harness) {
      yield* Effect.logInfo("started fresh after harness switch", {
        ...(ops.branch ? { branch: ops.branch } : {}),
        oldHarness: session.harness,
        newHarness: ops.resolved.harness,
      });
      return;
    }
    if (!SessionChoice.$is("Combined")(choice)) return;
    yield* Effect.logInfo("started fresh after Sandbox lineage was recreated", {
      ...(ops.branch ? { branch: ops.branch } : {}),
      harness: session.harness,
    });
  });

  const loadSessionChoiceCandidate = Effect.fn("Executor.loadSessionChoiceCandidate")(function* (
    ops: StageOps,
    prepared: PreparedRun,
    previous: SessionId | null,
  ) {
    if (prepared.session) return yield* ledger.getSession(prepared.session);
    if (ops.resumePolicy) return prepared.resumeCandidate?.session ?? null;
    if (!previous) return null;
    return yield* ledger.getSession(previous);
  });

  const resolveCandidate = Effect.fn("Executor.resolveCandidate")(function* (
    runId: RunId,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    prepared: PreparedRun,
    startedAtMillis: number,
    previous: SessionId | null,
    observation: RunPlanObservation,
  ) {
    const candidate = prepared.resumeCandidate;
    const preparedSession = yield* loadSessionChoiceCandidate(ops, prepared, previous);
    const accepted = yield* operationResolution.resolve({
      runId,
      workspace,
      item,
      observation,
      checkoutPath: prepared.checkoutPath,
      continuationPrompt: prepared.prompt,
      startedAtMillis,
      sessionChoice: {
        session: preparedSession,
        lastRunStartedAtMillis: candidate?.lastRunStartedAtMillis ?? null,
        lastRunTotalTokens: candidate?.lastRunTotalTokens ?? null,
        worktreeRecreated: candidate?.worktreeRecreated ?? prepared.worktreeRecreated ?? false,
        fresh: candidate?.fresh ?? false,
        applyResumePolicy:
          ops.resumePolicy && prepared.session === null && prepared.resumeCandidate !== undefined,
      },
    });
    const selectedOps = stageOps(workspace, item, accepted.resolved);
    yield* logSessionChoice(selectedOps, preparedSession, accepted.sessionChoice);
    return {
      request: {
        plan: accepted.plan,
        session: accepted.session,
        mcpCredentials: accepted.mcpCredentials,
      } satisfies HarnessRequest,
      session: accepted.session,
      plan: accepted.plan,
      selectedOps,
    };
  });

  const claimScope = (workspace: RegisteredWorkspace, item: EligibleWork) =>
    `${workspace.config.name}:${item.id}:${item.stage}`;

  const holdOffClaim = Effect.fn("Executor.holdOffClaim")(function* (
    scope: string,
    item: EligibleWork,
    error: IssueTrackerError,
  ) {
    const { retryAtMillis } = yield* claimCooldowns.enter(scope, error.retryAfterMillis);
    yield* Effect.logWarning("claim failed; holding this item off until the window expires", {
      stage: item.stage,
      item: item.id,
      retryAtMillis,
      error,
    });
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
    yield* holdOffClaim(scope, item, error);
    if (issueTrackerErrorIsPermanent(error)) yield* parkRefusedClaim(workspace, item, error);
    return false;
  });

  const tryClaim = Effect.fn("Executor.tryClaim")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    at: number,
  ) {
    const scope = claimScope(workspace, item);
    if ((yield* claimCooldowns.heldUntil(scope)) !== null) return false;
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
    const budget = defaultRunBudget(request.plan.operation);
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
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    const attempts = item.priorFailures + 1;
    const { retryable, handoffCause } = decision;
    const exhausted = !retryable || isExhausted(attempts);
    yield* Effect.logWarning("stage attempt failed", {
      reason,
      retryable,
      exhausted,
    });
    yield* issueTracker.attemptFailed(workspace, item.id, {
      stage: item.stage,
      atMillis: endedAtMillis,
      reason,
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
        }),
      });
    }
    return {
      status: exhausted ? "exhausted" : "failed",
      usage: null,
      endedAtMillis,
    } satisfies RunUpdate;
  });

  const reportFailure = (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    failure: RetryFailure,
    harnessName: HarnessName,
    handle: string | null,
  ) =>
    reportDecidedFailure(
      workspace,
      item,
      decideRetry({ failure, attempts: item.priorFailures + 1 }),
      prepareFailureReason(failure),
      harnessName,
      handle,
    );

  const applyFailure = Effect.fn("Executor.applyFailure")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    failure: RetryFailure,
    harnessName: HarnessName,
    handle: string | null,
  ) {
    return yield* settleReportedFailure(runId, reportFailure(workspace, item, failure, harnessName, handle));
  });

  const settleReportedFailure = (runId: RunId, reported: Effect.Effect<RunUpdate, IssueTrackerError>) =>
    reported.pipe(
      Effect.tapError(() =>
        Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
          settleRun(runId, { status: "failed", usage: null, endedAtMillis }),
        ),
      ),
      Effect.flatMap((update) => settleRun(runId, update)),
      Effect.map(() => ClaimDisposition.Release({})),
    );

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

  const prepareImplement = Effect.fn("Executor.prepareImplement")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    prompt: string,
  ) {
    const worktree = yield* worktrees.ensure(workspace, item);
    return { checkoutPath: worktree.path, prompt, session: null } satisfies PreparedRun;
  });

  const triageOps = (workspace: RegisteredWorkspace, item: EligibleWork, planStage: ResolvedOperation) => {
    const resolved = planStage.stage;
    const fullPrompt = buildTriagePrompt(resolved, item);
    return {
      resolved,
      planStage,
      branch: null,
      prepare: Effect.succeed({
        checkoutPath: workspace.config.checkoutPath,
        prompt: fullPrompt,
        session: null,
      }),
      fullPrompt,
      resumePolicy: false,
    } satisfies StageOps;
  };

  const implementOps = (workspace: RegisteredWorkspace, item: EligibleWork, planStage: ResolvedOperation) => {
    const resolved = planStage.stage;
    const branch = branchName(item);
    const fullPrompt = buildImplementPrompt(resolved, item);
    return {
      resolved,
      planStage,
      branch,
      prepare: prepareImplement(workspace, item, fullPrompt),
      fullPrompt,
      resumePolicy: false,
    } satisfies StageOps;
  };

  const followUpMarker = (context: FollowUpContext, noProgress: number) => ({
    checks: context.checks,
    humanCommentAtMillis: context.humanCommentAtMillis,
    botTriggerAtMillis: context.botTriggerAtMillis,
    noProgress,
    baseDivergence: context.baseDivergence,
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

  const prepareFollowUp = Effect.fn("Executor.prepareFollowUp")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    branch: string,
    context: FollowUpContext,
    prompt: string,
  ) {
    const worktree = yield* worktrees.ensure(workspace, item, { branch });
    const last = yield* latestResumableBranchRun(workspace, branch);
    const session = last?.session ? yield* ledger.getSession(last.session) : null;
    return {
      checkoutPath: worktree.path,
      prompt,
      session: null,
      resumeCandidate: {
        session,
        lastRunStartedAtMillis: last?.startedAtMillis ?? null,
        lastRunTotalTokens: meteredTotalTokens(last?.usage),
        worktreeRecreated: worktree.created,
        fresh: context.fresh,
      },
    } satisfies PreparedRun;
  });

  const followUpOps = (workspace: RegisteredWorkspace, item: EligibleWork, planStage: ResolvedOperation) => {
    const resolved = planStage.stage;
    const branch = item.followUpBranch ?? branchName(item);
    const context = item.followUp ?? defaultFollowUp;
    const fullPrompt = buildFollowUpPrompt(resolved, item, workspace.config.linearHistory);
    return {
      resolved,
      planStage,
      branch,
      prepare: prepareFollowUp(workspace, item, branch, context, fullPrompt),
      fullPrompt,
      resumePolicy: true,
    } satisfies StageOps;
  };

  const outcomeForResult = (table: OperationOutcomeTable, result: string) =>
    table.outcomes.find((outcome) => outcome.result === result) ?? null;

  const decodeOperationOutcome = (stage: LifecycleStage, table: OperationOutcomeTable, acc: RunAccumulator) =>
    expectSingleStructuredResult(stage, acc).pipe(
      Effect.flatMap((input) => decodeStageResultCompletion(stage, input)),
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
    summary: string,
    outcome: Extract<OperationOutcome, { readonly _tag: "FollowedUp" }>,
    atMillis: number,
  ) {
    yield* postFollowUpSummary(workspace, item, summary);
    const context = item.followUp ?? defaultFollowUp;
    yield* issueTracker.followedUp(workspace, item.id, {
      marker: followUpMarker(context, noProgressAfterRound(context, outcome.result)),
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
    return ClaimDisposition.Release({});
  });

  const existingPullRequestReadiness = (headBranch: string, pull: OpenedPullRequest | null) =>
    pull
      ? PullRequestReadiness.Declined({
          reason: `open pull request #${pull.number} already exists for ${headBranch}`,
        })
      : null;

  const pullRequestReadiness = Effect.fn("Executor.pullRequestReadiness")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const readiness = yield* worktrees.pullRequestReadiness(workspace, item);
    return yield* PullRequestReadiness.$match(readiness, {
      Declined: (declined) => Effect.succeed(declined),
      Ready: (ready) =>
        sourceControl
          .findOpenPullRequest(workspace, ready.headBranch)
          .pipe(Effect.map((existing) => existingPullRequestReadiness(ready.headBranch, existing) ?? ready)),
    });
  });

  const declinePullRequest = Effect.fn("Executor.declinePullRequest")(function* (
    runId: RunId,
    acc: RunAccumulator,
    reason: string,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* Effect.logWarning("pull request gate declined", { reason });
    yield* settleRun(runId, {
      status: "failed",
      usage: acc.usage,
      endedAtMillis,
      claimDisposition: "hold",
    });
    return ClaimDisposition.Hold({});
  });

  const applyPullRequestFailure = Effect.fn("Executor.applyPullRequestFailure")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    record: RunRecord,
    acc: RunAccumulator,
    error: GitError | IssueTrackerError,
  ) {
    return yield* applyFailure(workspace, item, record.id, error, record.harness, acc.handle);
  });

  const openPullRequest = Effect.fn("Executor.openPullRequest")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    record: RunRecord,
    acc: RunAccumulator,
    result: StageResult,
  ) {
    if (!ImplementStageResult.guards["ready-for-pr"](result)) {
      return yield* applyFailure(
        workspace,
        item,
        record.id,
        structuredResultError("ready-for-pr outcome has no pull request content"),
        record.harness,
        acc.handle,
      );
    }
    return yield* pullRequestReadiness(workspace, item).pipe(
      Effect.matchEffect({
        onFailure: (error) => applyPullRequestFailure(workspace, item, record, acc, error),
        onSuccess: (readiness) =>
          PullRequestReadiness.$match(readiness, {
            Declined: ({ reason }) => declinePullRequest(record.id, acc, reason),
            Ready: ({ headBranch, baseBranch }) =>
              sourceControl
                .openPullRequest(workspace, {
                  headBranch,
                  baseBranch,
                  title: result.title,
                  body: result.body,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) => applyPullRequestFailure(workspace, item, record, acc, error),
                    onSuccess: () =>
                      applySuccessfulOutcome(record, acc, (atMillis) =>
                        applyImplemented(workspace, item, atMillis),
                      ),
                  }),
                ),
          }),
      }),
    );
  });

  const retryableOperationDecision = (attempts: number) =>
    ({ retryable: true, handoffCause: { kind: "max-attempts", attempts } }) satisfies RetryDecision;

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
    record: RunRecord,
    acc: RunAccumulator,
    detail: string,
    outcome: Extract<OperationOutcome, { readonly _tag: "Failed" }>,
  ) {
    return yield* settleReportedFailure(
      record.id,
      reportDecidedFailure(
        workspace,
        item,
        operationDecision(outcome, item.priorFailures + 1),
        detail,
        record.harness,
        acc.handle,
      ),
    );
  });

  const applyOperationOutcome = Effect.fn("Executor.applyOperationOutcome")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    record: RunRecord,
    acc: RunAccumulator,
    detail: string,
    outcome: OperationOutcome,
    result: StageResult,
  ) {
    return yield* OperationOutcome.$match(outcome, {
      Failed: (outcome) => applyOperationFailure(workspace, item, record, acc, detail, outcome),
      FollowedUp: (outcome) =>
        applySuccessfulOutcome(record, acc, (atMillis) =>
          applyFollowedUp(workspace, item, detail, outcome, atMillis),
        ),
      Implemented: () =>
        applySuccessfulOutcome(record, acc, (atMillis) => applyImplemented(workspace, item, atMillis)),
      PullRequestReady: () => openPullRequest(workspace, item, record, acc, result),
      Triaged: (outcome) =>
        applySuccessfulOutcome(record, acc, (atMillis) =>
          applyTriaged(workspace, item, detail, outcome, atMillis),
        ),
    });
  });

  const completeOperation = Effect.fn("Executor.completeOperation")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    record: RunRecord,
    acc: RunAccumulator,
  ) {
    const recordCompletionTerminal = (status: "failed" | "succeeded") => {
      if (item.stage !== "triage") return Effect.succeed(null);
      if (status === "failed") return recorder.record(record, failedTerminal);
      return recorder.record(record, acc.deferredTerminal ?? { type: "RUN_FINISHED", finishReason: "stop" });
    };
    return yield* decodeOperationOutcome(item.stage, ops.resolved.outcomeTable, acc).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          recordCompletionTerminal("failed").pipe(
            Effect.andThen(applyFailure(workspace, item, record.id, error, record.harness, acc.handle)),
          ),
        onSuccess: ({ detail, outcome, result }) =>
          recordCompletionTerminal("succeeded").pipe(
            Effect.andThen(applyOperationOutcome(workspace, item, record, acc, detail, outcome, result)),
          ),
      }),
    );
  });

  const handoffStalled = Effect.fn("Executor.handoffStalled")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const atMillis = yield* Clock.currentTimeMillis;
    const context = item.followUp ?? defaultFollowUp;
    // The count is spent the moment the hand-off lands: a human owns the PR now, and while it wears
    // `ready-for-human` no poll can reach a follow-up round to move the count again. Parking it at 0
    // makes the hand-off a door that opens both ways — whoever hands it back, by any route, gets a
    // fresh three rounds instead of an item that claims and abandons in the same breath. The detail
    // still reports the count that parked it.
    yield* issueTracker.stalled(workspace, item.id, {
      marker: followUpMarker(context, 0),
      atMillis,
      detail: `Follow-up made no progress after ${context.noProgress} attempts — neither the checks turned green nor a human responded. Handing this to a human.`,
    });
  });

  const resumePrepare = Effect.fn("Executor.resumePrepare")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    session: SessionId,
  ) {
    if (item.stage === "triage") {
      const path = workspace.config.checkoutPath;
      return { checkoutPath: path, prompt: buildContinuationNudge(path), session } satisfies PreparedRun;
    }
    const worktree = yield* worktrees.ensure(workspace, item, resumeWorktreeOptions(item));
    return {
      checkoutPath: worktree.path,
      prompt: buildContinuationNudge(worktree.path),
      session,
      worktreeRecreated: worktree.created,
    } satisfies PreparedRun;
  });

  const freshRecoveryPrepare = Effect.fn("Executor.freshRecoveryPrepare")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    prompt: string,
  ) {
    if (item.stage === "triage") {
      return { checkoutPath: workspace.config.checkoutPath, prompt, session: null } satisfies PreparedRun;
    }
    const worktree = yield* worktrees.ensure(workspace, item, resumeWorktreeOptions(item));
    return { checkoutPath: worktree.path, prompt, session: null } satisfies PreparedRun;
  });

  const plannedStageOps = (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    planStage: ResolvedOperation,
  ) => {
    if (item.stage === "implement") return implementOps(workspace, item, planStage);
    if (item.stage === "follow-up") return followUpOps(workspace, item, planStage);
    return triageOps(workspace, item, planStage);
  };

  const stageOps = (workspace: RegisteredWorkspace, item: EligibleWork, planStage: ResolvedOperation) => {
    const ops = plannedStageOps(workspace, item, planStage);
    if (!isReplayHarness(ops.resolved.harness)) return ops;
    return {
      ...ops,
      branch: null,
      prepare: Effect.succeed({
        checkoutPath: workspace.config.checkoutPath,
        prompt: ops.fullPrompt,
        session: null,
      }),
    } satisfies StageOps;
  };

  const opsFor = (workspace: RegisteredWorkspace, item: EligibleWork, planStage: ResolvedOperation) => {
    const ops = stageOps(workspace, item, planStage);
    if (isReplayHarness(ops.resolved.harness)) return ops;
    const session = item.resume?.session;
    if (!session) return ops;
    return {
      ...ops,
      prepare: resumePrepare(workspace, item, session),
    } satisfies StageOps;
  };

  const freshRecoveryOps = (workspace: RegisteredWorkspace, item: EligibleWork, ops: StageOps) => {
    const fresh = stageOps(workspace, item, ops.planStage);
    if (!item.resume) return fresh;
    return {
      ...fresh,
      prepare: freshRecoveryPrepare(workspace, item, fresh.fullPrompt),
    } satisfies StageOps;
  };

  const settleOutcome = Effect.fn("Executor.settleOutcome")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    record: RunRecord,
    runId: RunId,
    request: HarnessRequest,
  ) {
    const recordEncodingFailureTerminal = (error: PrepareError | HarnessError) => {
      if (error._tag !== "RunLedgerError" || error.operation !== encodeRunEventOperation) {
        return Effect.succeed(null);
      }
      return recorder.record(record, failedTerminal);
    };

    const settleFailure = (error: PrepareError | HarnessError) =>
      recordEncodingFailureTerminal(error).pipe(
        Effect.andThen(handleOf(ledger, record.session)),
        Effect.flatMap((handle) => applyFailure(workspace, item, runId, error, ops.resolved.harness, handle)),
      );

    const settleCompletionFailure = (error: RunLedgerError) => {
      if (error.operation === encodeRunEventOperation) return settleFailure(error);
      return Effect.fail(error);
    };

    const settle = <A, R>(
      attempt: Effect.Effect<A, PrepareError | HarnessError, R>,
      complete: (acc: A) => Effect.Effect<ClaimDisposition, IssueTrackerError | RunLedgerError>,
    ) =>
      attempt.pipe(
        Effect.matchEffect({
          onFailure: settleFailure,
          onSuccess: (acc) => complete(acc).pipe(Effect.catchTag("RunLedgerError", settleCompletionFailure)),
        }),
      );

    const settleRecordedRun = (status: "failed" | "succeeded", usage: TokenUsage | null) =>
      Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
        settleRun(runId, { status, usage, endedAtMillis }),
      );

    const settleRecorded = <R>(attempt: Effect.Effect<RunAccumulator, PrepareError | HarnessError, R>) =>
      attempt.pipe(
        Effect.matchEffect({
          onFailure: () => settleRecordedRun("failed", null),
          onSuccess: (acc) => settleRecordedRun("succeeded", acc.usage),
        }),
      );

    if (isReplayHarness(record.harness)) {
      yield* settleRecorded(foldHarness(record, request, false));
      return ClaimDisposition.Release({});
    }
    return yield* settle(foldHarness(record, request, item.stage === "triage"), (acc) =>
      completeOperation(workspace, item, ops, record, acc),
    );
  });

  const acceptPlannedRun = Effect.fn("Executor.acceptPlannedRun")(function* (
    runId: RunId,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    startedAtMillis: number,
    planned: Effect.Success<ReturnType<typeof resolveCandidate>>,
  ) {
    const record: RunRecord = {
      id: runId,
      workspace: workspace.config.name,
      workItem: item.id,
      stage: item.stage,
      harness: planned.selectedOps.resolved.harness,
      branch: planned.selectedOps.branch,
      session: planned.session,
      usage: null,
      status: "running",
      startedAtMillis,
      endedAtMillis: null,
    };
    yield* ledger.acceptRun(record, planned.plan);
    return { ...planned, record };
  });

  const acceptEnabledHarnessRun = Effect.fn("Executor.acceptEnabledHarnessRun")(function* (
    runId: RunId,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    startedAtMillis: number,
    planned: Effect.Success<ReturnType<typeof resolveCandidate>>,
  ) {
    const admission = yield* controlStore.withWrite(
      operationResolution
        .harnessCause(planned.selectedOps.resolved.harness)
        .pipe(
          Effect.flatMap((cause) =>
            admitHarness(cause, acceptPlannedRun(runId, workspace, item, startedAtMillis, planned)),
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
    const stageOps = opsFor(workspace, item, checked.resolved);
    const admission = yield* claimEnabledItem(workspace, item);
    if (!admission.claimed) return false;
    yield* runClaimed(workspace, item, stageOps, admission.startedAtMillis, observation).pipe(
      Effect.tap(
        ClaimDisposition.$match({
          Hold: () => Effect.void,
          Release: () => releaseClaim(workspace, item.id),
        }),
      ),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || hasInterruptsOnly(exit) ? Effect.void : releaseClaim(workspace, item.id),
      ),
    );
    return true;
  });

  const runClaimed = Effect.fn("Executor.runClaimed")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    startedAtMillis: number,
    observation: RunPlanObservation,
  ) {
    const runId = yield* nextRunId();
    const correlation = {
      workspace: workspace.config.name,
      item: item.id,
      stage: item.stage,
      runId,
    };
    const prepareAcceptedRun = Effect.fn("Executor.prepareAcceptedRun")(function* (
      previous: SessionId | null,
      prepared: PreparedRun,
      selectedOps: StageOps,
    ) {
      const planned = yield* resolveCandidate(
        runId,
        workspace,
        item,
        selectedOps,
        prepared,
        startedAtMillis,
        previous,
        observation,
      );
      return yield* acceptEnabledHarnessRun(runId, workspace, item, startedAtMillis, planned);
    });
    return yield* runControl.run(
      runId,
      workspace,
      candidateSession(workspace, item, ops.branch).pipe(
        Effect.flatMap((previous) => {
          const selectedOps: StageOps =
            previous === item.resume?.session ? ops : freshRecoveryOps(workspace, item, ops);
          return selectedOps.prepare.pipe(
            Effect.flatMap((prepared) => prepareAcceptedRun(previous, prepared, selectedOps)),
            Effect.onInterrupt(() => releaseClaim(workspace, item.id)),
            Effect.matchEffect({
              onFailure: (error) => {
                if (error._tag === "OperationUnavailable") {
                  return noteUnavailableResume(workspace, item, error.availability.causes).pipe(
                    Effect.map(() => ClaimDisposition.Release({})),
                  );
                }
                const storedSession = previous ? ledger.getSession(previous) : Effect.succeed(null);
                return storedSession.pipe(
                  Effect.flatMap((session) =>
                    reportFailure(
                      workspace,
                      item,
                      error,
                      session?.harness ?? selectedOps.resolved.harness,
                      sessionHandle(session),
                    ),
                  ),
                  Effect.map(() => ClaimDisposition.Release({})),
                );
              },
              onSuccess: (accepted) => {
                if (!accepted) return Effect.succeed(ClaimDisposition.Release({}));
                const { request, selectedOps: acceptedOps, record } = accepted;
                return settleOutcome(workspace, item, acceptedOps, record, runId, request);
              },
            }),
          );
        }),
        Effect.ensuring(cleanupRunContext(runId)),
        Effect.annotateLogs(correlation),
        Effect.annotateSpans(correlation),
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
