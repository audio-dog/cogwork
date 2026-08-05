import type { Harness } from "@clanker-forge/engine";
import { resolveAllSecrets } from "@tanstack/ai-sandbox";
import * as Redacted from "effect/Redacted";
import { assert, describe, it } from "vitest";
import { mcpWorkspaceProjection } from "./harness";

describe("mcpWorkspaceProjection", () => {
  it("returns nothing and no secrets when the run declares no MCP skills", () => {
    const projection = mcpWorkspaceProjection([]);
    assert.deepStrictEqual(projection.skills, []);
    assert.isFalse(projection.hasSecrets);
    assert.deepStrictEqual(resolveAllSecrets(projection.secrets), {});
  });

  it("maps a public skill onto a plain TanStack mcpSkill with no auth header or secret", () => {
    const skills: ReadonlyArray<Harness.ResolvedMcpSkill> = [
      { name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly", bearer: null },
    ];
    const projection = mcpWorkspaceProjection(skills);
    assert.deepStrictEqual(projection.skills, [
      { kind: "mcp", name: "linear", config: { url: "https://mcp.linear.app/mcp/readonly" } },
    ]);
    assert.isFalse(projection.hasSecrets);
    assert.deepStrictEqual(resolveAllSecrets(projection.secrets), {});
  });

  it("routes an authed skill's bearer through a secret, never as a plaintext header value", () => {
    const skills: ReadonlyArray<Harness.ResolvedMcpSkill> = [
      { name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly", bearer: Redacted.make("tok_123") },
    ];
    const projection = mcpWorkspaceProjection(skills);

    const [projected] = projection.skills;
    if (projected?.kind !== "mcp") throw new Error("expected an mcp skill");
    assert.strictEqual(projected.name, "linear");
    assert.strictEqual(projected.config.url, "https://mcp.linear.app/mcp/readonly");
    const authorization = projected.config.headers?.Authorization;
    assert.isObject(authorization);
    assert.notStrictEqual(authorization, "tok_123");
    assert.notStrictEqual(authorization, "Bearer tok_123");

    assert.isTrue(projection.hasSecrets);
    assert.deepStrictEqual(resolveAllSecrets(projection.secrets), { MCP_LINEAR_BEARER: "tok_123" });
  });
});
