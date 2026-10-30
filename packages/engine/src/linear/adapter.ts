import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCoordinationTracker } from "../coordination-tracker";
import { IssueTracker, type IssueTrackerService } from "../issue-tracker";
import { LinearClient, type LinearClientService } from "./client";
import { makeHost } from "./host";

const make = (client: LinearClientService): IssueTrackerService => {
  const host = makeHost(client);
  return {
    ...makeCoordinationTracker(host),
    assignees: Effect.fn("LinearIssueTracker.assignees")(function* (workspace, id) {
      const ref = yield* host.resolve(workspace, id);
      return yield* client.issueAssignees(ref.target, ref.issueId);
    }),
  };
};

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* LinearClient;
    return make(client);
  }),
);

export { make as makeAdapter };
