import { HarnessName, SessionId } from "@cogwork/contracts";
import { type ContextAssembler, type CredentialStore, Harness, type SessionStore } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { codexText } from "@tanstack/ai-codex";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type CodexRunChat,
  type CodexRunChatOptions,
  codexModelOptions,
  codexRunner,
  codexRuntimeConfig,
  renderContext,
} from "./harness";

const name = Schema.decodeSync(HarnessName)("codex");
const session = Schema.decodeSync(SessionId)("session-1");

const assembled: ContextAssembler.AssembledContext = {
  layers: [
    { kind: "global", source: "/home/AGENTS.md", content: "global rules" },
    { kind: "repo", source: "/repo/AGENTS.md", content: "repo rules" },
    { kind: "playbook", source: "/skills/implement/SKILL.md", content: "playbook rules" },
  ],
  skillPath: "/home/skills/implement",
};

const persistence = memoryPersistence();

const sessionStore: SessionStore.SessionStoreService = {
  persistence,
  resumeHandle: () => Effect.succeed("thread-123"),
  mint: () => Effect.die(new Error("unexpected mint")),
};

const contextAssembler: ContextAssembler.ContextAssemblerService = {
  assemble: () => Effect.succeed(assembled),
};

const unexpected = () => Effect.die(new Error("unexpected credential-store access"));

const credentialStore: CredentialStore.CredentialStoreService = {
  bearerToken: unexpected,
  persist: unexpected,
  invalidate: unexpected,
  providerKey: unexpected,
  persistProviderKey: unexpected,
};

const makeRequest = (overrides: Partial<Harness.HarnessRequest> = {}): Harness.HarnessRequest => ({
  harness: name,
  stage: "implement",
  skill: "implement-agent",
  checkoutPath: "/repo",
  session,
  prompt: "implement the issue",
  model: "gpt-5.6-sol",
  effort: "high",
  mcpSkills: [],
  ...overrides,
});

const chunks: ReadonlyArray<StreamChunk> = [
  {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: "call-1",
    messageId: "message-1",
    content: "done",
    role: "tool",
  },
  { type: EventType.RUN_FINISHED, runId: "run-1", threadId: "thread-123" },
];

const toAsyncIterable = <A>(items: ReadonlyArray<A>): AsyncIterable<A> => ({
  [Symbol.asyncIterator]: () => {
    const iterator = items[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  },
});

const makeLiveHarness = (args = "") =>
  Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (sandbox) => Effect.promise(() => sandbox.destroy()),
  ).pipe(
    Effect.map((handle) => ({
      handle,
      harness: Harness.make(
        [
          codexRunner({
            name,
            codexExecutable: `node ${new URL("./fixtures/fake-codex.mjs", import.meta.url).pathname}${args}`,
          }),
        ],
        { sessionStore, contextAssembler, credentialStore },
      ),
    })),
  );

describe("codexRunner", () => {
  it("declares an opaque Codex-owned session", () => {
    assert.strictEqual(codexRunner({ name }).sessionKind, "opaque-handle");
  });

  it.effect("assembles context, applies policy, resumes Codex, and bridges every event field", () =>
    Effect.gen(function* () {
      const adapterCalls: Array<Parameters<typeof codexText>> = [];
      const runCalls: Array<CodexRunChatOptions> = [];
      const runChat: CodexRunChat = (options) => {
        runCalls.push(options);
        return toAsyncIterable(chunks);
      };
      const runner = codexRunner({
        name,
        makeAdapter: (model, config) => {
          adapterCalls.push([model, config]);
          return codexText(model, config);
        },
        runChat,
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      const events = yield* Stream.runCollect(harness.run(makeRequest()));

      assert.deepStrictEqual(adapterCalls, [
        [
          "gpt-5.6-sol",
          {
            approvalPolicy: "never",
            sandboxMode: "workspace-write",
            networkAccessEnabled: true,
            modelReasoningEffort: "high",
          },
        ],
      ]);
      const call = runCalls[0];
      if (!call) return assert.fail("runChat was not called");
      assert.deepStrictEqual(call.messages, [{ role: "user", content: "implement the issue" }]);
      assert.deepStrictEqual(call.systemPrompts, renderContext(assembled));
      assert.deepStrictEqual(call.modelOptions, {
        sessionId: "thread-123",
        modelReasoningEffort: "high",
      });
      assert.lengthOf(call.middleware, 1);
      const bridged = Array.from(events);
      assert.lengthOf(bridged, chunks.length);
      chunks.forEach((chunk, index) => {
        const event = bridged[index];
        if (!event) assert.fail(`missing bridged event ${index}`);
        assert.sameMembers(Object.keys(event), Object.keys(chunk));
        Object.entries(chunk).forEach(([key, value]) => {
          assert.deepStrictEqual(Reflect.get(event, key), value);
        });
      });
    }),
  );

  it.effect("aborts the Codex run when the harness stream is interrupted", () =>
    Effect.gen(function* () {
      const calls: Array<CodexRunChatOptions> = [];
      const runner = codexRunner({
        name,
        runChat: (options) => {
          calls.push(options);
          return toAsyncIterable(chunks);
        },
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      yield* harness.run(makeRequest()).pipe(Stream.take(1), Stream.runDrain);

      assert.isTrue(calls[0]?.abortController.signal.aborted);
    }),
  );

  it.effect("passes MCP bearer values only through the Codex child environment", () =>
    Effect.gen(function* () {
      const adapterCalls: Array<Parameters<typeof codexText>> = [];
      const runner = codexRunner({
        name,
        makeAdapter: (model, config) => {
          adapterCalls.push([model, config]);
          return codexText(model, config);
        },
        runChat: () => toAsyncIterable(chunks),
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      yield* Stream.runDrain(
        harness.run(
          makeRequest({
            mcpSkills: [
              {
                name: "linear",
                endpoint: "https://mcp.linear.app/mcp/readonly",
                bearer: Redacted.make("mcp-secret"),
              },
            ],
          }),
        ),
      );

      const config = adapterCalls[0]?.[1];
      if (!config) return assert.fail("adapter was not created");
      assert.deepStrictEqual(config.config, {
        "mcp_servers.linear.url": '"https://mcp.linear.app/mcp/readonly"',
        "mcp_servers.linear.bearer_token_env_var": '"COGWORK_MCP_6c696e656172"',
      });
      assert.deepStrictEqual(config.env, { COGWORK_MCP_6c696e656172: "mcp-secret" });
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(config.config);
      assert.notInclude(serialized, "mcp-secret");
    }),
  );

  it.effect("treats a missing Codex login or binary as a non-retryable launch failure", () =>
    Effect.gen(function* () {
      const runner = codexRunner({
        name,
        runChat: () =>
          toAsyncIterable([
            {
              type: EventType.RUN_ERROR,
              message: "codex command not found; run codex login",
              error: { message: "codex command not found; run codex login" },
            },
          ]),
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      const error = yield* Effect.flip(Stream.runDrain(harness.run(makeRequest())));

      assert.strictEqual(error.reason, "launch");
      assert.isFalse(error.retryable);
    }),
  );

  it.effect("keeps ordinary not-found turn errors retryable", () =>
    Effect.gen(function* () {
      const runner = codexRunner({
        name,
        runChat: () =>
          toAsyncIterable([
            {
              type: EventType.RUN_ERROR,
              message: "File not found: /repo/input.json",
              error: { message: "File not found: /repo/input.json" },
            },
          ]),
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      const error = yield* Effect.flip(Stream.runDrain(harness.run(makeRequest())));

      assert.strictEqual(error.reason, "turn");
      assert.isTrue(error.retryable);
    }),
  );

  it.live("completes a fresh run through the Codex adapter and native event loop", () =>
    Effect.gen(function* () {
      const { handle, harness } = yield* makeLiveHarness();

      const events = yield* Stream.runCollect(
        harness.run(makeRequest({ checkoutPath: handle.id, session: null })),
      );
      const response = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta;
      if (!response) return assert.fail("fake Codex emitted no response");
      const capture = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            args: Schema.Array(Schema.String),
            prompt: Schema.String,
            cwd: Schema.String,
          }),
        ),
      )(response);

      assert.include(capture.args, "workspace-write");
      assert.include(capture.args, 'approval_policy="never"');
      assert.include(capture.args, "sandbox_workspace_write.network_access=true");
      assert.notInclude(capture.args, "danger-full-access");
      assert.notInclude(capture.args, "resume");
      assert.include(capture.prompt, "global rules");
      assert.include(capture.prompt, "repo rules");
      assert.include(capture.prompt, "playbook rules");
      assert.include(capture.prompt, "Mandatory playbook resources: /home/skills/implement");
      assert.include(capture.prompt, "implement the issue");
      assert.strictEqual(capture.cwd.split("/").at(-1), handle.id.split("/").at(-1));
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "CUSTOM" &&
            event.name === "codex.session-id" &&
            Schema.is(Schema.Struct({ sessionId: Schema.Literal("fake-thread-1") }))(event.value),
        ),
      );
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.live("terminates the Codex child process when the run is interrupted", () =>
    Effect.gen(function* () {
      const { handle, harness } = yield* makeLiveHarness(" --hang");

      yield* harness
        .run(makeRequest({ checkoutPath: handle.id, session: null }))
        .pipe(Stream.take(1), Stream.runDrain);

      const pid = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(
        yield* Effect.promise(() => handle.fs.read("/workspace/.pid")),
      );
      const probe = yield* Effect.promise(() => handle.process.exec(`kill -0 ${pid}`));
      assert.notStrictEqual(probe.exitCode, 0);
    }),
  );
});

describe("codexRuntimeConfig", () => {
  it("pins unattended runs to workspace-write with network and no approvals", () => {
    assert.deepStrictEqual(codexRuntimeConfig("high"), {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
      modelReasoningEffort: "high",
    });
  });
});

describe("renderContext", () => {
  it("keeps every instruction layer ordered and exposes the provisioned playbook path", () => {
    assert.deepStrictEqual(renderContext(assembled), [
      "global rules",
      "repo rules",
      "playbook rules",
      "Mandatory playbook resources: /home/skills/implement",
    ]);
  });
});

describe("codexModelOptions", () => {
  it("passes both the Codex thread handle and requested effort", () => {
    assert.deepStrictEqual(codexModelOptions("thread-123", "high"), {
      sessionId: "thread-123",
      modelReasoningEffort: "high",
    });
  });

  it("omits a missing thread handle", () => {
    assert.deepStrictEqual(codexModelOptions(null, "medium"), {
      modelReasoningEffort: "medium",
    });
  });
});
