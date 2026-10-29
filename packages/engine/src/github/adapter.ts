import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCoordinationTracker } from "../coordination-tracker";
import { IssueTracker, type IssueTrackerService } from "../issue-tracker";
import { issueTrackerWorkflowCatalogContribution } from "../issue-workflow-catalog";
import { GitHubClient, type GitHubClientService } from "./client";
import { makeHost, makeIssueActions } from "./host";

const make = (client: GitHubClientService) =>
  ({
    ...makeCoordinationTracker(makeHost(client)),
    ...makeIssueActions(client),
  }) satisfies IssueTrackerService;

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    return make(client);
  }),
);

export { make as makeAdapter };

export const workflowCatalogContribution = issueTrackerWorkflowCatalogContribution("github");
