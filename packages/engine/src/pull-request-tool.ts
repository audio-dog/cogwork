import { TrimmedNonEmptyString, WorkspaceId } from "@cogwork/contracts";
import { toolDefinition } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { PullRequestContext, SourceControlProviderService } from "./source-control";

export const PullRequestToolInput = Schema.Struct({
  workspace: WorkspaceId,
  pull_request: TrimmedNonEmptyString,
});
const inputSchema = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(PullRequestToolInput));

const unavailable = (message: string) =>
  new IssueTrackerError({ reason: "unavailable", retryable: false, message });

export const makePullRequestTool = (
  sourceControl: SourceControlProviderService,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
  recordRead: (workspace: RegisteredWorkspace, pullRequest: PullRequestContext) => Effect.Effect<void> = () =>
    Effect.void,
) => {
  const read = Effect.fn("PullRequestTool.read")(function* (input: typeof PullRequestToolInput.Type) {
    const workspace = workspaces.find(({ config }) => config.id === input.workspace);
    if (!workspace) return yield* unavailable(`Workspace ${input.workspace} is not selected`);
    const pullRequest = yield* sourceControl.readPullRequest(workspace, input.pull_request);
    if (pullRequest === null) return yield* unavailable(`Pull request ${input.pull_request} was not found`);
    yield* recordRead(workspace, pullRequest);
    return { pullRequest };
  });

  return toolDefinition({
    name: "pull-request",
    description:
      "Read a named pull request's description, diff, changed files, and comments in a selected Workspace. This tool is read-only.",
    inputSchema,
  }).server((input) =>
    Effect.runPromise(Schema.decodeEffect(PullRequestToolInput)(input).pipe(Effect.flatMap(read))),
  );
};
