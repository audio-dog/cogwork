import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTracker, type IssueTrackerService } from "../issue-tracker";
import { LinearClient, type LinearClientService } from "./client";
import { makeIssueActions, makeIssueReads } from "./host";

const make = (client: LinearClientService) =>
  ({ ...makeIssueReads(client), ...makeIssueActions(client) }) satisfies IssueTrackerService;

export const layer = Layer.effect(IssueTracker, Effect.map(LinearClient, make));

export { make as makeAdapter };
