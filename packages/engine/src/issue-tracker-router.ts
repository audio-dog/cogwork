import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAdapter as makeGitHub } from "./github/adapter";
import { GitHubClient } from "./github/client";
import { makeGitHubTrackerTriggerSource } from "./github/tracker-trigger-source";
import { IssueTracker, IssueTrackerError, type IssueTrackerService } from "./issue-tracker";
import { makeAdapter as makeLinear } from "./linear/adapter";
import { LinearClient } from "./linear/client";
import { makeLinearTrackerTriggerSource } from "./linear/tracker-trigger-source";
import type { WorkspaceIssueTrackerBinding } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { WorkflowArtifactStore } from "./workflow-artifact-store";

export const route = (github: IssueTrackerService, linear: IssueTrackerService): IssueTrackerService => {
  const forWorkspace = (workspace: WorkspaceIssueTrackerBinding) =>
    workspace.config.issueTracker.type === "linear" ? linear : github;

  return {
    triggerSources: [...(github.triggerSources ?? []), ...(linear.triggerSources ?? [])],
    rateLimitScope: (workspace) => forWorkspace(workspace).rateLimitScope(workspace),
    observe: (workspace) => forWorkspace(workspace).observe(workspace),
    assignees: (workspace, id) => forWorkspace(workspace).assignees?.(workspace, id) ?? Effect.succeed([]),
    workflowCoordination: (workspace, id) => {
      const coordination = forWorkspace(workspace).workflowCoordination;
      return coordination === undefined
        ? Effect.fail(
            new IssueTrackerError({
              reason: "unavailable",
              message: `workflow coordination is unavailable for ${workspace.config.name}`,
            }),
          )
        : coordination(workspace, id);
    },
    readProse: (workspace, id) => forWorkspace(workspace).readProse(workspace, id),
    claim: (workspace, id, claim) => forWorkspace(workspace).claim(workspace, id, claim),
    release: (workspace, id) => forWorkspace(workspace).release(workspace, id),
    note: (workspace, id, detail) => forWorkspace(workspace).note(workspace, id, detail),
    triaged: (workspace, id, outcome) => forWorkspace(workspace).triaged(workspace, id, outcome),
    implemented: (workspace, id, outcome) => forWorkspace(workspace).implemented(workspace, id, outcome),
    followedUp: (workspace, id, outcome) => forWorkspace(workspace).followedUp(workspace, id, outcome),
    attemptFailed: (workspace, id, outcome) => forWorkspace(workspace).attemptFailed(workspace, id, outcome),
    handOff: (workspace, id, outcome) => forWorkspace(workspace).handOff(workspace, id, outcome),
    handBack: (workspace, id, outcome) => forWorkspace(workspace).handBack(workspace, id, outcome),
    stalled: (workspace, id, outcome) => forWorkspace(workspace).stalled(workspace, id, outcome),
    reclassify: (workspace, id, outcome) => forWorkspace(workspace).reclassify(workspace, id, outcome),
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
    return route(
      {
        ...makeGitHub(githubClient),
        triggerSources: [makeGitHubTrackerTriggerSource(githubClient, registry.state, artifacts)],
      },
      {
        ...makeLinear(linearClient),
        triggerSources: [makeLinearTrackerTriggerSource(linearClient, registry.state, artifacts)],
      },
    );
  }),
);
