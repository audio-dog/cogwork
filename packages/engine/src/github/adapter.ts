import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCoordinationTracker } from "../coordination-tracker";
import { IssueTracker, type IssueTrackerService } from "../issue-tracker";
import { issueTrackerWorkflowCatalogContribution } from "../issue-workflow-catalog";
import { GitHubClient, type GitHubClientService } from "./client";
import { makeHost, makeIssueActions } from "./host";

const make = (client: GitHubClientService) => {
  const host = makeHost(client);
  return {
    ...makeCoordinationTracker(host),
    ...makeIssueActions(client),
    assignees: Effect.fn("GitHubIssueTracker.assignees")(function* (workspace, id) {
      const ref = yield* host.resolve(workspace, id);
      const issue = yield* client.readIssue(ref.target, ref.number);
      return issue.assignees;
    }),
  } satisfies IssueTrackerService;
};

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    return make(client);
  }),
);

export { make as makeAdapter };

export const workflowCatalogContribution = issueTrackerWorkflowCatalogContribution("github");
