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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { AdmittedWork } from "./classify";
import type { HarnessRequest } from "./harness";
import * as OperationResolution from "./operation-resolution";
import { buildContinuationNudge, buildOperationPrompt } from "./playbook";
import type { RegisteredWorkspace } from "./projector";
import { meteredTotalTokens } from "./resume-policy";
import type { PrepareError } from "./retry-policy";
import { RunLedger } from "./run-ledger";
import type { ResolvedOperation } from "./run-plan";
import { SessionChoice } from "./session-choice";
import { branchName, WorktreeManager, worktreePathFor, worktreeRoot } from "./worktree";
import { WorktreeFsError } from "./worktree-fs";

class PreparationFailure extends Data.TaggedError("PreparationFailure")<{
  readonly error: PrepareError | OperationResolution.OperationUnavailable;
  readonly session: Session | null;
  readonly checkoutPath: string;
}> {}

interface PrepareRunInput {
  readonly runId: RunId;
  readonly workspace: RegisteredWorkspace;
  readonly item: AdmittedWork;
  readonly operation: ResolvedOperation;
  readonly startedAtMillis: number;
  readonly observation: RunPlanObservation;
}

export interface PreparedRun {
  readonly request: HarnessRequest;
  readonly plan: RunPlan;
  readonly session: SessionId;
  readonly operation: ResolvedOperation;
  readonly branch: BranchName | null;
  readonly checkoutPath: string;
  readonly failureSession: Session | null;
}

interface BranchSessionFacts {
  readonly latestSession: SessionId | null;
  readonly currentResumableRun: RunRecord | null;
}

type PrepareCandidateInput = Omit<PrepareRunInput, "item"> & {
  readonly item: AdmittedWork;
  readonly replay: boolean;
};

const isReplayHarness = (harness: HarnessName) => harness === "replay";

const resumeWorktreeOptions = (item: AdmittedWork) => {
  if (item.followUpBranch) {
    return { resume: true, branch: item.followUpBranch };
  }
  return { resume: true };
};

const branchFor = (
  workspace: RegisteredWorkspace | null,
  item: AdmittedWork,
  operation: ResolvedOperation,
) => {
  if (!workspace || operation.profile === "read-only") return null;
  return item.followUpBranch ?? branchName(item);
};

const checkoutPathForBranch = (workspace: RegisteredWorkspace, branch: BranchName | null) =>
  branch
    ? worktreePathFor(worktreeRoot(workspace.config.checkoutPath, workspace.config.worktrees), branch)
    : workspace.config.checkoutPath;

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
  const fs = yield* FileSystem.FileSystem;
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

  const prepareCheckout = Effect.fn("RunPreparation.prepareCheckout")(function* (
    workspace: RegisteredWorkspace | null,
    item: AdmittedWork,
    operation: ResolvedOperation,
  ) {
    const branch = branchFor(workspace, item, operation);
    if (!workspace) {
      const path = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-run-" }).pipe(
        Effect.mapError(
          (error) =>
            new WorktreeFsError({
              operation: "make scratch checkout",
              message: error.message,
              retryable: true,
            }),
        ),
      );
      return { branch, path, created: true };
    }
    if (operation.profile === "read-only") {
      return { branch, path: workspace.config.checkoutPath, created: false };
    }
    const hasPullRequestBranch = item.followUpBranch !== undefined && branch !== null;
    const freshOptions = hasPullRequestBranch ? { branch } : undefined;
    const options = item.resume?.session ? resumeWorktreeOptions(item) : freshOptions;
    const checkout = yield* worktrees.ensure(workspace, item, options);
    return { ...checkout, branch };
  });

  const candidateSession = Effect.fn("RunPreparation.candidateSession")(function* (
    item: AdmittedWork,
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
    replay,
  }: PrepareCandidateInput) {
    const checkout = yield* prepareCheckout(workspace, item, operation);
    const { branch } = checkout;
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
      operation,
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
    yield* logSessionChoice(session, accepted.resolved, branch, accepted.sessionChoice);
    return {
      request: {
        plan: accepted.plan,
        session: accepted.session,
        mcpCredentials: accepted.mcpCredentials,
      },
      plan: accepted.plan,
      session: accepted.session,
      operation: accepted.resolved,
      branch,
      checkoutPath: checkout.path,
      failureSession: storedSession,
    } satisfies PreparedRun;
  });

  const prepare = Effect.fn("RunPreparation.prepare")(function* (input: PrepareRunInput) {
    const { item } = input;
    const branch = branchFor(input.workspace, item, input.operation);
    const checkoutPath = checkoutPathForBranch(input.workspace, branch);
    const replay = isReplayHarness(input.operation.stage.harness);
    return yield* prepareCandidate({ ...input, item, replay }).pipe(
      Effect.catch((error) =>
        branchSessionFacts(input.workspace, branch).pipe(
          Effect.flatMap((facts) => candidateSession(item, facts)),
          Effect.flatMap((session) => Effect.fail(new PreparationFailure({ error, session, checkoutPath }))),
        ),
      ),
    );
  });

  return { prepare, prepareCheckout };
});
