import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { makeIssueSearchTool } from "./issue-search-tool";
import { IssueTracker } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { makePullRequestTool } from "./pull-request-tool";
import { type PullRequestContext, SourceControlProvider } from "./source-control";
import type { EngineToolName } from "./workflow-action-entry";

export const make = Effect.gen(function* () {
  const issueTracker = yield* IssueTracker;
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));

  return Effect.fn("WorkflowRun.engineTools")(function* (
    toolNeeds: ReadonlySet<EngineToolName>,
    toolWorkspaces: ReadonlyArray<RegisteredWorkspace>,
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
    ];
    return { tools, reviewedPullRequests: Ref.get(pullRequestSnapshots) };
  });
});
