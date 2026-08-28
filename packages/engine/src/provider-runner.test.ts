import { agUiTextDelta, HarnessName, SessionId } from "@cogwork/contracts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { EventType, InMemoryRunStore, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import { type ChatWithInterruptsPersistence, defineAIPersistence } from "@tanstack/ai-persistence";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ContextAssembler,
  ContextAssemblerError,
  type ContextAssemblerService,
  type InstructionLayer,
} from "./context-assembler";
import { CredentialError, CredentialStore, type CredentialStoreService } from "./credential-store";
import type { HarnessRequest } from "./harness";
import { makeInterruptStore } from "./interrupt-store";
import { defaultModelAdapterFactory, type ModelAdapterFactory, parseModelRef } from "./provider-adapter";
import {
  defaultLoopBudget,
  defaultRunBudget,
  providerRunner,
  type RunChat,
  type RunChatOptions,
  resolveContextLayers,
} from "./provider-runner";
import { SessionStore, type SessionStoreService } from "./session-store";

const SECRET = "sk-super-secret-value";
const harnessName = Schema.decodeSync(HarnessName)("provider");
const sessionId = Schema.decodeSync(SessionId)("sess-resume-1");

const sampleLayer: InstructionLayer = {
  kind: "playbook",
  source: "/skills/implement-agent/SKILL.md",
  content: "Follow the implement playbook.",
};

const reqStub = { cwd: "/repo", projectRoot: "/repo", skill: "implement-agent", contributions: [] };

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
  Effect.fail(new CredentialError({ account: "openai", message: "no api key for openai" }));

const stubPersistence = (thread: ReadonlyArray<ModelMessage>): ChatWithInterruptsPersistence =>
  defineAIPersistence({
    stores: {
      messages: {
        loadThread: () => Promise.resolve([...thread]),
        saveThread: () => Promise.resolve(),
      },
      runs: new InMemoryRunStore(),
      interrupts: makeInterruptStore(),
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
  assemble: () => Effect.succeed({ layers, skillPath: "/skills/implement-agent" }),
});

const contextLayer = (layers: ReadonlyArray<InstructionLayer>) =>
  Layer.succeed(ContextAssembler, contextService(layers));

const request = (overrides: Partial<HarnessRequest>): HarnessRequest => ({
  harness: harnessName,
  stage: "implement",
  skill: "implement-agent",
  checkoutPath: "/tmp/does-not-matter",
  session: null,
  prompt: "do the thing",
  model: "openai/gpt-4o",
  effort: null,
  mcpSkills: [],
  contributions: [],
  ...overrides,
  profile: overrides.profile ?? "full",
});

const scratchCheckout = Effect.fn("runner.test.scratchCheckout")(function* () {
  const handle = yield* Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (open) => Effect.promise(() => open.destroy()),
  );
  return handle.id;
});

describe("providerRunner", () => {
  it("declares the owned-transcript session kind", () => {
    assert.strictEqual(providerRunner({ name: harnessName }).sessionKind, "owned-transcript");
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
              contextLayer([sampleLayer]),
              credentialLayer(keyProvider),
              sessionLayer([{ role: "assistant", content: "earlier turn" }]),
              NodeFileSystem.layer,
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
        assert.deepStrictEqual(
          [...options.messages],
          [
            { role: "assistant", content: "earlier turn" },
            { role: "user", content: "do the thing" },
          ],
        );
        assert.lengthOf([...options.tools], 7);
        assert.isTrue(options.middleware.some((middleware) => middleware.name === "cogwork-context"));
        assert.isTrue(options.middleware.some((middleware) => middleware.name === "chat-persistence"));
      }),
    30000,
  );

  it.live("streams one structured triage result through TanStack's provider path", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const runner = providerRunner({
        name: harnessName,
        makeAdapter: () => nativeStructuredAdapter,
      });

      const events = yield* Stream.runCollect(runner.run(request({ stage: "triage", checkoutPath }))).pipe(
        Effect.provide(
          Layer.mergeAll(
            contextLayer([sampleLayer]),
            credentialLayer(keyProvider),
            sessionLayer([]),
            NodeFileSystem.layer,
          ),
        ),
      );

      assert.strictEqual(
        events.filter((event) => event.type === "CUSTOM" && event.name === "structured-output.complete")
          .length,
        1,
      );
      assert.isTrue(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
      assert.strictEqual(events.at(-1)?.name, "structured-output.complete");
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
          Effect.provide(
            Layer.mergeAll(
              contextLayer([sampleLayer]),
              credentialLayer(keyProvider),
              sessionLayer([]),
              NodeFileSystem.layer,
            ),
          ),
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
          Effect.provide(
            Layer.mergeAll(
              contextLayer([sampleLayer]),
              credentialLayer(missingKeyProvider),
              sessionLayer([]),
              NodeFileSystem.layer,
            ),
          ),
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
  it("gives read-only stages fewer turns than writing stages", () => {
    assert.isBelow(defaultLoopBudget("triage"), defaultLoopBudget("implement"));
    assert.isBelow(defaultLoopBudget("verify"), defaultLoopBudget("follow-up"));
  });
});

describe("defaultRunBudget", () => {
  it("gives read-only stages less wall-clock time than writing stages", () => {
    assert.strictEqual(defaultRunBudget("triage"), "15 minutes");
    assert.strictEqual(defaultRunBudget("verify"), "15 minutes");
    assert.strictEqual(defaultRunBudget("implement"), "2 hours");
    assert.strictEqual(defaultRunBudget("follow-up"), "2 hours");
  });
});

describe("resolveContextLayers", () => {
  it.effect("returns the assembled layers on success", () =>
    Effect.gen(function* () {
      const layers = yield* resolveContextLayers(contextService([sampleLayer]), reqStub, []);
      assert.deepStrictEqual([...layers], [sampleLayer]);
    }),
  );

  it.effect("falls back to the run-start layers when assembly fails", () =>
    Effect.gen(function* () {
      const failing: ContextAssemblerService = {
        assemble: () => Effect.fail(new ContextAssemblerError({ skill: "implement-agent", message: "boom" })),
      };
      const layers = yield* resolveContextLayers(failing, reqStub, [sampleLayer]);
      assert.deepStrictEqual([...layers], [sampleLayer]);
    }),
  );
});
