import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAdapter as makeGitHub } from "./github/adapter";
import { GitHubClient } from "./github/client";
import { actionsOf, IssueTracker, type IssueTrackerService } from "./issue-tracker";
import { makeAdapter as makeLinear } from "./linear/adapter";
import { LinearClient } from "./linear/client";
import type { WorkspaceIssueTrackerBinding } from "./projector";

export const route = (github: IssueTrackerService, linear: IssueTrackerService): IssueTrackerService => {
  const forWorkspace = (workspace: WorkspaceIssueTrackerBinding) =>
    workspace.config.issueTracker.type === "linear" ? linear : github;
  const actionsFor = (workspace: WorkspaceIssueTrackerBinding) => actionsOf(forWorkspace(workspace));

  return {
    rateLimitScope: (workspace) => forWorkspace(workspace).rateLimitScope(workspace),
    observe: (workspace) => forWorkspace(workspace).observe(workspace),
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
    createIssue: (workspace, input) => actionsFor(workspace).createIssue(workspace, input),
    commentIssue: (workspace, id, body, writeKey) =>
      actionsFor(workspace).commentIssue(workspace, id, body, writeKey),
    addLabels: (workspace, id, labels, writeKey) =>
      actionsFor(workspace).addLabels(workspace, id, labels, writeKey),
    removeLabel: (workspace, id, label, writeKey) =>
      actionsFor(workspace).removeLabel(workspace, id, label, writeKey),
    closeIssue: (workspace, id, writeKey) => actionsFor(workspace).closeIssue(workspace, id, writeKey),
  };
};

export const routedLayer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    return route(makeGitHub(yield* GitHubClient), makeLinear(yield* LinearClient));
  }),
);
