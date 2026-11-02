import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAdapter as makeGitHub } from "./github/adapter";
import { GitHubClient } from "./github/client";
import { makeGitHubTrackerTriggerSource } from "./github/tracker-trigger-source";
import { IssueTracker, type IssueTrackerActionService, type IssueTrackerService } from "./issue-tracker";
import { makeAdapter as makeLinear } from "./linear/adapter";
import { LinearClient } from "./linear/client";
import { makeLinearTrackerTriggerSource } from "./linear/tracker-trigger-source";
import type { WorkspaceIssueTrackerBinding } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { WorkflowArtifactStore } from "./workflow-artifact-store";

export const route = (
  github: IssueTrackerActionService,
  linear: IssueTrackerActionService,
  triggerSources: NonNullable<IssueTrackerService["triggerSources"]> = [],
): IssueTrackerService => {
  const forWorkspace = (workspace: WorkspaceIssueTrackerBinding) =>
    workspace.config.issueTracker.type === "linear" ? linear : github;
  return {
    triggerSources,
    rateLimitScope: () => null,
    observe: () => Effect.succeed([]),
    readProse: () => Effect.succeed({ body: "", comments: [] }),
    createIssue: (workspace, input) => forWorkspace(workspace).createIssue(workspace, input),
    commentIssue: (workspace, id, body, writeKey) =>
      forWorkspace(workspace).commentIssue(workspace, id, body, writeKey),
    addLabels: (workspace, id, labels, writeKey) =>
      forWorkspace(workspace).addLabels(workspace, id, labels, writeKey),
    removeLabel: (workspace, id, label, writeKey) =>
      forWorkspace(workspace).removeLabel(workspace, id, label, writeKey),
    closeIssue: (workspace, id, writeKey) => forWorkspace(workspace).closeIssue(workspace, id, writeKey),
  };
};

export const routedLayer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const githubClient = yield* GitHubClient;
    const linearClient = yield* LinearClient;
    const registry = yield* WorkspaceRegistry;
    const artifacts = yield* WorkflowArtifactStore;
    return route(makeGitHub(githubClient), makeLinear(linearClient), [
      makeGitHubTrackerTriggerSource(githubClient, registry.state, artifacts),
      makeLinearTrackerTriggerSource(linearClient, registry.state, artifacts),
    ]);
  }),
);
