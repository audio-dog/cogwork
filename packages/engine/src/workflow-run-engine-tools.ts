import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { makeIssueSearchTool } from "./issue-search-tool";
import { IssueTracker } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { makePullRequestTool } from "./pull-request-tool";
import { type PullRequestContext, SourceControlProvider } from "./source-control";
import type { EngineToolName } from "./workflow-action-entry";
import { WorktreeManager } from "./worktree";
import { makeWorktreeSetupTool } from "./worktree-setup-tool";

export interface RunWorktree {
  readonly workspace: RegisteredWorkspace;
  readonly path: string;
}

export const make = Effect.gen(function* () {
  const issueTracker = yield* IssueTracker;
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
  const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));

  const worktreeSetupTools = Effect.fn("WorkflowRun.worktreeSetupTools")(function* (
    runWorktree: RunWorktree | null,
  ) {
    const canRunSetup = worktrees !== null && runWorktree !== null;
    if (!canRunSetup) return [];
    const runPromise = yield* FiberSet.makeRuntimePromise();
    const oneSetupAtATime = yield* Semaphore.make(1);
    const setup = oneSetupAtATime.withPermit(worktrees.setup(runWorktree.workspace, runWorktree.path));
    return [makeWorktreeSetupTool(setup, runPromise)];
  });

  return Effect.fn("WorkflowRun.engineTools")(function* (
    toolNeeds: ReadonlySet<EngineToolName>,
    toolWorkspaces: ReadonlyArray<RegisteredWorkspace>,
    runWorktree: RunWorktree | null,
  ) {
    const pullRequestSnapshots = yield* Ref.make<
      ReadonlyArray<{ readonly workspace: string; readonly pullRequest: PullRequestContext }>
    >([]);
    const tools = [
      ...(toolNeeds.has("issue-search") ? [makeIssueSearchTool(issueTracker, toolWorkspaces)] : []),
      ...(toolNeeds.has("pull-request") && sourceControl
        ? [
            makePullRequestTool(sourceControl, toolWorkspaces, (selected, pullRequest) =>
              Ref.update(pullRequestSnapshots, (snapshots) => [
                ...snapshots,
                { workspace: selected.config.id, pullRequest },
              ]),
            ),
          ]
        : []),
      ...(toolNeeds.has("worktree-setup") ? yield* worktreeSetupTools(runWorktree) : []),
    ];
    return { tools, reviewedPullRequests: Ref.get(pullRequestSnapshots) };
  });
});
