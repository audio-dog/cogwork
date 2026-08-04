import type { McpSkill } from "@clanker-forge/contracts";
import { assert, describe, it } from "vitest";
import { mcpWorkspaceSkills } from "./harness";

describe("mcpWorkspaceSkills", () => {
  it("returns nothing when the run declares no MCP skills", () => {
    assert.deepStrictEqual(mcpWorkspaceSkills([]), []);
  });

  it("maps each MCP skill onto a TanStack mcpSkill pointed at its endpoint", () => {
    const skills: ReadonlyArray<McpSkill> = [
      { name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly" },
    ];
    assert.deepStrictEqual(mcpWorkspaceSkills(skills), [
      { kind: "mcp", name: "linear", config: { url: "https://mcp.linear.app/mcp/readonly" } },
    ]);
  });
});
