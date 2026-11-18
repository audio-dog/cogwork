import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { WorkspaceState } from "./daemon-event";
import { IssueTrackerConfig, linearTeams, SourceControlConfig, WorkspaceUpdate } from "./workspace";

const tracker = (over: Partial<typeof IssueTrackerConfig.Encoded>) =>
  Schema.decodeSync(IssueTrackerConfig)({ type: "linear", ...over });

describe("linearTeams", () => {
  it("carries a Connection id instead of credential configuration", () => {
    const configured = Schema.decodeSync(IssueTrackerConfig)({
      type: "linear",
      connectionId: "linear/acme",
    });

    assert.strictEqual(configured.connectionId, "linear/acme");
    assert.isFalse("tokenEnv" in configured);
    assert.isFalse("oauth" in configured);
  });

  it("reads a single configured team", () => {
    assert.deepStrictEqual([...linearTeams(tracker({ teams: ["GRO"] }))], ["GRO"]);
  });

  it("reads the multi-team list in order", () => {
    assert.deepStrictEqual([...linearTeams(tracker({ teams: ["GRO", "BIL"] }))], ["GRO", "BIL"]);
  });

  it("drops duplicate teams, keeping first-seen order", () => {
    assert.deepStrictEqual([...linearTeams(tracker({ teams: ["GRO", "BIL", "GRO"] }))], ["GRO", "BIL"]);
  });

  it("is empty when a Linear tracker names no team", () => {
    assert.deepStrictEqual([...linearTeams(tracker({}))], []);
  });

  it("is empty for a non-Linear tracker", () => {
    assert.deepStrictEqual([...linearTeams(Schema.decodeSync(IssueTrackerConfig)({ type: "github" }))], []);
  });
});

describe("workspace account bindings", () => {
  it("drops legacy tracker actor selectors", () => {
    const decoded = Schema.decodeUnknownSync(IssueTrackerConfig)({
      type: "github",
      actorLogin: "legacy-login",
      actorUserId: "legacy-user-id",
    });
    const encoded = Schema.encodeSync(IssueTrackerConfig)(decoded);

    assert.isFalse("actorLogin" in encoded);
    assert.isFalse("actorUserId" in encoded);
  });

  it("drops the legacy source-control actor selector", () => {
    const decoded = Schema.decodeUnknownSync(SourceControlConfig)({
      type: "github",
      actorLogin: "legacy-login",
    });
    const encoded = Schema.encodeSync(SourceControlConfig)(decoded);

    assert.isFalse("actorLogin" in encoded);
  });
});

describe("GitHub priority source", () => {
  it("stores the stable organization issue field ID", () => {
    const configured = Schema.decodeSync(IssueTrackerConfig)({
      type: "github",
      priority: { field: 42 },
    });

    assert.deepStrictEqual(configured.priority, { field: 42 });
  });

  it("rejects typed project coordinates", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(IssueTrackerConfig)({
        type: "github",
        priority: { project: 1, field: "Priority" },
      }),
    );
  });
});

describe("assignee allowlist identities", () => {
  const linearUserId = "5f8c1a2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b";
  const update = (type: string, assigneeAllowlist: ReadonlyArray<string>) => ({
    name: "cogwork",
    issueTracker: { type, connectionId: `${type}/acme`, assigneeAllowlist },
  });
  const refusal = (input: unknown) => {
    const exit = Schema.decodeUnknownExit(WorkspaceUpdate)(input);
    return Exit.isFailure(exit) ? String(exit.cause) : null;
  };

  it.each([
    ["linear", [linearUserId], null],
    ["linear", ["taylor.steele"], "a Linear user id, got taylor.steele"],
    ["github", ["taylorfsteele", "cogwork-bot"], null],
    ["github", ["a b"], "a GitHub login, got a b"],
  ] as const)("decodes a %s update with %j to refusal %s", (type, entries, expected) => {
    const outcome = refusal(update(type, entries));
    if (expected === null) return assert.isNull(outcome);
    assert.include(outcome ?? "accepted", expected);
  });

  it("still publishes a stored workspace whose allowlist holds a username", () => {
    const state = Schema.decodeUnknownSync(WorkspaceState)({
      _tag: "Registered",
      name: "cogwork",
      checkoutPath: "/repos/cogwork",
      issueTracker: "linear",
      record: {
        ...update("linear", ["taylor.steele"]),
        checkoutPath: "/repos/cogwork",
        linearHistory: false,
      },
      contributions: [],
    });

    assert.deepStrictEqual(
      WorkspaceState.guards.Registered(state) ? state.record.issueTracker.assigneeAllowlist : null,
      ["taylor.steele"],
    );
  });
});
