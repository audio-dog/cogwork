import { connectionIdOf, type IssueTrackerConfig, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getIssueTrackerPeople } from "./commands";
import { GitHubClient } from "./github/client";
import { LinearClient } from "./linear/client";
import type { RegisteredWorkspace } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry";

const workspaceOf = (name: string, issueTracker: typeof IssueTrackerConfig.Encoded): RegisteredWorkspace => ({
  source: "test",
  contributions: [],
  repository: "acme/web",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: Schema.decodeSync(WorkspaceId)(name),
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
                displayName: "taylor.steele",
              },
              { id: "0b6d9c1e-7a2f-4c3d-9e8b-1a2b3c4d5e6f", name: "Ada Lovelace", displayName: "" },
            ]
          : [],
      ),
  }),
);

describe("getIssueTrackerPeople", () => {
  it.effect("offers a GitHub workspace's assignable logins through the chosen Connection", () =>
    Effect.gen(function* () {
      const people = yield* getIssueTrackerPeople({
        workspace: github.config.name,
        connection: connectionIdOf("github", "acme"),
      });

      assert.deepStrictEqual(people, [{ identity: "taylorfsteele", label: "taylorfsteele" }]);
    }).pipe(Effect.provide(trackers)),
  );

  it.effect("offers a Linear workspace's active users by name and stores their user id", () =>
    Effect.gen(function* () {
      const people = yield* getIssueTrackerPeople({
        workspace: linear.config.name,
        connection: connectionIdOf("linear", "acme"),
      });

      assert.deepStrictEqual(people, [
        { identity: "5f8c1a2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b", label: "taylor.steele" },
        { identity: "0b6d9c1e-7a2f-4c3d-9e8b-1a2b3c4d5e6f", label: "Ada Lovelace" },
      ]);
    }).pipe(Effect.provide(trackers)),
  );
});
