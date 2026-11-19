import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAdapter as makeGitHub } from "./github/adapter";
import { GitHubClient } from "./github/client";
import { IssueTracker, type IssueTrackerService } from "./issue-tracker";
import { makeAdapter as makeLinear } from "./linear/adapter";
import { LinearClient } from "./linear/client";
import type { WorkspaceIssueTrackerBinding } from "./projector";

export const route = (github: IssueTrackerService, linear: IssueTrackerService): IssueTrackerService => {
  const forWorkspace = (workspace: WorkspaceIssueTrackerBinding) =>
    workspace.config.issueTracker.type === "linear" ? linear : github;
  return {
    observe: (workspace) => forWorkspace(workspace).observe(workspace),
    openItemsChangedSince: (workspace, sinceMillis) =>
      forWorkspace(workspace).openItemsChangedSince(workspace, sinceMillis),
    openItemsWithLabel: (workspace, label) => forWorkspace(workspace).openItemsWithLabel(workspace, label),
    readItem: (workspace, id) => forWorkspace(workspace).readItem(workspace, id),
    readProse: (workspace, id) => forWorkspace(workspace).readProse(workspace, id),
    readTriggerProse: (workspace, id) => forWorkspace(workspace).readTriggerProse(workspace, id),
    labelAppliedAt: (workspace, id, label) => forWorkspace(workspace).labelAppliedAt(workspace, id, label),
    listLabels: (workspace) => forWorkspace(workspace).listLabels(workspace),
    assignees: (workspace, id) => forWorkspace(workspace).assignees(workspace, id),
    createIssue: (workspace, input) => forWorkspace(workspace).createIssue(workspace, input),
    commentIssue: (workspace, id, body, writeKey) =>
      forWorkspace(workspace).commentIssue(workspace, id, body, writeKey),
    addLabels: (workspace, id, labels) => forWorkspace(workspace).addLabels(workspace, id, labels),
    removeLabel: (workspace, id, label) => forWorkspace(workspace).removeLabel(workspace, id, label),
    closeIssue: (workspace, id) => forWorkspace(workspace).closeIssue(workspace, id),
  };
};

export const routedLayer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const githubClient = yield* GitHubClient;
    const linearClient = yield* LinearClient;
    return route(makeGitHub(githubClient), makeLinear(linearClient));
  }),
);
