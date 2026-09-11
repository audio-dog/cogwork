import type {
  BranchName,
  HarnessName,
  RunId,
  RunPlan,
  RunPlanObservation,
  RunRecord,
  Session,
  SessionId,
} from "@cogwork/contracts";
import { BranchName as BranchNameSchema } from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { EligibleWork } from "./classify";
import type { HarnessRequest } from "./harness";
import * as OperationResolution from "./operation-resolution";
import { buildContinuationNudge, buildOperationPrompt, type OperationOutcomeTable } from "./playbook";
import type { RegisteredWorkspace } from "./projector";
import { meteredTotalTokens } from "./resume-policy";
import type { PrepareError } from "./retry-policy";
import { RunLedger } from "./run-ledger";
import type { ResolvedOperation } from "./run-plan";
import { SessionChoice } from "./session-choice";
import { branchName, WorktreeManager } from "./worktree";

type PreparationWorkItem = Omit<EligibleWork, "followUpBranch"> & {
  readonly followUpBranch: BranchName | undefined;
};

class PreparationFailure extends Data.TaggedError("PreparationFailure")<{
  readonly error: PrepareError | OperationResolution.OperationUnavailable;
  readonly session: Session | null;
}> {}

interface PrepareRunInput {
  readonly runId: RunId;
  readonly workspace: RegisteredWorkspace;
  readonly item: EligibleWork;
  readonly operation: ResolvedOperation;
  readonly startedAtMillis: number;
  readonly observation: RunPlanObservation;
}

export interface PreparedRun {
  readonly request: HarnessRequest;
  readonly plan: RunPlan;
  readonly session: SessionId;
  readonly operation: ResolvedOperation;
  readonly outcomeTable: OperationOutcomeTable;
  readonly branch: BranchName | null;
  readonly checkoutPath: string;
  readonly failureSession: Session | null;
}

interface BranchSessionFacts {
  readonly latestSession: SessionId | null;
  readonly currentResumableRun: RunRecord | null;
}

type PrepareCandidateInput = Omit<PrepareRunInput, "item"> & {
  readonly item: PreparationWorkItem;
  readonly branch: BranchName | null;
  readonly replay: boolean;
};

const isReplayHarness = (harness: HarnessName) => harness === "replay";

const prepareWorkItem = (item: EligibleWork) => {
  const { followUpBranch, ...work } = item;
  if (item.stage !== "follow-up" || !followUpBranch) return { ...work, followUpBranch: undefined };
  return { ...work, followUpBranch: BranchNameSchema.make(followUpBranch) };
};

const resumeWorktreeOptions = (item: PreparationWorkItem) => {
  if (item.stage === "follow-up" && item.followUpBranch) {
    return { resume: true, branch: item.followUpBranch };
  }
  return { resume: true };
};

const branchFor = (item: PreparationWorkItem, operation: ResolvedOperation) => {
  if (isReplayHarness(operation.stage.harness) || item.stage === "triage") return null;
  if (item.stage === "follow-up") return item.followUpBranch ?? branchName(item);
  return branchName(item);
};

const logSessionChoice = Effect.fn("RunPreparation.logSessionChoice")(function* (
  session: Session | null,
  operation: ResolvedOperation,
  branch: BranchName | null,
  choice: SessionChoice,
) {
  if (!session) return;
  if (session.harness !== operation.stage.harness) {
    yield* Effect.logInfo("started fresh after harness switch", {
      ...(branch ? { branch } : {}),
      oldHarness: session.harness,
      newHarness: operation.stage.harness,
    });
    return;
  }
  if (!SessionChoice.$is("Combined")(choice)) return;
  yield* Effect.logInfo("started fresh after Sandbox lineage was recreated", {
    ...(branch ? { branch } : {}),
    harness: session.harness,
  });
});

export const make = Effect.gen(function* () {
  const ledger = yield* RunLedger;
  const operationResolution = yield* OperationResolution.OperationResolution;
  const worktrees = yield* WorktreeManager;

  const branchSessionFacts = Effect.fn("RunPreparation.branchSessionFacts")(function* (
    workspace: RegisteredWorkspace,
    branch: BranchName | null,
  ) {
    if (!branch) return { latestSession: null, currentResumableRun: null } satisfies BranchSessionFacts;
    const [latestSession, latestRun] = yield* Effect.all([
      ledger.sessionForBranch(workspace.config.name, branch),
      ledger.latestRunByBranch(workspace.config.name, branch),
    ]);
    return {
      latestSession,
      currentResumableRun: latestSession === latestRun?.session ? latestRun : null,
    } satisfies BranchSessionFacts;
  });

  const ensureCheckout = Effect.fn("RunPreparation.ensureCheckout")(function* (
    workspace: RegisteredWorkspace,
    item: PreparationWorkItem,
    branch: BranchName | null,
    replay: boolean,
  ) {
    if (replay || item.stage === "triage") {
      return { path: workspace.config.checkoutPath, created: false };
    }
    if (item.resume?.session) return yield* worktrees.ensure(workspace, item, resumeWorktreeOptions(item));
    if (item.stage === "follow-up" && branch) return yield* worktrees.ensure(workspace, item, { branch });
    return yield* worktrees.ensure(workspace, item);
  });

  const candidateSession = Effect.fn("RunPreparation.candidateSession")(function* (
    item: PreparationWorkItem,
    facts: BranchSessionFacts,
  ) {
    const sessionId = item.resume?.session ?? facts.currentResumableRun?.session ?? null;
    if (!sessionId) return null;
    return yield* ledger.getSession(sessionId);
  });

  const prepareCandidate = Effect.fn("RunPreparation.prepareCandidate")(function* ({
    runId,
    workspace,
    item,
    operation,
    startedAtMillis,
    observation,
    branch,
    replay,
  }: PrepareCandidateInput) {
    const checkout = yield* ensureCheckout(workspace, item, branch, replay);
    const facts = yield* branchSessionFacts(workspace, branch);
    const storedSession = yield* candidateSession(item, facts);
    const session = item.stage === "follow-up" && replay ? null : storedSession;
    const fullPrompt = buildOperationPrompt(operation.stage, item, workspace.config.linearHistory);
    const continuationPrompt =
      item.resume?.session && !replay ? buildContinuationNudge(checkout.path) : fullPrompt;
    const applyResumePolicy = item.stage === "follow-up" && !item.resume?.session && !replay;
    const worktreeRecreated = item.resume?.session || applyResumePolicy ? checkout.created : false;
    const accepted = yield* operationResolution.resolve({
      runId,
      workspace,
      item,
      observation,
      checkoutPath: checkout.path,
      continuationPrompt,
      startedAtMillis,
      sessionChoice: {
        session,
        recoverySession: item.resume?.session ?? null,
        latestBranchSession: facts.latestSession,
        lastRunStartedAtMillis: applyResumePolicy
          ? (facts.currentResumableRun?.startedAtMillis ?? null)
          : null,
        lastRunTotalTokens: applyResumePolicy ? meteredTotalTokens(facts.currentResumableRun?.usage) : null,
        worktreeRecreated,
        fresh: applyResumePolicy ? (item.followUp?.fresh ?? false) : false,
        applyResumePolicy,
      },
    });
    const selectedBranch = branchFor(item, accepted.resolved);
    yield* logSessionChoice(session, accepted.resolved, selectedBranch, accepted.sessionChoice);
    return {
      request: {
        plan: accepted.plan,
        session: accepted.session,
        mcpCredentials: accepted.mcpCredentials,
      },
      plan: accepted.plan,
      session: accepted.session,
      operation: accepted.resolved,
      outcomeTable: accepted.resolved.stage.outcomeTable,
      branch: selectedBranch,
      checkoutPath: checkout.path,
      failureSession: storedSession,
    } satisfies PreparedRun;
  });

  const prepare = Effect.fn("RunPreparation.prepare")(function* ({
    item: rawItem,
    ...input
  }: PrepareRunInput) {
    const item = prepareWorkItem(rawItem);
    const branch = branchFor(item, input.operation);
    const replay = isReplayHarness(input.operation.stage.harness);
    return yield* prepareCandidate({ ...input, item, branch, replay }).pipe(
      Effect.catch((error) =>
        branchSessionFacts(input.workspace, branch).pipe(
          Effect.flatMap((facts) => candidateSession(item, facts)),
          Effect.flatMap((session) => Effect.fail(new PreparationFailure({ error, session }))),
        ),
      ),
    );
  });

  return { prepare };
});
