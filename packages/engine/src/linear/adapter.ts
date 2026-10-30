import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCoordinationTracker } from "../coordination-tracker";
import { IssueTracker, type IssueTrackerService } from "../issue-tracker";
import { issueTrackerWorkflowCatalogContribution } from "../issue-workflow-catalog";
import { LinearClient, type LinearClientService } from "./client";
import { makeHost, makeIssueActions } from "./host";

const make = (client: LinearClientService) => {
  const host = makeHost(client);
  return {
    ...makeCoordinationTracker(host),
    ...makeIssueActions(client),
    assignees: Effect.fn("LinearIssueTracker.assignees")(function* (workspace, id) {
      const ref = yield* host.resolve(workspace, id);
      return yield* client.issueAssignees(ref.target, ref.issueId);
    }),
  } satisfies IssueTrackerService;
};

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* LinearClient;
    return make(client);
  }),
);

export { make as makeAdapter };

export const workflowCatalogContribution = issueTrackerWorkflowCatalogContribution("linear");
