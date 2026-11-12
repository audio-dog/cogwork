import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTracker, type IssueTrackerService } from "../issue-tracker";
import { GitHubClient, type GitHubClientService } from "./client";
import { makeIssueActions, makeIssueReads } from "./host";

const make = (client: GitHubClientService) =>
  ({ ...makeIssueReads(client), ...makeIssueActions(client) }) satisfies IssueTrackerService;

export const layer = Layer.effect(IssueTracker, Effect.map(GitHubClient, make));

export { make as makeAdapter };
