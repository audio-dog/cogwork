import type { LifecycleStage, RunRecord, Session, SessionId, TokenUsage } from "@cogwork/contracts";
import {
  agUiIsStructuredOutputComplete,
  agUiUsage,
  type FollowUpStageResult,
  type ImplementStageResult,
  RunId,
  sessionHandle,
  stageResultCompletionSchema,
  type TriageStageResult,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type EligibleWork, maxAttemptsPerStage } from "./classify";
import { followUpNoteBody, handoffNote, prepareFailureReason, triageProposalBody } from "./comments";
import type { CredentialError } from "./credential-store";
import type { FollowUpContext } from "./follow-up";
import type { GitError } from "./git";
import { type AgUiEvent, Harness, HarnessError, type HarnessRequest } from "./harness";
import { IssueTracker, type IssueTrackerError, releaseClaim as makeReleaseClaim } from "./issue-tracker";
import { McpSkillAssembler } from "./mcp-skill";
import { operationPolicyProfile } from "./operation-policy";
import {
  buildContinuationNudge,
  buildFollowUpPrompt,
  buildImplementPrompt,
  buildTriagePrompt,
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
  readonly handle: string | null;
  readonly usage: TokenUsage | null;
  readonly structuredOutputs: ReadonlyArray<unknown>;
}

interface TriageAccumulator extends RunAccumulator {
  readonly structuredOutputs: ReadonlyArray<unknown>;
  readonly deferredTerminal: AgUiEvent | null;
}

const emptyAccumulator: RunAccumulator = {
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
  readonly resumePolicy: boolean;
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

const appendStructuredOutput = (acc: Pick<RunAccumulator, "structuredOutputs">, event: AgUiEvent) => {
  if (!agUiIsStructuredOutputComplete(event)) return acc.structuredOutputs;
  return [...acc.structuredOutputs, event.value];
};

const mergeEvent = (acc: RunAccumulator, event: AgUiEvent, handle: string | null): RunAccumulator => ({
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
      profile: operationPolicyProfile(stage),
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

  const mintSession = (workspace: RegisteredWorkspace, ops: StageOps, startedAtMillis: number) =>
    sessionStore.mint(
      { workspace: workspace.config.name, harness: ops.resolved.harness, createdAtMillis: startedAtMillis },
      harness.sessionKind,
    );

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

  const compatibleSession = Effect.fn("Executor.compatibleSession")(function* (
    workspace: RegisteredWorkspace,
    ops: StageOps,
    session: Session | null,
  ) {
    if (!session) return null;
    if (session.harness === ops.resolved.harness) return session.id;
    yield* Effect.logInfo("started fresh after harness switch", {
      workspace: workspace.config.name,
      ...(ops.branch ? { branch: ops.branch } : {}),
      oldHarness: session.harness,
      newHarness: ops.resolved.harness,
    });
    return null;
  });

  const priorSession = (workspace: RegisteredWorkspace, item: EligibleWork, ops: StageOps) =>
    candidateSession(workspace, item, ops.branch).pipe(
      Effect.flatMap((id) => (id ? ledger.getSession(id) : Effect.succeed(null))),
      Effect.flatMap((session) => compatibleSession(workspace, ops, session)),
    );

  const planSession = Effect.fn("Executor.planSession")(function* (
    workspace: RegisteredWorkspace,
    ops: StageOps,
    startedAtMillis: number,
    previous: SessionId | null,
  ) {
    const request = yield* ops.prepare;
    const session =
      request.session ??
      (ops.resumePolicy ? null : previous) ??
      (yield* mintSession(workspace, ops, startedAtMillis));
    return { request: { ...request, session }, session };
  });

  const withSession = (record: RunRecord, session: SessionId) =>
    record.session === session ? record : { ...record, session };

  const tryClaim = Effect.fn("Executor.tryClaim")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    at: number,
  ) {
    return yield* issueTracker.claim(workspace, item.id, { claimedAtMillis: at, stage: item.stage }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning("claim failed", { stage: item.stage, item: item.id, error }).pipe(
            Effect.map(() => false),
          ),
        onSuccess: () => Effect.succeed(true),
      }),
    );
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

  const foldResume = (record: RunRecord, request: HarnessRequest, expected: string) =>
    foldStream(request, emptyAccumulator, (acc, event) =>
      foldEvent(record, acc, event).pipe(Effect.flatMap((next) => guardResume(acc, next, expected))),
    ).pipe(Effect.catchTag("SessionRestarted", () => rejectedResume(record)));

  const foldTriageResume = (record: RunRecord, request: HarnessRequest, expected: string) =>
    foldStream(request, emptyTriageAccumulator, (acc, event) =>
      foldTriageEvent(record, acc, event).pipe(Effect.flatMap((next) => guardResume(acc, next, expected))),
    ).pipe(Effect.catchTag("SessionRestarted", () => rejectedResume(record)));

  const foldOutcome = Effect.fn("Executor.foldOutcome")(function* (
    record: RunRecord,
    ops: CommonStageOps,
    request: HarnessRequest,
  ) {
    const expected = ops.resume ? yield* handleOf(ledger, request.session) : null;
    if (!expected) return yield* foldRun(record, request);
    return yield* foldResume(record, request, expected);
  });

  const foldTriageOutcome = Effect.fn("Executor.foldTriageOutcome")(function* (
    record: RunRecord,
    ops: TriageStageOps,
    request: HarnessRequest,
  ) {
    const expected = ops.resume ? yield* handleOf(ledger, request.session) : null;
    if (!expected) return yield* foldTriageRun(record, request);
    return yield* foldTriageResume(record, request, expected);
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

  const structuredResultError = (message: string) =>
    new HarnessError({ reason: "turn", retryable: true, message });

  const decodeStageResult = Effect.fn("Executor.decodeStageResult")(function* (
    stage: LifecycleStage,
    acc: Pick<RunAccumulator, "structuredOutputs">,
  ) {
    if (acc.structuredOutputs.length !== 1) {
      return yield* structuredResultError(
        `expected exactly one structured ${stage} result, received ${acc.structuredOutputs.length}`,
      );
    }
    const schema = stageResultCompletionSchema(stage);
    if (!schema) {
      return yield* structuredResultError(`structured ${stage} result has no shared schema`);
    }
    const completion = yield* Schema.decodeUnknownEffect(schema)(acc.structuredOutputs[0]).pipe(
      Effect.mapError((error) =>
        structuredResultError(`invalid structured ${stage} result: ${error.message}`),
      ),
    );
    return completion.object;
  });

  const decodeTriageResult = (acc: TriageAccumulator) =>
    decodeStageResult("triage", acc).pipe(Effect.map((result) => result as TriageStageResult));

  const completeTriage = Effect.fn("Executor.completeTriage")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    record: RunRecord,
    acc: TriageAccumulator,
  ) {
    return yield* decodeTriageResult(acc).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          recorder
            .record(record, failedTerminal)
            .pipe(
              Effect.andThen(
                applyFailure(workspace, item, record.id, error.retryable, error.message, acc.handle),
              ),
            ),
        onSuccess: (result) =>
          recorder
            .record(record, acc.deferredTerminal ?? { type: "RUN_FINISHED", finishReason: "stop" })
            .pipe(Effect.andThen(applyTriageSuccess(workspace, item, record.id, acc, result))),
      }),
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

  const decodeImplementResult = (acc: RunAccumulator) =>
    decodeStageResult("implement", acc).pipe(Effect.map((result) => result as ImplementStageResult));

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
    prompt: string,
  ) {
    const worktree = yield* worktrees.ensure(workspace, item);
    return yield* harnessRequest(workspace, resolved, worktree.path, prompt, null, item.stage);
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
      resumePolicy: false,
    } satisfies StageOps;
  };

  const implementOps = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    const branch = branchName(item);
    const fullPrompt = buildImplementPrompt(resolved, item);
    return {
      kind: "text",
      resolved,
      branch,
      prepare: prepareImplement(workspace, item, resolved, fullPrompt),
      complete: (runId: RunId, acc: RunAccumulator) => completeImplement(workspace, item, runId, acc),
      fullPrompt,
      resume: false,
      resumePolicy: false,
    } satisfies StageOps;
  };

  const followUpMarker = (context: FollowUpContext) => ({
    checks: context.checks,
    humanCommentAtMillis: context.humanCommentAtMillis,
    botTriggerAtMillis: context.botTriggerAtMillis,
    noProgress: context.noProgress,
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
    result: FollowUpStageResult,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* postFollowUpSummary(workspace, item, result.summary);
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

  const decodeFollowUpResult = (acc: RunAccumulator) =>
    decodeStageResult("follow-up", acc).pipe(Effect.map((result) => result as FollowUpStageResult));

  const completeFollowUp = Effect.fn("Executor.completeFollowUp")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
    context: FollowUpContext,
  ) {
    return yield* decodeFollowUpResult(acc).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          applyFailure(workspace, item, runId, error.retryable, error.message, acc.handle),
        onSuccess: (result) =>
          result.outcome === "stuck"
            ? applyFailure(workspace, item, runId, false, result.summary, acc.handle)
            : applyFollowUpSuccess(workspace, item, runId, acc, context, result),
      }),
    );
  });

  const prepareFollowUp = Effect.fn("Executor.prepareFollowUp")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    resolved: ResolvedStage,
    branch: string,
    context: FollowUpContext,
    prompt: string,
  ) {
    const worktree = yield* worktrees.ensure(workspace, item, { branch });
    const last = yield* latestResumableBranchRun(workspace, branch);
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
      decision.kind === "resume" && session?.harness === resolved.harness ? (last?.session ?? null) : null,
      item.stage,
    );
  });

  const followUpOps = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    const branch = item.followUpBranch ?? branchName(item);
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
      resumePolicy: true,
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
    const worktree = yield* worktrees.ensure(workspace, item, resumeWorktreeOptions(item));
    return yield* harnessRequest(
      workspace,
      resolved,
      worktree.path,
      buildContinuationNudge(worktree.path),
      session,
      item.stage,
    );
  });

  const freshRecoveryPrepare = Effect.fn("Executor.freshRecoveryPrepare")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    resolved: ResolvedStage,
    prompt: string,
  ) {
    if (item.stage === "triage") {
      return yield* harnessRequest(
        workspace,
        resolved,
        workspace.config.checkoutPath,
        prompt,
        null,
        item.stage,
      );
    }
    const worktree = yield* worktrees.ensure(workspace, item, resumeWorktreeOptions(item));
    return yield* harnessRequest(workspace, resolved, worktree.path, prompt, null, item.stage);
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

  const resolveStageOps = (workspace: RegisteredWorkspace, item: EligibleWork) => {
    const resolved = resolveStage(workspace.config, item.stage);
    if (!resolved?.enabled) return null;
    return opsFor(workspace, item, resolved);
  };

  const freshRecoveryOps = (workspace: RegisteredWorkspace, item: EligibleWork, ops: StageOps) => {
    const fresh = stageOps(workspace, item, ops.resolved);
    if (!item.resume) return fresh;
    return {
      ...fresh,
      prepare: freshRecoveryPrepare(workspace, item, ops.resolved, fresh.fullPrompt),
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
    const settle = <A>(
      attempt: Effect.Effect<A, PrepareError | HarnessError>,
      complete: (acc: A) => Effect.Effect<void, IssueTrackerError>,
    ) =>
      attempt.pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            handleOf(ledger, record.session).pipe(
              Effect.flatMap((handle) =>
                applyFailure(workspace, item, runId, retryableOf(error), prepareFailureReason(error), handle),
              ),
            ),
          onSuccess: complete,
        }),
      );

    if (ops.kind === "triage") {
      return yield* settle(foldTriageOutcome(record, ops, request), (acc) => ops.complete(record, acc));
    }
    return yield* settle(foldOutcome(record, ops, request), (acc) => ops.complete(runId, acc));
  });

  const runClaimed = Effect.fn("Executor.runClaimed")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    startedAtMillis: number,
  ) {
    const runId = yield* nextRunId(startedAtMillis);
    const previous = yield* priorSession(workspace, item, ops);
    const selectedOps = previous === item.resume?.session ? ops : freshRecoveryOps(workspace, item, ops);
    const record: RunRecord = {
      id: runId,
      workspace: workspace.config.name,
      workItem: item.id,
      stage: item.stage,
      harness: selectedOps.resolved.harness,
      branch: selectedOps.branch,
      session: previous,
      usage: null,
      status: "running",
      startedAtMillis,
      endedAtMillis: null,
    };
    yield* ledger.insertRun(record);
    yield* Effect.withFiber((self) => runControl.register(runId, self));
    const persistSession = (session: SessionId) => {
      const prepared = withSession(record, session);
      return prepared === record
        ? Effect.succeed(prepared)
        : ledger.setRunSession(runId, session).pipe(Effect.map(() => prepared));
    };
    return yield* planSession(workspace, selectedOps, startedAtMillis, previous).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          (previous ? Effect.succeed(previous) : mintSession(workspace, selectedOps, startedAtMillis)).pipe(
            Effect.flatMap(persistSession),
            Effect.flatMap((prepared) =>
              handleOf(ledger, prepared.session).pipe(
                Effect.flatMap((handle) =>
                  applyFailure(
                    workspace,
                    item,
                    runId,
                    retryableOf(error),
                    prepareFailureReason(error),
                    handle,
                  ),
                ),
              ),
            ),
          ),
        onSuccess: ({ request, session }) =>
          persistSession(session).pipe(
            Effect.flatMap((prepared) =>
              settleOutcome(workspace, item, selectedOps, prepared, runId, request),
            ),
          ),
      }),
      Effect.ensuring(runControl.unregister(runId)),
    );
  });

  const runOrHandoff = Effect.fn("Executor.runOrHandoff")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    ops: StageOps,
    startedAtMillis: number,
  ) {
    if (item.stage === "follow-up" && item.followUp?.stalled) {
      return yield* handoffStalled(workspace, item);
    }
    yield* runClaimed(workspace, item, ops, startedAtMillis);
  });

  const execute = Effect.fn("Executor.execute")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) {
    const stageOps = resolveStageOps(workspace, item);
    if (!stageOps) return false;
    const runnable = yield* harness
      .preflight(stageOps.resolved.harness, operationPolicyProfile(item.stage))
      .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
    if (!runnable) return false;
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const claimed = yield* tryClaim(workspace, item, startedAtMillis);
    if (!claimed) {
      return false;
    }
    yield* runOrHandoff(workspace, item, stageOps, startedAtMillis).pipe(
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
