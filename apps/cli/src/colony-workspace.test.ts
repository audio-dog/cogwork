import { assert, describe, it } from "@effect/vitest";
import colony from "../config/colony.workspace";

describe("Colony workspace", () => {
  it("uses Codex with its Linear MCP skill and per-playbook model settings", () => {
    assert.strictEqual(colony.harness.preferred, "codex");
    assert.deepStrictEqual(colony.mcpSkills, [
      {
        name: "linear",
        endpoint: "https://mcp.linear.app/mcp/readonly",
        auth: { type: "credential-store" },
      },
    ]);
    assert.deepStrictEqual(colony.playbook?.triage, {
      enabled: true,
      model: "gpt-5.6-sol",
      effort: "high",
    });
    assert.deepStrictEqual(colony.playbook?.implement, colony.playbook?.triage);
    assert.deepStrictEqual(colony.playbook?.["follow-up"], colony.playbook?.triage);
  });
});
