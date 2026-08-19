import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { IssueTrackerConfig, linearTeams } from "./workspace";

const tracker = (over: Partial<typeof IssueTrackerConfig.Encoded>) =>
  Schema.decodeSync(IssueTrackerConfig)({ type: "linear", ...over });

describe("linearTeams", () => {
  it("reads the single-team shorthand", () => {
    assert.deepStrictEqual([...linearTeams(tracker({ team: "GRO" }))], ["GRO"]);
  });

  it("reads the multi-team list", () => {
    assert.deepStrictEqual([...linearTeams(tracker({ teams: ["GRO", "BIL"] }))], ["GRO", "BIL"]);
  });

  it("merges the shorthand and the list, shorthand first, without duplicates", () => {
    assert.deepStrictEqual([...linearTeams(tracker({ team: "GRO", teams: ["BIL", "GRO"] }))], ["GRO", "BIL"]);
  });

  it("is empty when a Linear tracker names no team", () => {
    assert.deepStrictEqual([...linearTeams(tracker({}))], []);
  });

  it("is empty for a non-Linear tracker", () => {
    assert.deepStrictEqual([...linearTeams(Schema.decodeSync(IssueTrackerConfig)({ type: "github" }))], []);
  });
});
