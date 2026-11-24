import { assert, describe, it } from "@effect/vitest";

import { localContributionId } from "./contribution";

describe("localContributionId", () => {
  it("keeps same-named files in different Authoring trees as different identities", () => {
    assert.strictEqual(localContributionId("local:repo", "skill", "release"), "local:repo/skill/release");
    assert.strictEqual(
      localContributionId("local:private", "skill", "release"),
      "local:private/skill/release",
    );
  });

  it("uses the established MCP identity segment", () => {
    assert.strictEqual(localContributionId("local:repo", "mcp-server", "tools"), "local:repo/mcp/tools");
  });
});
