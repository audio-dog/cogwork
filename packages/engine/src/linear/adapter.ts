import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTracker, type IssueTrackerActionService, type IssueTrackerService } from "../issue-tracker";
import { issueTrackerWorkflowCatalogContribution } from "../issue-workflow-catalog";
import { LinearClient, type LinearClientService } from "./client";
import { makeIssueActions } from "./host";

const make = (client: LinearClientService) => {
  return makeIssueActions(client) satisfies IssueTrackerActionService;
};

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* LinearClient;
    const actions = make(client);
    return {
      rateLimitScope: () => null,
      observe: () => Effect.succeed([]),
      readProse: () => Effect.succeed({ body: "", comments: [] }),
      ...actions,
    } satisfies IssueTrackerService;
  }),
);

export { make as makeAdapter };

export const workflowCatalogContribution = issueTrackerWorkflowCatalogContribution("linear");
