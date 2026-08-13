import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCoordinationTracker } from "../coordination-tracker";
import { IssueTracker, type IssueTrackerService } from "../issue-tracker";
import { GitHubClient, type GitHubClientService } from "./client";
import { makeHost } from "./host";

const make = (client: GitHubClientService): IssueTrackerService => makeCoordinationTracker(makeHost(client));

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    return make(client);
  }),
);

export { make as makeAdapter };
