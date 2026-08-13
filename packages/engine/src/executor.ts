import type { LifecycleStage, RunRecord, SessionId, TokenUsage } from "@clanker-forge/contracts";
import {
  agUiDisplayName,
  agUiSessionId,
  agUiTextDelta,
  agUiUsage,
  RunId,
  sessionHandle,
} from "@clanker-forge/contracts";
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
import { agentFailureReason, prepareFailureReason, triageProposalBody } from "./comments";
import type { CredentialError } from "./credential-store";
import { activityOf, DaemonEventBus } from "./daemon-event-bus";
import type { FollowUpContext } from "./follow-up";
import type { GitError } from "./git";
import { handToHuman, releaseClaim as makeReleaseClaim } from "./hand-to-human";
import { type AgUiEvent, Harness, type HarnessError, type HarnessRequest } from "./harness";
import { IssueTracker, type IssueTrackerError } from "./issue-tracker";
import { McpSkillAssembler } from "./mcp-skill";
import {
  buildContinuationNudge,
  buildFollowUpPrompt,
  buildImplementPrompt,
  buildTriagePrompt,
  parseFollowUpResult,
  parseImplementResult,
  type ResolvedStage,
  resolveStage,
  resolveTriageDecision,
  type TriageDecision,
} from "./playbook";
import type { RegisteredWorkspace } from "./projector";
import { decideResume } from "./resume-policy";
import { RunControl } from "./run-control";
import { handleOf, RunLedger, type RunUpdate } from "./run-ledger";
import { SessionStore } from "./session-store";
import { branchName, type WorktreeDivergedError, WorktreeManager } from "./worktree";
import type { WorktreeFsError } from "./worktree-fs";

type PrepareError = GitError | WorktreeFsError | WorktreeDivergedError | CredentialError;

interface RunAccumulator {
  readonly text: string;
  readonly handle: string | null;
  readonly usage: TokenUsage | null;
}

const emptyAccumulator: RunAccumulator = { text: "", handle: null, usage: null };

interface StageOps {
  readonly resolved: ResolvedStage;
  readonly branch: string | null;
  readonly prepare: Effect.Effect<HarnessRequest, PrepareError>;
  readonly complete: (runId: RunId, acc: RunAccumulator) => Effect.Effect<void, IssueTrackerError>;
  readonly fullPrompt: string;
  readonly resume: boolean;
}

class SessionRestarted extends Data.TaggedError("SessionRestarted")<{
  readonly nextSeq: number;
}> {}

const withFullPrompt = (request: HarnessRequest, prompt: string): HarnessRequest => ({
  ...request,
  prompt,
});

const defaultFollowUp: FollowUpContext = {
  checks: "pending",
  humanCommentAtMillis: 0,
  noProgress: 0,
  stalled: false,
  fresh: false,
  baseDivergence: "none",
};

const warnTriageDecision = Effect.fn("Executor.warnTriageDecision")(function* (
  item: EligibleWork,
  decision: TriageDecision,
) {
  if (decision.source !== "sentinel") {
    return yield* Effect.logWarning("triage run emitted no decision sentinel", {
      item: item.id,
      source: decision.source,
      disposition: decision.disposition,
      applied: decision.role,
    });
  }
  if (decision.disposition && decision.disposition !== decision.sentinel) {
    yield* Effect.logWarning("triage sentinel disagrees with proposal disposition", {
      item: item.id,
      sentinel: decision.sentinel,
      disposition: decision.disposition,
      applied: decision.role,
    });
  }
});

const mergeEvent = (acc: RunAccumulator, event: AgUiEvent, handle: string | null): RunAccumulator => ({
  text: acc.text + agUiTextDelta(event),
  handle,
  usage: agUiUsage(event) ?? acc.usage,
});

const failedTerminal: AgUiEvent = { type: "RUN_FINISHED", finishReason: "failed" };

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

// The harness hands back this handle as untrusted output, and it is later echoed verbatim into a
// fenced shell block in the human handoff comment. Whitespace or a backtick would break out of that
// fence, so a handle carrying either is refused rather than stored.
const cleanHandle = (raw: string | null) => (raw && !/[\s`]/.test(raw) ? raw : null);

const decodeRunId = Schema.decodeUnknownEffect(RunId);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

export const make = Effect.gen(function* () {
  const issueTracker = yield* IssueTracker;
  const harness = yield* Harness;
  const ledger = yield* RunLedger;
  const bus = yield* DaemonEventBus;
  const worktrees = yield* WorktreeManager;
  const assembler = yield* McpSkillAssembler;
  const runControl = yield* RunControl;
  const sessionStore = yield* SessionStore;
  const handoff = handToHuman(issueTracker);
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

  const persistEvent = Effect.fn("Executor.persistEvent")(function* (
    record: RunRecord,
    seq: number,
    event: AgUiEvent,
  ) {
    const atMillis = yield* Clock.currentTimeMillis;
    const data = yield* encodeJson(event).pipe(Effect.orElseSucceed(() => "{}"));
    yield* ledger.appendEvent(record.id, {
      seq,
      type: event.type,
      name: agUiDisplayName(event),
      data,
      atMillis,
    });
    yield* bus.publishActivity(activityOf(record, seq, atMillis, event));
  });

  const settleRun = (runId: RunId, update: RunUpdate) => ledger.updateRun(runId, update);

  const nextHandle = Effect.fn("Executor.nextHandle")(function* (
    record: RunRecord,
    current: string | null,
    raw: string | null,
  ) {
    const handle = cleanHandle(raw);
    if (handle === null || handle === current || record.session === null) return current;
    yield* ledger.recordSessionHandle(record.session, handle);
    return handle;
  });

  const foldEvent = Effect.fn("Executor.foldEvent")(function* (
    record: RunRecord,
    acc: RunAccumulator,
    seq: number,
    event: AgUiEvent,
  ) {
    const handle = yield* nextHandle(record, acc.handle, agUiSessionId(event));
    yield* persistEvent(record, seq, event);
    return mergeEvent(acc, event, handle);
  });

  const foldStream = <E, R>(
    request: HarnessRequest,
    step: (acc: RunAccumulator, event: AgUiEvent, index: number) => Effect.Effect<RunAccumulator, E, R>,
  ) =>
    Stream.runFoldEffect(
      Stream.zipWithIndex(withFailureTerminal(harness.run(request))),
      () => emptyAccumulator,
      (acc: RunAccumulator, [event, index]: readonly [AgUiEvent, number]) => step(acc, event, index),
    );

  const foldRun = Effect.fn("Executor.foldRun")(function* (
    record: RunRecord,
    request: HarnessRequest,
    startSeq: number,
  ) {
    return yield* foldStream(request, (acc, event, index) => foldEvent(record, acc, index + startSeq, event));
  });

  const guardResume = (prev: RunAccumulator, next: RunAccumulator, index: number, expected: string) =>
    prev.handle === null && next.handle !== null && next.handle !== expected
      ? Effect.fail(new SessionRestarted({ nextSeq: index + 1 }))
      : Effect.succeed(next);

  const foldResume = Effect.fn("Executor.foldResume")(function* (
    record: RunRecord,
    request: HarnessRequest,
    expected: string,
  ) {
    return yield* foldStream(request, (acc, event, index) =>
      foldEvent(record, acc, index, event).pipe(
        Effect.flatMap((next) => guardResume(acc, next, index, expected)),
      ),
    );
  });

  const foldOutcome = Effect.fn("Executor.foldOutcome")(function* (
    record: RunRecord,
    ops: StageOps,
    request: HarnessRequest,
  ) {
    const expected = ops.resume ? yield* handleOf(ledger, request.session) : null;
    if (!expected) return yield* foldRun(record, request, 0);
    return yield* foldResume(record, request, expected).pipe(
      Effect.catchTag("SessionRestarted", (restart) =>
        foldRun(record, withFullPrompt(request, ops.fullPrompt), restart.nextSeq),
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
    yield* issueTracker.recordAttempt(
      workspace,
      item.id,
      { stage: item.stage, outcome: "failed", atMillis: endedAtMillis },
      reason,
    );
    if (exhausted) {
      yield* handoff({
        workspace,
        item,
        stage: item.stage,
        cause: handoffCause(retryable, attempts),
        reason,
        session: handle,
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
  ) {
    const decision = resolveTriageDecision(acc.text);
    yield* warnTriageDecision(item, decision);
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* issueTracker.note(workspace, item.id, triageProposalBody(acc.text));
    yield* issueTracker.setRoles(workspace, item.id, { remove: ["needs-triage"], add: [decision.role] });
    yield* issueTracker.recordAttempt(workspace, item.id, {
      stage: "triage",
      outcome: "succeeded",
      atMillis: endedAtMillis,
    });
    yield* settleRun(runId, {
      status: "succeeded",
      usage: acc.usage,
      endedAtMillis,
    });
  });

  const applyImplementSuccess = Effect.fn("Executor.applyImplementSuccess")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* issueTracker.setRoles(workspace, item.id, { remove: ["ready-for-agent"], add: [] });
    yield* issueTracker.recordAttempt(workspace, item.id, {
      stage: "implement",
      outcome: "succeeded",
      atMillis: endedAtMillis,
    });
    yield* settleRun(runId, {
      status: "succeeded",
      usage: acc.usage,
      endedAtMillis,
    });
  });

  const completeImplement = Effect.fn("Executor.completeImplement")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
  ) {
    const result = parseImplementResult(acc.text);
    if (result === "opened-pr") {
      return yield* applyImplementSuccess(workspace, item, runId, acc);
    }
    const reason = agentFailureReason(acc.text, result === "stuck" ? "stuck" : "missing-sentinel");
    return yield* applyFailure(workspace, item, runId, result !== "stuck", reason, acc.handle);
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
      complete: (runId: RunId, acc: RunAccumulator) => applyTriageSuccess(workspace, item, runId, acc),
      fullPrompt,
      resume: false,
    } satisfies StageOps;
  };

  const implementOps = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedStage) => {
    const branch = branchName(item);
    const fullPrompt = buildImplementPrompt(resolved, item);
    return {
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
    noProgress: context.noProgress,
    baseDivergence: context.baseDivergence,
  });

  const applyFollowUpSuccess = Effect.fn("Executor.applyFollowUpSuccess")(function* (
    workspace: RegisteredWorkspace,
    item: EligibleWork,
    runId: RunId,
    acc: RunAccumulator,
    context: FollowUpContext,
  ) {
    const endedAtMillis = yield* Clock.currentTimeMillis;
    yield* issueTracker.recordFollowUp(workspace, item.id, followUpMarker(context));
    yield* issueTracker.recordAttempt(workspace, item.id, {
      stage: "follow-up",
      outcome: "succeeded",
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
    if (result === "pushed") {
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
      lastRunTotalTokens: last?.usage?.totalTokens ?? null,
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
    yield* issueTracker.recordFollowUp(
      workspace,
      item.id,
      followUpMarker(context),
      `Follow-up made no progress after ${context.noProgress} attempts — neither the checks turned green nor a human responded. Handing this to a human.`,
    );
    yield* issueTracker.setRoles(workspace, item.id, { remove: [], add: ["ready-for-human"] });
    yield* issueTracker.recordAttempt(workspace, item.id, {
      stage: "follow-up",
      outcome: "abandoned",
      atMillis,
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
    const outcome = yield* Effect.result(
      ops.prepare.pipe(
        Effect.flatMap(
          (request): Effect.Effect<RunAccumulator, PrepareError | HarnessError> =>
            foldOutcome(record, ops, request),
        ),
      ),
    );
    if (Result.isSuccess(outcome)) {
      return yield* ops.complete(runId, outcome.success);
    }
    return yield* applyFailure(
      workspace,
      item,
      runId,
      retryableOf(outcome.failure),
      prepareFailureReason(outcome.failure),
      yield* handleOf(ledger, record.session),
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
  "@clanker-forge/engine/executor",
) {}

export const layer = Layer.effect(Executor, make);
