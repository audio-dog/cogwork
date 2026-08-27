import {
  agUiSessionId,
  agUiStructuredOutputComplete,
  FollowUpStageResult,
  HarnessName,
  ImplementStageResult,
  SessionId,
  TriageStageResult,
} from "@cogwork/contracts";
import { type ContextAssembler, type CredentialStore, Harness, type SessionStore } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { codexText } from "@tanstack/ai-codex";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type CodexRunChat,
  type CodexRunChatOptions,
  type CodexRunnerOptions,
  codexChildEnvironment,
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
  profile: overrides.profile ?? "full",
});

const testRunner = (options: Omit<CodexRunnerOptions, "name">) =>
  codexRunner({
    name,
    resolveGitMetadataDirectory: () => Effect.succeed(null),
    ...options,
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

const runErrorChunk = (message: string) =>
  ({
    type: EventType.RUN_ERROR,
    message,
    error: { message },
  }) satisfies StreamChunk;

const structuredCompletions = (events: ReadonlyArray<Harness.AgUiEvent>) =>
  events.flatMap((event) => {
    const completion = agUiStructuredOutputComplete(event);
    return completion === null ? [] : [completion];
  });

const structuredCapture = (events: ReadonlyArray<Harness.AgUiEvent>) => {
  const completion = structuredCompletions(events)[0];
  if (!completion) return assert.fail("fake Codex emitted no structured result");
  return Schema.decodeUnknownEffect(ImplementStageResult)(completion.object).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            args: Schema.Array(Schema.String),
            prompt: Schema.String,
            cwd: Schema.optional(Schema.String),
            hasCodexConfig: Schema.optional(Schema.Boolean),
          }),
        ),
      )(result.summary),
    ),
  );
};

const fakeCodexExecutable = (args = "") =>
  `node ${new URL("./fixtures/fake-codex.mjs", import.meta.url).pathname}${args}`;

const makeLiveHarness = (codexExecutable = fakeCodexExecutable()) =>
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
            codexExecutable,
          }),
        ],
        { sessionStore, contextAssembler, credentialStore },
      ),
    })),
  );

const linkedWorktree = (handle: SandboxHandle) =>
  Effect.gen(function* () {
    const checkoutPath = `${handle.id}/linked-worktree`;
    const setup = yield* Effect.promise(() =>
      handle.process.exec(
        [
          "git init",
          'git config user.email "cogwork@example.com"',
          'git config user.name "Cogwork"',
          "git commit --allow-empty -m initial",
          `git worktree add -b linked-worktree ${checkoutPath}`,
        ].join(" && "),
      ),
    );
    assert.strictEqual(setup.exitCode, 0);
    const commonDirectory = yield* Effect.promise(() =>
      handle.process.exec(`git -C ${checkoutPath} rev-parse --git-common-dir`),
    );
    assert.strictEqual(commonDirectory.exitCode, 0);
    return { checkoutPath, commonDirectory: commonDirectory.stdout.trim() };
  });

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
      const runner = testRunner({
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
            env: codexChildEnvironment(),
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
      const runner = testRunner({
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
      const runner = testRunner({
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
        "mcp_servers.cogwork_mcp_6c_69_6e_65_61_72_0.url": '"https://mcp.linear.app/mcp/readonly"',
        "mcp_servers.cogwork_mcp_6c_69_6e_65_61_72_0.bearer_token_env_var":
          '"COGWORK_MCP_6C_69_6E_65_61_72_0_BEARER"',
      });
      assert.deepStrictEqual(config.env, {
        ...codexChildEnvironment(),
        COGWORK_MCP_6C_69_6E_65_61_72_0_BEARER: "mcp-secret",
      });
      assert.strictEqual(config.env?.COGWORK_MCP_6C_69_6E_65_61_72_0_BEARER, "mcp-secret");
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(config.config);
      assert.notInclude(serialized, "mcp-secret");
    }),
  );

  it.effect("projects every MCP skill into a distinct safe Codex identity", () =>
    Effect.gen(function* () {
      const adapterCalls: Array<Parameters<typeof codexText>> = [];
      const runner = testRunner({
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
              { name: "linear.api", endpoint: "https://mcp.example.com/public", bearer: null },
              {
                name: "linear-api",
                endpoint: "https://mcp.example.com/private",
                bearer: Redacted.make("rotated-secret"),
              },
            ],
          }),
        ),
      );

      const config = adapterCalls[0]?.[1];
      if (!config) return assert.fail("adapter was not created");
      assert.deepStrictEqual(config.config, {
        "mcp_servers.cogwork_mcp_6c_69_6e_65_61_72_2e_61_70_69_0.url": '"https://mcp.example.com/public"',
        "mcp_servers.cogwork_mcp_6c_69_6e_65_61_72_2d_61_70_69_1.url": '"https://mcp.example.com/private"',
        "mcp_servers.cogwork_mcp_6c_69_6e_65_61_72_2d_61_70_69_1.bearer_token_env_var":
          '"COGWORK_MCP_6C_69_6E_65_61_72_2D_61_70_69_1_BEARER"',
      });
      assert.deepStrictEqual(config.env, {
        ...codexChildEnvironment(),
        COGWORK_MCP_6C_69_6E_65_61_72_2D_61_70_69_1_BEARER: "rotated-secret",
      });
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(config.config);
      assert.notInclude(serialized, "rotated-secret");
    }),
  );

  it.effect("rebuilds the child environment with a rotated MCP bearer on every run", () =>
    Effect.gen(function* () {
      const adapterCalls: Array<Parameters<typeof codexText>> = [];
      const runner = testRunner({
        makeAdapter: (model, config) => {
          adapterCalls.push([model, config]);
          return codexText(model, config);
        },
        runChat: () => toAsyncIterable(chunks),
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });
      const mcpSkill = (bearer: string): ReadonlyArray<Harness.ResolvedMcpSkill> => [
        { name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly", bearer: Redacted.make(bearer) },
      ];

      yield* Stream.runDrain(harness.run(makeRequest({ mcpSkills: mcpSkill("first-secret") })));
      yield* Stream.runDrain(harness.run(makeRequest({ mcpSkills: mcpSkill("rotated-secret") })));

      const firstConfig = adapterCalls[0]?.[1];
      const rotatedConfig = adapterCalls[1]?.[1];
      if (!firstConfig || !rotatedConfig) return assert.fail("adapter was not created for both runs");
      assert.strictEqual(firstConfig.env?.COGWORK_MCP_6C_69_6E_65_61_72_0_BEARER, "first-secret");
      assert.strictEqual(rotatedConfig.env?.COGWORK_MCP_6C_69_6E_65_61_72_0_BEARER, "rotated-secret");
    }),
  );

  it.effect("gives an actionable handoff for a missing Codex binary", () =>
    Effect.gen(function* () {
      const runner = testRunner({
        runChat: () => toAsyncIterable([runErrorChunk("spawn codex ENOENT")]),
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      const error = yield* Effect.flip(Stream.runDrain(harness.run(makeRequest())));

      assert.strictEqual(error.reason, "launch");
      assert.isFalse(error.retryable);
      assert.include(error.message, "Install Codex CLI");
    }),
  );

  it.effect("gives an actionable handoff for a missing Codex login", () =>
    Effect.gen(function* () {
      const runner = testRunner({
        runChat: () => toAsyncIterable([runErrorChunk("You are not logged in")]),
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      const error = yield* Effect.flip(Stream.runDrain(harness.run(makeRequest())));

      assert.strictEqual(error.reason, "launch");
      assert.isFalse(error.retryable);
      assert.include(error.message, "codex login");
    }),
  );

  it.effect("keeps ordinary not-found turn errors retryable", () =>
    Effect.gen(function* () {
      const runner = testRunner({
        runChat: () => toAsyncIterable([runErrorChunk("File not found: /repo/input.json")]),
      });
      const harness = Harness.make([runner], { sessionStore, contextAssembler, credentialStore });

      const error = yield* Effect.flip(Stream.runDrain(harness.run(makeRequest())));

      assert.strictEqual(error.reason, "turn");
      assert.isTrue(error.retryable);
    }),
  );

  it.effect("keeps provider authentication turn errors retryable", () =>
    Effect.gen(function* () {
      const runner = testRunner({
        runChat: () => toAsyncIterable([runErrorChunk("Provider authentication failed with status 401")]),
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
      const capture = yield* structuredCapture(events);

      assert.include(capture.args, "workspace-write");
      assert.include(capture.args, 'approval_policy="never"');
      assert.notInclude(capture.args, "danger-full-access");
      assert.include(capture.args, "sandbox_workspace_write.network_access=true");
      assert.notInclude(capture.args, "resume");
      assert.include(capture.prompt, "global rules");
      assert.include(capture.prompt, "repo rules");
      assert.include(capture.prompt, "playbook rules");
      assert.include(capture.prompt, "Mandatory playbook resources: /home/skills/implement");
      assert.include(capture.prompt, "implement the issue");
      assert.strictEqual(capture.cwd?.split("/").at(-1), handle.id.split("/").at(-1));
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

  it.live("grants Codex access to linked-worktree Git metadata", () =>
    Effect.gen(function* () {
      const { handle } = yield* makeLiveHarness();
      const { checkoutPath, commonDirectory } = yield* linkedWorktree(handle);

      const harness = Harness.make([codexRunner({ name, codexExecutable: fakeCodexExecutable() })], {
        sessionStore,
        contextAssembler,
        credentialStore,
      });
      const events = yield* Stream.runCollect(harness.run(makeRequest({ checkoutPath, session: null })));
      const capture = yield* structuredCapture(events);

      assert.include(capture.args, "--add-dir");
      assert.include(capture.args, commonDirectory);
    }),
  );

  it.live("probes authenticated Codex linked-worktree commits when explicitly enabled", () =>
    Effect.gen(function* () {
      const probe = yield* Config.string("COGWORK_LIVE_CODEX_PROBE").pipe(Config.withDefault("0"));
      if (probe !== "1") return;
      const { handle, harness } = yield* makeLiveHarness("codex");
      const { checkoutPath } = yield* linkedWorktree(handle);
      const events = yield* Stream.runCollect(
        harness.run(
          makeRequest({
            checkoutPath,
            session: null,
            prompt:
              "Create a file named codex-probe.txt, add it to Git, and commit it with the message codex linked worktree probe. Then return the required implement result. Do not open a pull request.",
          }),
        ),
      );
      const completions = structuredCompletions(events);

      assert.lengthOf(completions, 1);
      yield* Schema.decodeUnknownEffect(ImplementStageResult)(completions[0]?.object);
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
      const commit = yield* Effect.promise(() =>
        handle.process.exec(`git -C ${checkoutPath} log -1 --format=%s`),
      );
      assert.strictEqual(commit.exitCode, 0);
      assert.strictEqual(commit.stdout.trim(), "codex linked worktree probe");
    }),
  );

  it.live("returns a plain capture when the stage has no output schema", () =>
    Effect.gen(function* () {
      const { handle, harness } = yield* makeLiveHarness();
      const events = yield* Stream.runCollect(
        harness.run(makeRequest({ checkoutPath: handle.id, session: null, stage: "verify" })),
      );
      const response = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta;
      if (!response) return assert.fail("fake Codex emitted no response");
      const capture = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            args: Schema.Array(Schema.String),
            prompt: Schema.String,
          }),
        ),
      )(response);

      assert.notInclude(capture.args, "--output-schema");
      assert.include(capture.prompt, "implement the issue");
    }),
  );

  it.live("keeps an MCP bearer out of the Codex command, events, and worktree configuration", () =>
    Effect.gen(function* () {
      const { handle, harness } = yield* makeLiveHarness();
      const events = yield* Stream.runCollect(
        harness.run(
          makeRequest({
            checkoutPath: handle.id,
            session: null,
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
      const capture = yield* structuredCapture(events);
      const bearer = yield* Effect.promise(() => handle.fs.read("/workspace/.mcp-bearer"));
      const serializedEvents = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(events);

      assert.strictEqual(bearer, "mcp-secret");
      assert.isFalse(capture.hasCodexConfig ?? true);
      assert.notInclude(capture.args.join(" "), "mcp-secret");
      assert.notInclude(capture.prompt, "mcp-secret");
      assert.notInclude(serializedEvents, "mcp-secret");
    }),
  );

  it.live("streams one structured triage result through the native Codex adapter", () =>
    Effect.gen(function* () {
      const { handle, harness } = yield* makeLiveHarness();
      const events = yield* Stream.runCollect(
        harness.run(
          makeRequest({
            checkoutPath: handle.id,
            session: null,
            stage: "triage",
            skill: "triage-agent",
            prompt: "triage the issue",
          }),
        ),
      );
      const completions = structuredCompletions(events);
      assert.lengthOf(completions, 1);
      const result = yield* Schema.decodeUnknownEffect(TriageStageResult)(completions[0]?.object);
      const capture = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            args: Schema.Array(Schema.String),
            prompt: Schema.String,
          }),
        ),
      )(result.proposal);
      assert.include(capture.args, "--output-schema");
      assert.include(capture.prompt, "triage the issue");
      assert.isTrue(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.live("streams one structured follow-up result through the native Codex adapter", () =>
    Effect.gen(function* () {
      const { handle, harness } = yield* makeLiveHarness();
      const events = yield* Stream.runCollect(
        harness.run(
          makeRequest({
            checkoutPath: handle.id,
            session: null,
            stage: "follow-up",
            skill: "follow-up-agent",
            prompt: "follow up on the pull request",
          }),
        ),
      );
      const completions = structuredCompletions(events);

      assert.lengthOf(completions, 1);
      yield* Schema.decodeUnknownEffect(FollowUpStageResult)(completions[0]?.object);
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.live("records a fresh Codex handle and resumes it natively with reinjected context", () =>
    Effect.gen(function* () {
      const { handle, harness: freshHarness } = yield* makeLiveHarness();
      const freshEvents = yield* Stream.runCollect(
        freshHarness.run(makeRequest({ checkoutPath: handle.id, session: null, prompt: "first run prompt" })),
      );
      const recordedHandle = freshEvents.map(agUiSessionId).find((value) => value !== null);
      if (!recordedHandle) return assert.fail("fresh Codex run emitted no session handle");

      const resumedHarness = Harness.make(
        [
          codexRunner({
            name,
            codexExecutable: `node ${new URL("./fixtures/fake-codex.mjs", import.meta.url).pathname}`,
          }),
        ],
        {
          sessionStore: { ...sessionStore, resumeHandle: () => Effect.succeed(recordedHandle) },
          contextAssembler,
          credentialStore,
        },
      );
      const resumedEvents = yield* Stream.runCollect(
        resumedHarness.run(makeRequest({ checkoutPath: handle.id, prompt: "current run prompt" })),
      );
      const capture = yield* structuredCapture(resumedEvents);

      assert.include(capture.args, "resume");
      assert.include(capture.args, recordedHandle);
      assert.include(capture.args, "workspace-write");
      assert.include(capture.args, 'approval_policy="never"');
      assert.notInclude(capture.args, "danger-full-access");
      assert.include(capture.prompt, "global rules");
      assert.include(capture.prompt, "repo rules");
      assert.include(capture.prompt, "playbook rules");
      assert.include(capture.prompt, "Mandatory playbook resources: /home/skills/implement");
      assert.include(capture.prompt, "current run prompt");
      assert.notInclude(capture.prompt, "first run prompt");
    }),
  );

  it.live("terminates the Codex child process when the run is interrupted", () =>
    Effect.gen(function* () {
      const { handle, harness } = yield* makeLiveHarness(fakeCodexExecutable(" --hang"));

      yield* harness
        .run(makeRequest({ checkoutPath: handle.id, session: null }))
        .pipe(Stream.take(2), Stream.runDrain);

      const pid = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(
        yield* Effect.promise(() => handle.fs.read("/workspace/.pid")),
      );
      const stopped = yield* Effect.promise(() =>
        handle.process.exec(
          `for attempt in $(seq 1 100); do state=$(ps -o stat= -p ${pid} 2>/dev/null); case "$state" in ""|Z*) exit 0 ;; esac; sleep 0.01; done; exit 1`,
        ),
      );
      assert.strictEqual(stopped.exitCode, 0);
    }),
  );
});

describe("codexRuntimeConfig", () => {
  it("maps each operation posture to Codex's bounded unattended sandbox", () => {
    assert.deepStrictEqual(codexRuntimeConfig("high", "full"), {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
      modelReasoningEffort: "high",
    });
    assert.deepStrictEqual(codexRuntimeConfig("high", "read-only"), {
      approvalPolicy: "never",
      sandboxMode: "read-only",
      modelReasoningEffort: "high",
    });
  });
});

describe("codexChildEnvironment", () => {
  it("preserves Codex login prerequisites without forwarding host secrets", () => {
    assert.deepStrictEqual(
      codexChildEnvironment({
        HOME: "/home/codex",
        PATH: "/usr/bin",
        CODEX_HOME: "/codex",
        XDG_CONFIG_HOME: "/config",
        GITHUB_TOKEN: "github-secret",
        GH_TOKEN: "gh-secret",
        OPENAI_API_KEY: "openai-secret",
        CODEX_API_KEY: "codex-secret",
      }),
      {
        HOME: "/home/codex",
        PATH: "/usr/bin",
        CODEX_HOME: "/codex",
        XDG_CONFIG_HOME: "/config",
      },
    );
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
