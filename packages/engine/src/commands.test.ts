import { connectionIdOf, type IssueTrackerConfig, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getIssueTrackerPeople } from "./commands";
import { GitHubClient } from "./github/client";
import { LinearClient } from "./linear/client";
import type { RegisteredWorkspace } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";

const workspaceOf = (name: string, issueTracker: typeof IssueTrackerConfig.Encoded): RegisteredWorkspace => ({
  source: "test",
  contributions: [],
  repository: "acme/web",
  config: Schema.decodeSync(WorkspaceConfig)({
    id: Schema.decodeSync(WorkspaceId)(name),
    displayName: name,
    checkoutPath: `/repos/${name}`,
    issueTracker,
  }),
});

const github = workspaceOf("web", { type: "github" });
const linear = workspaceOf("app", { type: "linear", teams: ["ENG"] });

const trackers = Layer.mergeAll(
  Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces: [github, linear], failures: [] })),
  Layer.mock(GitHubClient, {
    listAssignees: (repo) =>
      Effect.succeed(repo.connectionId === connectionIdOf("github", "acme") ? ["taylorfsteele"] : []),
  }),
  Layer.mock(LinearClient, {
    listActiveUsers: (ref) =>
      Effect.succeed(
        ref.account.connectionId === connectionIdOf("linear", "acme")
          ? [
              {
                id: "5f8c1a2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b",
                name: "Taylor Steele",
                displayName: "taylor.steele ",
              },
              { id: "0b6d9c1e-7a2f-4c3d-9e8b-1a2b3c4d5e6f", name: "Ada Lovelace", displayName: "" },
              { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", name: " ", displayName: "" },
            ]
          : [],
      ),
  }),
);

describe("getIssueTrackerPeople", () => {
  it.effect("offers a GitHub workspace's assignable logins through the chosen Connection", () =>
    Effect.gen(function* () {
      const people = yield* getIssueTrackerPeople({
        workspace: github.config.id,
        connection: connectionIdOf("github", "acme"),
      });

      assert.deepStrictEqual(people, [{ identity: "taylorfsteele", label: "taylorfsteele" }]);
    }).pipe(Effect.provide(trackers)),
  );

  it.effect("offers a Linear workspace's active users by name and stores their user id", () =>
    Effect.gen(function* () {
      const people = yield* getIssueTrackerPeople({
        workspace: linear.config.id,
        connection: connectionIdOf("linear", "acme"),
      });

      assert.deepStrictEqual(people, [
        { identity: "5f8c1a2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b", label: "taylor.steele" },
        { identity: "0b6d9c1e-7a2f-4c3d-9e8b-1a2b3c4d5e6f", label: "Ada Lovelace" },
      ]);
    }).pipe(Effect.provide(trackers)),
  );

  it.effect("refuses a Connection from another tracker so no credential leaves for the wrong service", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        getIssueTrackerPeople({
          workspace: linear.config.id,
          connection: connectionIdOf("github", "acme"),
        }),
      );

      assert.include(
        Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "listed people",
        "is not a linear Connection",
      );
    }).pipe(Effect.provide(trackers)),
  );
});
