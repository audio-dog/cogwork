import type { LifecycleStage, RunRecord, SessionId, TokenUsage } from "@cogwork/contracts";
import {
  agUiIsStructuredOutputComplete,
  agUiTextDelta,
  agUiUsage,
  ImplementStageResult,
  RunId,
  StructuredOutputCompleteValue,
  sessionHandle,
  TriageStageResult,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type EligibleWork, maxAttemptsPerStage } from "./classify";
import {
  agentFailureReason,
  followUpNoteBody,
  handoffNote,
  prepareFailureReason,
  triageProposalBody,
} from "./comments";
import type { CredentialError } from "./credential-store";
import type { FollowUpContext } from "./follow-up";
import type { GitError } from "./git";
import { type AgUiEvent, Harness, HarnessError, type HarnessRequest } from "./harness";
import { IssueTracker, type IssueTrackerError, releaseClaim as makeReleaseClaim } from "./issue-tracker";
import { McpSkillAssembler } from "./mcp-skill";
import {
  buildContinuationNudge,
  buildFollowUpPrompt,
  buildImplementPrompt,
  buildTriagePrompt,
  parseFollowUpResult,
  type ResolvedStage,
  resolveStage,
} from "./playbook";
import type { RegisteredWorkspace } from "./projector";
import { decideResume } from "./resume-policy";
import { RunControl } from "./run-control";
import { handleOf, RunLedger, type RunUpdate } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { SourceControlProvider } from "./source-control";
import { branchName, type WorktreeDivergedError, WorktreeManager } from "./worktree";
import type { WorktreeFsError } from "./worktree-fs";

type PrepareError = GitError | WorktreeFsError | WorktreeDivergedError | CredentialError;

interface RunAccumulator {
  readonly text: string;
  readonly handle: string | null;
  readonly usage: TokenUsage | null;
  readonly structuredOutputs: ReadonlyArray<unknown>;
}

interface TriageAccumulator extends RunAccumulator {
  readonly structuredOutputs: ReadonlyArray<unknown>;
  readonly deferredTerminal: AgUiEvent | null;
}

const emptyAccumulator: RunAccumulator = {
  text: "",
  handle: null,
  usage: null,
  structuredOutputs: [],
};

const emptyTriageAccumulator: TriageAccumulator = {
  ...emptyAccumulator,
  structuredOutputs: [],
  deferredTerminal: null,
};

// A best-guess estimate undercounts the real transcript, so it must never trip the
// resume token cap — only metered usage from the harness can gate the resume decision.
export const meteredTotalTokens = (usage: TokenUsage | null | undefined) =>
  usage && !usage.estimated ? (usage.totalTokens ?? null) : null;

interface CommonStageOps {
  readonly resolved: ResolvedStage;
  readonly branch: string | null;
  readonly prepare: Effect.Effect<HarnessRequest, PrepareError>;
  readonly fullPrompt: string;
  readonly resume: boolean;
}

interface TriageStageOps extends CommonStageOps {
  readonly kind: "triage";
  readonly complete: (record: RunRecord, acc: TriageAccumulator) => Effect.Effect<void, IssueTrackerError>;
}

interface TextStageOps extends CommonStageOps {
  readonly kind: "text";
  readonly complete: (runId: RunId, acc: RunAccumulator) => Effect.Effect<void, IssueTrackerError>;
}

type StageOps = TriageStageOps | TextStageOps;

class SessionRestarted extends Data.TaggedError("SessionRestarted")<Record<string, never>> {}

const withFullPrompt = (request: HarnessRequest, prompt: string): HarnessRequest => ({
  ...request,
  prompt,
});

const defaultFollowUp: FollowUpContext = {
  checks: "pending",
  humanCommentAtMillis: 0,
  botTriggerAtMillis: 0,
  noProgress: 0,
  stalled: false,
  fresh: false,
  baseDivergence: "none",
};

const appendStructuredOutput = (acc: Pick<RunAccumulator, "structuredOutputs">, event: AgUiEvent) => {
  if (!agUiIsStructuredOutputComplete(event)) return acc.structuredOutputs;
  return [...acc.structuredOutputs, event.value];
};

const mergeEvent = (acc: RunAccumulator, event: AgUiEvent, handle: string | null): RunAccumulator => ({
  text: acc.text + agUiTextDelta(event),
  handle,
  usage: agUiUsage(event) ?? acc.usage,
  structuredOutputs: appendStructuredOutput(acc, event),
});

const mergeTriageEvent = (acc: TriageAccumulator, event: AgUiEvent, handle: string | null) =>
  ({
    ...mergeEvent(acc, event, handle),
    deferredTerminal: acc.deferredTerminal,
  }) satisfies TriageAccumulator;

const failedTerminal: AgUiEvent = { type: "RUN_FINISHED", finishReason: "failed" };
const successfulTerminal = (event: AgUiEvent) =>
  event.type === "RUN_FINISHED" && event.finishReason !== "failed";

const withFailureTerminal = (stream: Stream.Stream<AgUiEvent, HarnessError>) =>
  Stream.catchCause(stream, (cause) =>
    Stream.concat(Stream.succeed(failedTerminal), Stream.failCause(cause)),
  );

// A credential error is a configuration problem (no account, missing secret env) that retrying
// cannot fix, so it goes straight to a human like a diverged worktree does.
const nonRetryablePrepare = new Set(["WorktreeDivergedError", "CredentialError"]);

const retryableOf = (error: PrepareError | HarnessError) => {
  if (error._tag === "HarnessError") return error.retryable;
  return !nonRetryablePrepare.has(error._tag);
};

const handoffCause = (retryable: boolean, attempts: number) =>
  retryable ? ({ kind: "max-attempts", attempts } as const) : ({ kind: "non-retryable" } as const);

const decodeRunId = Schema.decodeUnknownEffect(RunId);

export const make = Effect.gen(function* () {
  const issueTracker = yield* IssueTracker;
  const harness = yield* Harness;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const worktrees = yield* WorktreeManager;
  const assembler = yield* McpSkillAssembler;
  const runControl = yield* RunControl;
  const sessionStore = yield* SessionStore;
  const sourceControl = yield* SourceControlProvider;
  const releaseClaim = makeReleaseClaim(issueTracker);
  const runCounter = yield* Ref.make(0);

  const harnessRequest = Effect.fn("Executor.harnessRequest")(function* (
    workspace: RegisteredWorkspace,
    resolved: ResolvedStage,
    checkoutPath: string,
    prompt: string,
    session: SessionId | null,
    stage: LifecycleStage,
  ) {
    return {
      harness: resolved.harness,
      stage,
      skill: resolved.skill,
      checkoutPath,
      session,
      prompt,
      model: resolved.model,
      effort: resolved.effort,
      mcpSkills: yield* assembler.assemble(workspace.config),
    } satisfies HarnessRequest;
  });

  const nextRunId = (startedAtMillis: number) =>
    Ref.getAndUpdate(runCounter, (n) => n + 1).pipe(
      Effect.flatMap((n) => decodeRunId(`run-${startedAtMillis}-${n}`)),
      Effect.orDie,
    );

  const resolveSession = Effect.fn("Executor.resolveSession")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    startedAtMillis: number,
  ) {
    if (item.resume) return item.resume.session;
    const existing = ops.branch ? yield* ledger.sessionForBranch(workspace.config.name, ops.branch) : null;
    if (existing) return existing;
    return yield* sessionStore.mint(
      { workspace: workspace.config.name, harness: ops.resolved.harness, createdAtMillis: startedAtMillis },
      harness.sessionKind,
    );
  });

  const tryClaim = Effect.fn("Executor.tryClaim")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    at: number,
  ) {
    const result = yield* Effect.result(
      issueTracker.claim(workspace, item.id, { claimedAtMillis: at, stage: item.stage }),
    );
    if (Result.isSuccess(result)) return true;
    yield* Effect.logWarning("claim failed", { stage: item.stage, item: item.id, error: result.failure });
    return false;
  });

  const settleRun = (runId: RunId, update: RunUpdate) => ledger.updateRun(runId, update);

  const foldEvent = Effect.fn("Executor.foldEvent")(function* (
    record: RunRecord,
    acc: RunAccumulator,
    event: AgUiEvent,
  ) {
    const handle = yield* recorder.record(record, event);
    return mergeEvent(acc, event, handle);
  });

  const foldTriageEvent = Effect.fn("Executor.foldTriageEvent")(function* (
    record: RunRecord,
    acc: TriageAccumulator,
    event: AgUiEvent,
  ) {
    if (successfulTerminal(event)) {
      return { ...mergeTriageEvent(acc, event, acc.handle), deferredTerminal: event };
    }
    const handle = yield* recorder.record(record, event);
    return mergeTriageEvent(acc, event, handle);
  });

  const foldStream = <A, E, R>(
    request: HarnessRequest,
    initial: A,
    step: (acc: A, event: AgUiEvent) => Effect.Effect<A, E, R>,
  ) => Stream.runFoldEffect(withFailureTerminal(harness.run(request)), () => initial, step);

  const foldRun = (record: RunRecord, request: HarnessRequest) =>
    foldStream(request, emptyAccumulator, (acc, event) => foldEvent(record, acc, event));

  const foldTriageRun = (record: RunRecord, request: HarnessRequest) =>
    foldStream(request, emptyTriageAccumulator, (acc, event) => foldTriageEvent(record, acc, event));

  const guardResume = <A extends RunAccumulator>(prev: A, next: A, expected: string) =>
    prev.handle === null && next.handle !== null && next.handle !== expected
      ? Effect.fail(new SessionRestarted({}))
      : Effect.succeed(next);

  const foldResume = (record: RunRecord, request: HarnessRequest, expected: string) =>
    foldStream(request, emptyAccumulator, (acc, event) =>
      foldEvent(record, acc, event).pipe(Effect.flatMap((next) => guardResume(acc, next, expected))),
    );

  const foldTriageResume = (record: RunRecord, request: HarnessRequest, expected: string) =>
    foldStream(request, emptyTriageAccumulator, (acc, event) =>
      foldTriageEvent(record, acc, event).pipe(Effect.flatMap((next) => guardResume(acc, next, expected))),
    );

  const foldOutcome = Effect.fn("Executor.foldOutcome")(function* (
    record: RunRecord,
    ops: CommonStageOps,
    request: HarnessRequest,
  ) {
    const expected = ops.resume ? yield* handleOf(ledger, request.session) : null;
    if (!expected) return yield* foldRun(record, request);
    return yield* foldResume(record, request, expected).pipe(
      Effect.catchTag("SessionRestarted", () => foldRun(record, withFullPrompt(request, ops.fullPrompt))),
    );
  });

  const foldTriageOutcome = Effect.fn("Executor.foldTriageOutcome")(function* (
    record: RunRecord,
    ops: TriageStageOps,
    request: HarnessRequest,
  ) {
    const expected = ops.resume ? yield* handleOf(ledger, request.session) : null;
    if (!expected) return yield* foldTriageRun(record, request);
    return yield* foldTriageResume(record, request, expected).pipe(
      Effect.catchTag("SessionRestarted", () =>
        foldTriageRun(record, withFullPrompt(request, ops.fullPrompt)),
      ),
    );
  });

  const applyFailure = Effect.fn("Executor.applyFailure")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    retryable: boolean,
    reason: string,
    handle: string | null,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    const attempts = item.priorFailures + 1;
    const exhausted = !retryable || attempts >= maxAttemptsPerStage;
    yield* Effect.logWarning("stage attempt failed", {
      stage: item.stage,
      item: item.id,
      reason,
      retryable,
      exhausted,
    });
    yield* issueTracker.attemptFailed(workspace, item.id, {
      stage: item.stage,
      atMillis: endedAtMillis,
      reason,
    });
    if (exhausted) {
      yield* issueTracker.handOff(workspace, item.id, {
        stage: item.stage,
        note: handoffNote({
          workspace,
          item,
          stage: item.stage,
          cause: handoffCause(retryable, attempts),
          reason,
          session: handle,
        }),
      });
    }
    yield* settleRun(runId, {
      status: exhausted ? "exhausted" : "failed",
      usage: null,
      endedAtMillis,
    });
  });

  const applyTriageSuccess = Effect.fn("Executor.applyTriageSuccess")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
    result: TriageStageResult,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* issueTracker.triaged(workspace, item.id, {
      role: result.role,
      proposal: triageProposalBody(result.proposal),
      atMillis: endedAtMillis,
    });
    yield* settleRun(runId, {
      status: "succeeded",
      usage: acc.usage,
      endedAtMillis,
    });
  });

  const structuredTriageError = (message: string) =>
    new HarnessError({ reason: "turn", retryable: true, message });

  const TriageCompletion = Schema.Struct({
    ...StructuredOutputCompleteValue.fields,
    object: TriageStageResult,
  });

  const decodeTriageResult = Effect.fn("Executor.decodeTriageResult")(function* (acc: TriageAccumulator) {
    if (acc.structuredOutputs.length !== 1) {
      return yield* structuredTriageError(
        `expected exactly one structured triage result, received ${acc.structuredOutputs.length}`,
      );
    }
    const completion = yield* Schema.decodeUnknownEffect(TriageCompletion)(acc.structuredOutputs[0]).pipe(
      Effect.mapError((error) => structuredTriageError(`invalid structured triage result: ${error.message}`)),
    );
    return completion.object;
  });

  const completeTriage = Effect.fn("Executor.completeTriage")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    record: RunRecord,
    acc: TriageAccumulator,
  ) {
    const result = yield* Effect.result(decodeTriageResult(acc));
    if (Result.isSuccess(result)) {
      yield* recorder.record(record, acc.deferredTerminal ?? { type: "RUN_FINISHED", finishReason: "stop" });
      return yield* applyTriageSuccess(workspace, item, record.id, acc, result.success);
    }
    yield* recorder.record(record, failedTerminal);
    return yield* applyFailure(
      workspace,
      item,
      record.id,
      result.failure.retryable,
      result.failure.message,
      acc.handle,
    );
  });

  const applyImplementSuccess = Effect.fn("Executor.applyImplementSuccess")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* issueTracker.implemented(workspace, item.id, { atMillis: endedAtMillis });
    yield* settleRun(runId, {
      status: "succeeded",
      usage: acc.usage,
      endedAtMillis,
    });
  });

  const ImplementCompletion = Schema.Struct({
    ...StructuredOutputCompleteValue.fields,
    object: ImplementStageResult,
  });

  const decodeImplementResult = Effect.fn("Executor.decodeImplementResult")(function* (acc: RunAccumulator) {
    if (acc.structuredOutputs.length !== 1) {
      return yield* structuredTriageError(
        `expected exactly one structured implement result, received ${acc.structuredOutputs.length}`,
      );
    }
    const completion = yield* Schema.decodeUnknownEffect(ImplementCompletion)(acc.structuredOutputs[0]).pipe(
      Effect.mapError((error) =>
        structuredTriageError(`invalid structured implement result: ${error.message}`),
      ),
    );
    return completion.object;
  });

  const completeImplement = Effect.fn("Executor.completeImplement")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
  ) {
    return yield* decodeImplementResult(acc).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          applyFailure(workspace, item, runId, error.retryable, error.message, acc.handle),
        onSuccess: (result) =>
          result.outcome === "opened-pr"
            ? applyImplementSuccess(workspace, item, runId, acc)
            : applyFailure(workspace, item, runId, false, result.summary, acc.handle),
      }),
    );
  });

  const prepareImplement = Effect.fn("Executor.prepareImplement")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    resolved: ResolvedStage,
    branch: string,
    prompt: string,
  ) {
    const worktree = yield* worktrees.ensure(workspace, item);
    const last = yield* ledger.latestRunByBranch(workspace.config.name, branch);
    return yield* harnessRequest(
      workspace,
      resolved,
      worktree.path,
      prompt,
      last?.session ?? null,
      item.stage,
    );
  });

  const triageOps = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    const fullPrompt = buildTriagePrompt(resolved, item);
    return {
      kind: "triage",
      resolved,
      branch: null,
      prepare: harnessRequest(
        workspace,
        resolved,
        workspace.config.checkoutPath,
        fullPrompt,
        null,
        item.stage,
      ),
      complete: (record: RunRecord, acc: TriageAccumulator) => completeTriage(workspace, item, record, acc),
      fullPrompt,
      resume: false,
    } satisfies StageOps;
  };

  const implementOps = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    const branch = branchName(item);
    const fullPrompt = buildImplementPrompt(resolved, item);
    return {
      kind: "text",
      resolved,
      branch,
      prepare: prepareImplement(workspace, item, resolved, branch, fullPrompt),
      complete: (runId: RunId, acc: RunAccumulator) => completeImplement(workspace, item, runId, acc),
      fullPrompt,
      resume: false,
    } satisfies StageOps;
  };

  const followUpMarker = (context: FollowUpContext) => ({
    checks: context.checks,
    humanCommentAtMillis: context.humanCommentAtMillis,
    botTriggerAtMillis: context.botTriggerAtMillis,
    noProgress: context.noProgress,
    baseDivergence: context.baseDivergence,
  });

  // The engine — not the agent — posts the round summary to the PR, and the provider appends the
  // coordination marker. A failed post must not strand the follow-up marker or spin a retry, so it
  // degrades to a warning rather than failing the round.
  const postFollowUpSummary = Effect.fn("Executor.postFollowUpSummary")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    acc: RunAccumulator,
  ) {
    yield* sourceControl
      .comment(workspace, { id: item.id, title: item.title }, followUpNoteBody(acc.text))
      .pipe(
        Effect.catchTag("IssueTrackerError", (error) =>
          Effect.logWarning("failed to post follow-up summary to the pull request", {
            workspace: workspace.config.name,
            item: item.id,
            message: error.message,
          }),
        ),
      );
  });

  const applyFollowUpSuccess = Effect.fn("Executor.applyFollowUpSuccess")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
    context: FollowUpContext,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* postFollowUpSummary(workspace, item, acc);
    yield* issueTracker.followedUp(workspace, item.id, {
      marker: followUpMarker(context),
      atMillis: endedAtMillis,
    });
    yield* settleRun(runId, {
      status: "succeeded",
      usage: acc.usage,
      endedAtMillis,
    });
  });

  const completeFollowUp = Effect.fn("Executor.completeFollowUp")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
    context: FollowUpContext,
  ) {
    const result = parseFollowUpResult(acc.text);
    if (result === "pushed" || result === "noop") {
      return yield* applyFollowUpSuccess(workspace, item, runId, acc, context);
    }
    const reason = agentFailureReason(acc.text, result === "stuck" ? "stuck" : "missing-sentinel");
    return yield* applyFailure(workspace, item, runId, result !== "stuck", reason, acc.handle);
  });

  const prepareFollowUp = Effect.fn("Executor.prepareFollowUp")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    resolved: ResolvedStage,
    branch: string,
    context: FollowUpContext,
    prompt: string,
  ) {
    const worktree = yield* worktrees.ensure(workspace, item);
    const last = yield* ledger.latestRunByBranch(workspace.config.name, branch);
    const session = last?.session ? yield* ledger.getSession(last.session) : null;
    const now = yield* Clock.currentTimeMillis;
    const decision = decideResume({
      sessionKind: session?.kind ?? null,
      handle: sessionHandle(session),
      lastRunStartedAtMillis: last?.startedAtMillis ?? null,
      lastRunTotalTokens: meteredTotalTokens(last?.usage),
      now,
      worktreeRecreated: worktree.created,
      fresh: context.fresh,
      maxAgeMillis: resolved.resumeMaxAgeMillis,
      maxTokens: resolved.resumeMaxTokens,
    });
    return yield* harnessRequest(
      workspace,
      resolved,
      worktree.path,
      prompt,
      decision.kind === "resume" ? (last?.session ?? null) : null,
      item.stage,
    );
  });

  const followUpOps = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    const branch = branchName(item);
    const context = item.followUp ?? defaultFollowUp;
    const fullPrompt = buildFollowUpPrompt(resolved, item, workspace.config.linearHistory);
    return {
      kind: "text",
      resolved,
      branch,
      prepare: prepareFollowUp(workspace, item, resolved, branch, context, fullPrompt),
      complete: (runId: RunId, acc: RunAccumulator) => completeFollowUp(workspace, item, runId, acc, context),
      fullPrompt,
      resume: false,
    } satisfies StageOps;
  };

  const handoffStalled = Effect.fn("Executor.handoffStalled")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const atMillis = yield* Clock.currentTimeMillis;
    const context = item.followUp ?? defaultFollowUp;
    yield* issueTracker.stalled(workspace, item.id, {
      marker: followUpMarker(context),
      atMillis,
      detail: `Follow-up made no progress after ${context.noProgress} attempts — neither the checks turned green nor a human responded. Handing this to a human.`,
    });
  });

  const resumePrepare = Effect.fn("Executor.resumePrepare")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    resolved: ResolvedStage,
    session: SessionId,
  ) {
    if (item.stage === "triage") {
      const path = workspace.config.checkoutPath;
      return yield* harnessRequest(
        workspace,
        resolved,
        path,
        buildContinuationNudge(path),
        session,
        item.stage,
      );
    }
    const worktree = yield* worktrees.ensure(workspace, item, { resume: true });
    return yield* harnessRequest(
      workspace,
      resolved,
      worktree.path,
      buildContinuationNudge(worktree.path),
      session,
      item.stage,
    );
  });

  const stageOps = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    if (item.stage === "implement") return implementOps(workspace, item, resolved);
    if (item.stage === "follow-up") return followUpOps(workspace, item, resolved);
    return triageOps(workspace, item, resolved);
  };

  const opsFor = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    const ops = stageOps(workspace, item, resolved);
    const session = item.resume?.session;
    if (!session) return ops;
    return {
      ...ops,
      prepare: resumePrepare(workspace, item, resolved, session),
      resume: true,
    } satisfies StageOps;
  };

  const settleOutcome = Effect.fn("Executor.settleOutcome")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    record: RunRecord,
    runId: RunId,
  ) {
    const settle = <A>(
      attempt: Effect.Effect<A, PrepareError | HarnessError>,
      complete: (acc: A) => Effect.Effect<void, IssueTrackerError>,
    ) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.result(attempt);
        if (Result.isSuccess(outcome)) return yield* complete(outcome.success);
        return yield* applyFailure(
          workspace,
          item,
          runId,
          retryableOf(outcome.failure),
          prepareFailureReason(outcome.failure),
          yield* handleOf(ledger, record.session),
        );
      });

    if (ops.kind === "triage") {
      return yield* settle(
        ops.prepare.pipe(Effect.flatMap((request) => foldTriageOutcome(record, ops, request))),
        (acc) => ops.complete(record, acc),
      );
    }
    return yield* settle(
      ops.prepare.pipe(Effect.flatMap((request) => foldOutcome(record, ops, request))),
      (acc) => ops.complete(runId, acc),
    );
  });

  const runClaimed = Effect.fn("Executor.runClaimed")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    startedAtMillis: number,
  ) {
    const runId = yield* nextRunId(startedAtMillis);
    const session = yield* resolveSession(workspace, item, ops, startedAtMillis);
    const record: RunRecord = {
      id: runId,
      workspace: workspace.config.name,
      workItem: item.id,
      stage: item.stage,
      harness: ops.resolved.harness,
      branch: ops.branch,
      session,
      usage: null,
      status: "running",
      startedAtMillis,
      endedAtMillis: null,
    };
    yield* ledger.insertRun(record);
    yield* Effect.withFiber((self) => runControl.register(runId, self));
    return yield* settleOutcome(workspace, item, ops, record, runId).pipe(
      Effect.ensuring(runControl.unregister(runId)),
    );
  });

  const runOrHandoff = Effect.fn("Executor.runOrHandoff")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    resolved: ResolvedStage,
    startedAtMillis: number,
  ) {
    if (item.stage === "follow-up" && item.followUp?.stalled) {
      return yield* handoffStalled(workspace, item);
    }
    yield* runClaimed(workspace, item, opsFor(workspace, item, resolved), startedAtMillis);
  });

  const execute = Effect.fn("Executor.execute")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const resolved = resolveStage(workspace.config, item.stage);
    if (!resolved?.enabled) {
      return false;
    }
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const claimed = yield* tryClaim(workspace, item, startedAtMillis);
    if (!claimed) {
      return false;
    }
    yield* runOrHandoff(workspace, item, resolved, startedAtMillis).pipe(
      Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : releaseClaim(workspace, item.id))),
    );
    return true;
  });

  return { execute } as const;
});

export class Executor extends Context.Service<Executor, Effect.Success<typeof make>>()(
  "@cogwork/engine/executor",
) {}

export const layer = Layer.effect(Executor, make);
