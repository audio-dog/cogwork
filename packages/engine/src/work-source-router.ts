import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAdapter as makeGitHub } from "./github/adapter";
import { GitHubClient } from "./github/client";
import { makeAdapter as makeLinear } from "./linear/adapter";
import { LinearClient } from "./linear/client";
import type { RegisteredWorkspace } from "./projector";
import { WorkSource, type WorkSourceService } from "./work-source";

export const route = (github: WorkSourceService, linear: WorkSourceService): WorkSourceService => {
  const forWorkspace = (workspace: RegisteredWorkspace) =>
    workspace.config.workSource.type === "linear" ? linear : github;

  return {
    rateLimitScope: (workspace) => forWorkspace(workspace).rateLimitScope(workspace),
    observe: (workspace) => forWorkspace(workspace).observe(workspace),
    claim: (workspace, id, claim) => forWorkspace(workspace).claim(workspace, id, claim),
    release: (workspace, id) => forWorkspace(workspace).release(workspace, id),
    recordAttempt: (workspace, id, attempt, reason) =>
      forWorkspace(workspace).recordAttempt(workspace, id, attempt, reason),
    recordFollowUp: (workspace, id, marker, detail) =>
      forWorkspace(workspace).recordFollowUp(workspace, id, marker, detail),
    note: (workspace, id, detail) => forWorkspace(workspace).note(workspace, id, detail),
    setRoles: (workspace, id, changes) => forWorkspace(workspace).setRoles(workspace, id, changes),
  };
};

export const routedLayer = Layer.effect(
  WorkSource,
  Effect.gen(function* () {
    return route(makeGitHub(yield* GitHubClient), makeLinear(yield* LinearClient));
  }),
);
