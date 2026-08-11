import type { Harness } from "@clanker-forge/engine";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { resolveAllSecrets } from "@tanstack/ai-sandbox";
import * as Redacted from "effect/Redacted";
import { assert, describe, it } from "vitest";
import { cursorModelOptions, mcpWorkspaceProjection, toEvent } from "./harness";

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

describe("cursorModelOptions", () => {
  it("turns a resolved handle into Cursor's resume sessionId", () => {
    assert.deepStrictEqual(cursorModelOptions("cursor-abc", null), { sessionId: "cursor-abc" });
  });

  it("omits sessionId when there is no handle to resume from", () => {
    assert.deepStrictEqual(cursorModelOptions(null, "high"), { effort: "high" });
  });

  it("is empty when the run neither resumes nor sets an effort", () => {
    assert.deepStrictEqual(cursorModelOptions(null, null), {});
  });
});

describe("toEvent", () => {
  it("carries a tool call result whole, args/results and all, including keys the schema never names", () => {
    const chunk = {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "call-1",
      messageId: "msg-1",
      content: "diff applied",
      role: "tool",
    } satisfies StreamChunk;

    const event = toEvent(chunk);

    assert.strictEqual(event.type, "TOOL_CALL_RESULT");
    assert.strictEqual(event.content, "diff applied");
    assert.strictEqual(event.toolCallId, "call-1");
    assert.strictEqual(event.messageId, "msg-1");
    assert.strictEqual(event.role, "tool");
  });

  it("carries streamed tool call arguments", () => {
    const chunk = {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-1",
      delta: '{"path":"src/x.ts"}',
    } satisfies StreamChunk;

    const event = toEvent(chunk);

    assert.strictEqual(event.type, "TOOL_CALL_ARGS");
    assert.strictEqual(event.toolCallId, "call-1");
    assert.strictEqual(event.delta, '{"path":"src/x.ts"}');
  });

  it("carries reasoning deltas", () => {
    const chunk = {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "msg-0",
      delta: "weighing the two approaches",
    } satisfies StreamChunk;

    const event = toEvent(chunk);

    assert.strictEqual(event.type, "REASONING_MESSAGE_CONTENT");
    assert.strictEqual(event.delta, "weighing the two approaches");
    assert.strictEqual(event.messageId, "msg-0");
  });
});
