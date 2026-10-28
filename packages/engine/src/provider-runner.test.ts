import {
  type AgUiEvent,
  agUiIsFileDiffUnavailableEvent,
  agUiTextDelta,
  HarnessName,
  RunPlan,
  SessionId,
  stageResultJsonSchema,
} from "@cogwork/contracts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { EventType, InMemoryRunStore, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import {
  type ChatWithInterruptsPersistence,
  defineAIPersistence,
  memoryPersistence,
} from "@tanstack/ai-persistence";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ContextAssembler, type ContextAssemblerService, type InstructionLayer } from "./context-assembler";
import { CredentialError, CredentialStore, type CredentialStoreService } from "./credential-store";
import type { HarnessRequest } from "./harness";
import {
  defaultModelAdapterFactory,
  type ModelAdapterFactory,
  parseModelRef,
  providerModelRefs,
} from "./provider-adapter";
import {
  defaultLoopBudget,
  defaultRunBudget,
  mergeProviderFileDiffs,
  providerInstructionContext,
  providerRunner,
  type RunChat,
  type RunChatOptions,
} from "./provider-runner";
import { SessionStore, type SessionStoreService } from "./session-store";

const SECRET = "sk-super-secret-value";
const harnessName = Schema.decodeSync(HarnessName)("provider");
const sessionId = Schema.decodeSync(SessionId)("sess-resume-1");

const sampleLayer: InstructionLayer = {
  kind: "operating-instructions",
  source: "/operating-instructions/implement-agent/INSTRUCTIONS.md",
  content: "Follow the implement playbook.",
};

const toAsyncIterable = <A>(items: ReadonlyArray<A>): AsyncIterable<A> => {
  const iterator = items[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<A> => ({ next: () => Promise.resolve(iterator.next()) }),
  };
};

const scriptedChunks: ReadonlyArray<StreamChunk> = [
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello world" },
  { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
];

const structuredTriageJson = '{"_tag":"triage","role":"ready-for-agent","proposal":"Verified and ready."}';

const nativeStructuredAdapter = {
  kind: "text",
  name: "fake",
  model: "fake",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: undefined,
    systemPromptMetadata: undefined,
  },
  chatStream: () =>
    toAsyncIterable<StreamChunk>([
      { type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: structuredTriageJson },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1", finishReason: "stop" },
    ]),
  structuredOutput: () => Promise.reject(new Error("unexpected structured finalization")),
  supportsCombinedToolsAndSchema: () => true,
} satisfies AnyTextAdapter;

const unexpected = () => Effect.die(new Error("credential store method not expected in this test"));

const credentialStore = (providerKey: CredentialStoreService["providerKey"]): CredentialStoreService => ({
  bearerToken: unexpected,
  resolveSource: unexpected,
  persist: unexpected,
  invalidate: () => Effect.void,
  providerKey,
  persistProviderKey: unexpected,
  configureConnection: unexpected,
  removeConnection: unexpected,
});

const credentialLayer = (providerKey: CredentialStoreService["providerKey"]) =>
  Layer.succeed(CredentialStore, credentialStore(providerKey));

const keyProvider: CredentialStoreService["providerKey"] = () =>
  Effect.succeed({ source: "env", key: Redacted.make(SECRET) });

const missingKeyProvider: CredentialStoreService["providerKey"] = () =>
  Effect.fail(new CredentialError({ account: "openai", message: "no api key for openai", retryable: false }));

const stubPersistence = (thread: ReadonlyArray<ModelMessage>): ChatWithInterruptsPersistence =>
  defineAIPersistence({
    stores: {
      messages: {
        loadThread: () => Promise.resolve([...thread]),
        saveThread: () => Promise.resolve(),
      },
      runs: new InMemoryRunStore(),
      interrupts: memoryPersistence().stores.interrupts,
    },
  });

const sessionStore = (thread: ReadonlyArray<ModelMessage>): SessionStoreService => ({
  persistence: stubPersistence(thread),
  resumeHandle: () => Effect.succeed(null),
  mint: () => Effect.die(new Error("mint not expected in this test")),
});

const sessionLayer = (thread: ReadonlyArray<ModelMessage>) =>
  Layer.succeed(SessionStore, sessionStore(thread));

const contextService = (layers: ReadonlyArray<InstructionLayer>): ContextAssemblerService => ({
  assemble: () =>
    Effect.succeed({
      layers,
      operatingInstructionsPath: "/operating-instructions/implement-agent",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () => Effect.void,
});

const contextLayer = (layers: ReadonlyArray<InstructionLayer>) =>
  Layer.succeed(ContextAssembler, contextService(layers));

interface RequestOverrides {
  readonly checkoutPath?: string;
  readonly session?: HarnessRequest["session"];
  readonly stage?: "triage" | "implement";
  readonly model?: string;
}

const request = (overrides: RequestOverrides): HarnessRequest => {
  const stage = overrides.stage ?? "implement";
  const profile = stage === "triage" ? "read-only" : "full";
  const structuredOutput = stageResultJsonSchema(stage)["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  });
  return {
    plan: Schema.decodeSync(RunPlan)({
      id: "run-provider-test",
      operation: stage,
      harness: { name: harnessName, model: overrides.model ?? "openai/gpt-4o", options: {}, profile },
      instructions: [{ ...sampleLayer, kind: "repo" }],
      operatingInstructions: {
        name: "implement-agent",
        path: "/operating-instructions/implement-agent",
        resources: [{ source: "/operating-instructions/implement-agent/GUIDE.md", content: "guide" }],
      },
      tools: ["read", "write", "edit", "bash", "glob", "grep", "webfetch"],
      skills: [],
      mcp: [],
      subagents: [],
      commands: [],
      hooks: [],
      middleware: ["persistence", "instruction-context"],
      structuredOutput,
      connections: [],
      messages: [{ role: "user", content: "do the thing" }],
      workContext: {
        reference: { workItem: "#1", url: null },
        prose: {
          body: "Ship the requested provider change.",
          comments: [
            {
              author: "maintainer",
              authorAssociation: "MEMBER",
              body: "Keep the adapter contract stable.",
              createdAtMillis: 2,
            },
          ],
        },
        facts: { roles: [], assignees: [], openBlockers: 0, claim: null, priority: "medium", pr: null },
        observation: { generation: 1, observedAtMillis: 1 },
      },
      sandbox: { workspace: overrides.checkoutPath ?? "/tmp/does-not-matter", policy: profile },
      persistence: { sessionKind: "owned-transcript" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection: [],
        observation: { generation: 1, observedAtMillis: 1 },
      },
    }),
    session: "session" in overrides ? (overrides.session ?? null) : sessionId,
    mcpCredentials: new Map(),
  };
};

const scratchCheckout = Effect.fn("runner.test.scratchCheckout")(function* () {
  const handle = yield* Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (open) => Effect.promise(() => open.destroy()),
  );
  return handle.id;
});

const providerRunnerLayer = (
  credentials = credentialLayer(keyProvider),
  httpClient = FetchHttpClient.layer,
) =>
  Layer.mergeAll(
    contextLayer([sampleLayer]),
    credentials,
    sessionLayer([]),
    NodeFileSystem.layer,
    NodePath.layer,
    httpClient,
  );

describe("providerRunner", { timeout: 30_000 }, () => {
  it("projects Operating Instructions resources into provider context", () => {
    assert.deepStrictEqual(
      providerInstructionContext(request({}).plan).map(({ content }) => content),
      [sampleLayer.content, "guide"],
    );
  });

  it("declares the owned-transcript session kind", () => {
    assert.strictEqual(providerRunner({ name: harnessName }).sessionKind, "owned-transcript");
  });

  it("serves every managed provider model", () => {
    assert.deepStrictEqual(
      providerRunner({ name: harnessName }).catalog.models.map(({ value }) => value),
      providerModelRefs,
    );
  });

  it.live(
    "bridges chat output, folds the resumed thread, hands the redacted key to the adapter, and never leaks it",
    () =>
      Effect.gen(function* () {
        const checkoutPath = yield* scratchCheckout();
        const adapterCalls: Array<{ provider: string; model: string; key: Redacted.Redacted<string> }> = [];
        const capturedOptions: Array<RunChatOptions> = [];

        const makeAdapter: ModelAdapterFactory = (resolved, key) => {
          adapterCalls.push({ provider: resolved.provider, model: resolved.model, key });
          return defaultModelAdapterFactory(resolved, key);
        };
        const runChat: RunChat = (options) => {
          capturedOptions.push(options);
          return toAsyncIterable(scriptedChunks);
        };
        const runner = providerRunner({ name: harnessName, makeAdapter, runChat });

        const events = yield* Stream.runCollect(
          runner.run(request({ checkoutPath, session: sessionId })),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              providerRunnerLayer(),
              sessionLayer([{ role: "assistant", content: "earlier turn" }]),
            ),
          ),
        );

        const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(events);
        assert.include(serialized, "hello world");
        assert.notInclude(serialized, SECRET);
        assert.isTrue(events.some((event) => agUiTextDelta(event) === "hello world"));

        assert.lengthOf(adapterCalls, 1);
        assert.strictEqual(adapterCalls[0]?.provider, "openai");
        assert.strictEqual(adapterCalls[0]?.model, "gpt-4o");
        assert.strictEqual(adapterCalls[0] ? Redacted.value(adapterCalls[0].key) : null, SECRET);

        const options = capturedOptions[0];
        if (!options) return assert.fail("runChat was never invoked");
        assert.strictEqual(options.messages.length, 3);
        assert.deepStrictEqual(options.messages[0], { role: "assistant", content: "earlier turn" });
        assert.strictEqual(options.messages[1]?.role, "user");
        assert.deepStrictEqual(options.messages[2], { role: "user", content: "do the thing" });
        assert.include(String(options.messages[1]?.content), "Ship the requested provider change.");
        assert.include(String(options.messages[1]?.content), "Keep the adapter contract stable.");
        assert.lengthOf([...options.tools], 7);
        assert.isTrue(options.middleware.some((middleware) => middleware.name === "cogwork-context"));
        assert.isTrue(options.middleware.some((middleware) => middleware.name === "chat-persistence"));
        assert.strictEqual(options.runId, "run-provider-test");
        assert.strictEqual(options.threadId, sessionId);
      }),
    30000,
  );

  it.live("keys a fresh chat thread by its Session", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const capturedOptions: Array<RunChatOptions> = [];
      const runChat: RunChat = (options) => {
        capturedOptions.push(options);
        return toAsyncIterable(scriptedChunks);
      };
      const runner = providerRunner({ name: harnessName, runChat });

      yield* Stream.runDrain(runner.run(request({ checkoutPath }))).pipe(
        Effect.provide(providerRunnerLayer()),
      );

      assert.strictEqual(capturedOptions[0]?.threadId, sessionId);
    }),
  );

  it.live("refuses to open a chat without a Session", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const runner = providerRunner({ name: harnessName, runChat: () => toAsyncIterable(scriptedChunks) });

      const error = yield* Effect.flip(
        Stream.runDrain(runner.run(request({ checkoutPath, session: null }))).pipe(
          Effect.provide(providerRunnerLayer()),
        ),
      );

      assert.strictEqual(error.reason, "launch");
      assert.include(error.message, "Session");
    }),
  );

  it.live("aborts the chat request when the provider stream is interrupted", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const captured = Promise.withResolvers<RunChatOptions>();
      const runChat: RunChat = (options) => {
        captured.resolve(options);
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.withResolvers<IteratorResult<StreamChunk>>().promise,
          }),
        };
      };
      const runner = providerRunner({ name: harnessName, runChat });
      const fiber = yield* Stream.runDrain(runner.run(request({ checkoutPath }))).pipe(
        Effect.provide(providerRunnerLayer()),
        Effect.forkChild,
      );
      const chatOptions = yield* Effect.promise(() => captured.promise);

      yield* Fiber.interrupt(fiber);

      assert.isTrue(chatOptions.abortController.signal.aborted);
    }),
  );

  it.effect("keeps the provider Run alive and reports a dead diff feed", () =>
    Effect.gen(function* () {
      const harnessEvents = Stream.make(
        { type: "RUN_STARTED" } satisfies AgUiEvent,
        { type: "RUN_FINISHED", finishReason: "stop" } satisfies AgUiEvent,
      );
      const merged = yield* mergeProviderFileDiffs(harnessEvents, () =>
        Stream.fail(new Error("raw provider watcher failure")),
      );
      const events = yield* Stream.runCollect(merged);

      assert.isTrue(events.some(agUiIsFileDiffUnavailableEvent));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.effect("releases the provider terminal event when the diff feed does not drain", () =>
    Effect.gen(function* () {
      const harnessEvents = Stream.make(
        { type: "RUN_STARTED" } satisfies AgUiEvent,
        { type: "RUN_FINISHED", finishReason: "stop" } satisfies AgUiEvent,
      );
      const merged = yield* mergeProviderFileDiffs(harnessEvents, () => Stream.never);
      const collected = yield* Stream.runCollect(merged).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("10 seconds");
      const events = yield* Fiber.join(collected);

      assert.isTrue(events.some(agUiIsFileDiffUnavailableEvent));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.live("runs owned tools with the caller's HTTP client", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("from caller", { status: 200 }))),
      );
      const runChat: RunChat = (options) => {
        const execute = options.tools.find((tool) => tool.name === "webfetch")?.execute;
        if (!execute) throw new Error("webfetch tool was not provided");
        const iterator = Promise.resolve(execute({ url: "https://example.invalid" })).then((result) => {
          assert.deepStrictEqual(result, {
            url: "https://example.invalid",
            status: 200,
            content: "from caller",
          });
          return toAsyncIterable(scriptedChunks)[Symbol.asyncIterator]();
        });
        return {
          [Symbol.asyncIterator]: () => ({ next: () => iterator.then((current) => current.next()) }),
        };
      };
      const runner = providerRunner({ name: harnessName, runChat });

      yield* Stream.runDrain(runner.run(request({ checkoutPath }))).pipe(
        Effect.provide(
          providerRunnerLayer(credentialLayer(keyProvider), Layer.succeed(HttpClient.HttpClient, httpClient)),
        ),
        Effect.timeout("5 seconds"),
      );
    }),
  );

  it.live("streams one structured triage result through TanStack's provider path", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const runner = providerRunner({
        name: harnessName,
        makeAdapter: () => nativeStructuredAdapter,
      });

      const events = yield* Stream.runCollect(runner.run(request({ stage: "triage", checkoutPath }))).pipe(
        Effect.provide(providerRunnerLayer()),
      );

      assert.strictEqual(
        events.filter((event) => event.type === "CUSTOM" && event.name === "structured-output.complete")
          .length,
        1,
      );
      assert.isTrue(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.effect("fails with a launch error when the model has no wired provider", () =>
    Effect.gen(function* () {
      const runner = providerRunner({
        name: harnessName,
        runChat: () => toAsyncIterable(scriptedChunks),
      });
      const error = yield* Effect.flip(
        Stream.runDrain(runner.run(request({ model: "unknown-provider/whatever" }))).pipe(
          Effect.provide(providerRunnerLayer()),
        ),
      );
      assert.strictEqual(error._tag, "HarnessError");
      assert.strictEqual(error.reason, "launch");
    }),
  );

  it.effect("fails with a launch error when no api key is configured", () =>
    Effect.gen(function* () {
      const runner = providerRunner({
        name: harnessName,
        runChat: () => toAsyncIterable(scriptedChunks),
      });
      const error = yield* Effect.flip(
        Stream.runDrain(runner.run(request({}))).pipe(
          Effect.provide(providerRunnerLayer(credentialLayer(missingKeyProvider))),
        ),
      );
      assert.strictEqual(error._tag, "HarnessError");
      assert.strictEqual(error.reason, "launch");
    }),
  );
});

describe("parseModelRef", () => {
  it("splits a provider/model reference", () => {
    assert.deepStrictEqual(parseModelRef("openai/gpt-4o"), { provider: "openai", model: "gpt-4o" });
  });

  it("returns null for a bare model with no provider prefix", () => {
    assert.isNull(parseModelRef("gpt-4o"));
  });

  it("returns null for an unwired provider prefix", () => {
    assert.isNull(parseModelRef("openrouter/some-model"));
  });
});

describe("defaultLoopBudget", () => {
  it("gives read-only profiles fewer turns than full profiles", () => {
    assert.isBelow(defaultLoopBudget("read-only"), defaultLoopBudget("full"));
  });
});

describe("defaultRunBudget", () => {
  it("gives read-only profiles less wall-clock time than full profiles", () => {
    assert.strictEqual(defaultRunBudget("read-only"), "15 minutes");
    assert.strictEqual(defaultRunBudget("full"), "2 hours");
  });
});
