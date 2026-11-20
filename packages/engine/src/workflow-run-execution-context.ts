import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Coordination } from "./coordination";
import type { HarnessRunnerEnv } from "./harness";
import { IssueTracker } from "./issue-tracker";
import { WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { SlackWrite } from "./slack-write";
import { SourceControlProvider } from "./source-control";
import { TriggerObservationStore } from "./trigger-observation-store";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { WorkflowNotifications } from "./workflow-notification";
import { WorktreeManager } from "./worktree";

export const makeWorkflowRunExecutionContext = Effect.fn("WorkflowRun.makeExecutionContext")(function* () {
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
  const pullRequestBuildInput = (runBranch: string | null) => ({
    ...(sourceControl ? { sourceControl } : {}),
    ...(worktrees ? { worktrees } : {}),
    ...(runBranch ? { runBranch } : {}),
  });
  return { executionContext, pullRequestBuildInput };
});
