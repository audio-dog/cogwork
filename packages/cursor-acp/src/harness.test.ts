import { once } from "node:events";
import { type AgUiEvent, agUiStructuredOutputComplete, agUiUsage, HarnessName } from "@cogwork/contracts";
import { Harness, type SessionStore } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { resolveAllSecrets } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  type CursorRunChat,
  cursorModelOptions,
  cursorRunner,
  estimatedUsage,
  mcpWorkspaceProjection,
  toEvent,
  withEstimatedUsage,
} from "./harness";

const collect = (stream: Stream.Stream<AgUiEvent, Harness.HarnessError>) =>
  Effect.runPromise(Stream.runCollect(stream));

const cursorName = Schema.decodeSync(HarnessName)("cursor");

const sessionStore: SessionStore.SessionStoreService = {
  persistence: memoryPersistence(),
  resumeHandle: () => Effect.succeed(null),
  mint: () => Effect.die(new Error("unexpected mint")),
};

const unexpected = () => Effect.die(new Error("unexpected service access"));

const harnessServices: Harness.HarnessRunnerServices = {
  sessionStore,
  contextAssembler: { assemble: unexpected },
  credentialStore: {
    bearerToken: unexpected,
    persist: unexpected,
    invalidate: unexpected,
    providerKey: unexpected,
    persistProviderKey: unexpected,
  },
};

const request = (checkoutPath: string) =>
  ({
    harness: cursorName,
    stage: "triage",
    skill: "triage-agent",
    checkoutPath,
    session: null,
    prompt: "triage the issue",
    model: "auto",
    effort: null,
    mcpSkills: [],
  }) satisfies Harness.HarnessRequest;

const fakeCursorAgent = new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url).pathname;

const stalledChat = (signal: AbortSignal) => ({
  [Symbol.asyncIterator]: () => {
    const aborted = once(signal, "abort").then(() => {
      throw new Error("aborted");
    });
    return { next: () => aborted, return: () => aborted };
  },
});

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

describe("cursorRunner", () => {
  it("declares the opaque-handle session kind", () => {
    const runner = cursorRunner({ name: cursorName });
    assert.strictEqual(runner.sessionKind, "opaque-handle");
  });

  it.effect("aborts the underlying chat when the harness stream is interrupted", () =>
    Effect.gen(function* () {
      const captured = Promise.withResolvers<AbortController>();
      const runChat: CursorRunChat = ({ abortController }) => {
        captured.resolve(abortController);
        return stalledChat(abortController.signal);
      };
      const runner = cursorRunner({ name: cursorName, runChat });
      const harness = Harness.make([runner], harnessServices);
      const execution = yield* Effect.forkChild(
        Stream.runDrain(harness.run(request("/tmp"))).pipe(Effect.timeout("1 second")),
      );
      const abortController = yield* Effect.promise(() => captured.promise);

      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(execution).pipe(Effect.flip);

      assert.strictEqual(error._tag, "TimeoutError");
      assert.isTrue(abortController.signal.aborted);
    }),
  );

  it.live("streams one structured triage result through the native Cursor ACP adapter", () =>
    Effect.gen(function* () {
      const checkout = yield* Effect.acquireRelease(
        Effect.promise(() => localProcessSandbox({}).create({})),
        (sandbox) => Effect.promise(() => sandbox.destroy()),
      );
      const runner = cursorRunner({
        name: cursorName,
        agentBin: `node ${fakeCursorAgent}`,
      });
      const harness = Harness.make([runner], harnessServices);

      const events = yield* Stream.runCollect(harness.run(request(checkout.id)));
      const completions = events.filter((event) => agUiStructuredOutputComplete(event) !== null);

      assert.lengthOf(completions, 1);
      assert.isTrue(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.live("fails malformed Cursor structured output without coercing its prose", () =>
    Effect.gen(function* () {
      const checkout = yield* Effect.acquireRelease(
        Effect.promise(() => localProcessSandbox({}).create({})),
        (sandbox) => Effect.promise(() => sandbox.destroy()),
      );
      const runner = cursorRunner({
        name: cursorName,
        agentBin: `node ${fakeCursorAgent} --malformed`,
      });
      const harness = Harness.make([runner], harnessServices);

      const error = yield* Effect.flip(Stream.runDrain(harness.run(request(checkout.id))));

      assert.strictEqual(error.reason, "turn");
      assert.isTrue(error.retryable);
    }),
  );
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

describe("estimatedUsage", () => {
  it("counts tokens as ceil(chars / 4) and marks the result estimated", () => {
    assert.deepStrictEqual(estimatedUsage(40, 20), {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: true,
    });
  });

  it("rounds partial tokens up so any output still shows a count", () => {
    assert.deepStrictEqual(estimatedUsage(3, 1), {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      estimated: true,
    });
  });
});

describe("withEstimatedUsage", () => {
  it("attaches an estimate from prompt + streamed text when the terminal event has none", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      { type: "TEXT_MESSAGE_CONTENT", delta: "hello" },
      { type: "REASONING_MESSAGE_CONTENT", delta: "abcd" },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ];

    return collect(withEstimatedUsage(8, Stream.fromIterable(events))).then((out) => {
      const finished = out.at(-1);
      assert.strictEqual(finished?.type, "RUN_FINISHED");
      assert.deepStrictEqual(finished && agUiUsage(finished), {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        estimated: true,
      });
    });
  });

  it("leaves a run that already reports real usage untouched", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      { type: "TEXT_MESSAGE_CONTENT", delta: "hello" },
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
    ];

    return collect(withEstimatedUsage(8, Stream.fromIterable(events))).then((out) => {
      const finished = out.at(-1);
      assert.deepStrictEqual(finished && agUiUsage(finished), {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      });
    });
  });
});
