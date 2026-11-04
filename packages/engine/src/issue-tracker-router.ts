import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAdapter as makeGitHub } from "./github/adapter";
import { GitHubClient } from "./github/client";
import { makeGitHubTrackerTriggerSource } from "./github/tracker-trigger-source";
import { IssueTracker, type IssueTrackerService } from "./issue-tracker";
import { makeAdapter as makeLinear } from "./linear/adapter";
import { LinearClient } from "./linear/client";
import { makeLinearTrackerTriggerSource } from "./linear/tracker-trigger-source";
import type { WorkspaceIssueTrackerBinding } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { WorkflowArtifactStore } from "./workflow-artifact-store";

export const route = (
  github: IssueTrackerService,
  linear: IssueTrackerService,
  triggerSources: NonNullable<IssueTrackerService["triggerSources"]> = [],
): IssueTrackerService => {
  const forWorkspace = (workspace: WorkspaceIssueTrackerBinding) =>
    workspace.config.issueTracker.type === "linear" ? linear : github;
  return {
    triggerSources,
    observe: (workspace) => forWorkspace(workspace).observe(workspace),
    readProse: (workspace, id) => forWorkspace(workspace).readProse(workspace, id),
    assignees: (workspace, id) => forWorkspace(workspace).assignees?.(workspace, id) ?? Effect.succeed([]),
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
    const registry = yield* WorkspaceRegistry;
    const artifacts = yield* WorkflowArtifactStore;
    return route(makeGitHub(githubClient), makeLinear(linearClient), [
      makeGitHubTrackerTriggerSource(githubClient, registry.state, artifacts),
      makeLinearTrackerTriggerSource(linearClient, registry.state, artifacts),
    ]);
  }),
);
