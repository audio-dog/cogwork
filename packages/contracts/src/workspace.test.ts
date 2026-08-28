import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { IssueTrackerConfig, linearTeams } from "./workspace";

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
