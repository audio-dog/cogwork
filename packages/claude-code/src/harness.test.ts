import {
  agUiIsSessionHandleEvent,
  agUiIsStructuredOutputComplete,
  FILE_DIFF_EVENT,
  HarnessName,
  LifecycleStage,
  RunPlan,
  SessionId,
} from "@cogwork/contracts";
import { ContextAssembler, CredentialStore, Harness, OperationPolicy, SessionStore } from "@cogwork/engine";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { CLAUDE_CODE_MODELS, type ClaudeCodeTextProviderOptions } from "@tanstack/ai-claude-code";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  type ClaudeCodeRunnerOptions,
  claudeCodeCatalogSources,
  claudeCodeRunner,
  inlineSettingsArgument,
} from "./harness";

const name = Schema.decodeSync(HarnessName)("claude");
const companionName = Schema.decodeSync(HarnessName)("companion");
const hostAuthentication = { mode: "host" } as const;
const byokAuthentication = { mode: "byok" } as const;
const authenticationByMode = {
  host: hostAuthentication,
  byok: byokAuthentication,
} satisfies Record<
  ClaudeCodeRunnerOptions["authentication"]["mode"],
  ClaudeCodeRunnerOptions["authentication"]
>;

const companionRunner = {
  name: companionName,
  sessionKind: "opaque-handle",
  execution: Harness.fullHarnessExecution,
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "runtime-host", fork: false, humanAttach: false },
    structuredOutput: "none",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: true,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "companion login" },
  catalogSources: {
    fallback: Harness.staticCatalogSource(
      { models: [{ value: "companion", label: "Companion" }] },
      { source: "cogwork-fallback", fallbackVersion: "1" },
    ),
  },
  projectedMembers: [],
  planMiddleware: [],
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "Companion is ready" },
      installation: { status: "installed", version: "1" },
      compatibility: { status: "compatible", requirement: ">=1" },
      authentication: { mode: "host", status: "available", diagnostic: "Companion login is ready" },
      diagnostics: [],
    }),
  preflight: () => Effect.void,
  run: () => Stream.empty,
} satisfies Harness.HarnessRunner;

type AdapterHasEffort = "effort" extends keyof ClaudeCodeTextProviderOptions ? true : false;
const adapterHasEffort: AdapterHasEffort = false;
const freshSession = Schema.decodeSync(SessionId)("session-claude-fresh");
const resumedSession = Schema.decodeSync(SessionId)("session-claude-test");
const environmentValue = (name: string) => {
  const value = Reflect.get(process.env, name);
  return typeof value === "string" ? value : undefined;
};
const inheritedEnvironment = {
  ANTHROPIC_API_KEY: environmentValue("ANTHROPIC_API_KEY"),
  ANTHROPIC_AUTH_TOKEN: environmentValue("ANTHROPIC_AUTH_TOKEN"),
  GITHUB_TOKEN: environmentValue("GITHUB_TOKEN"),
  GH_TOKEN: environmentValue("GH_TOKEN"),
};

const persistence = memoryPersistence();
const sessionStore: SessionStore.SessionStoreService = {
  persistence,
  resumeHandle: (session) => Effect.succeed(session === resumedSession ? "fake-claude-session-1" : null),
  mint: () => Effect.die("unexpected Session mint"),
};

const credentialStore = (
  providerKey: CredentialStore.CredentialStoreService["providerKey"],
): CredentialStore.CredentialStoreService => ({
  bearerToken: () => Effect.die("unexpected bearer lookup"),
  resolveSource: () => Effect.die("unexpected credential source resolution"),
  persist: () => Effect.die("unexpected credential persistence"),
  invalidate: () => Effect.die("unexpected credential invalidation"),
  providerKey,
  persistProviderKey: () => Effect.die("unexpected provider key persistence"),
  configureConnection: () => Effect.die("unexpected Connection configuration"),
  removeConnection: () => Effect.die("unexpected Connection removal"),
});

const runtimeLayer = Layer.mergeAll(
  Layer.succeed(SessionStore.SessionStore, sessionStore),
  Layer.succeed(ContextAssembler.ContextAssembler, {
    assemble: () => Effect.die("unexpected context assembly"),
    cleanup: () => Effect.die("unexpected context cleanup"),
  }),
  NodeFileSystem.layer,
  NodePath.layer,
  FetchHttpClient.layer,
);

const harnessLayerWith = (providerKey: CredentialStore.CredentialStoreService["providerKey"]) =>
  Layer.merge(runtimeLayer, Layer.succeed(CredentialStore.CredentialStore, credentialStore(providerKey)));

const harnessLayer = harnessLayerWith(() => Effect.die("unexpected provider key lookup"));

const byokHarnessLayer = harnessLayerWith(() =>
  Effect.succeed({ source: "stored-key", key: Redacted.make("anthropic-test-key-one") }),
);

const missingByokHarnessLayer = harnessLayerWith(() =>
  Effect.fail(
    new CredentialStore.CredentialError({
      account: "anthropic",
      message: "no api key for anthropic: ANTHROPIC_API_KEY is unset or empty",
      retryable: false,
    }),
  ),
);

class CredentialVersion extends Context.Service<CredentialVersion, Ref.Ref<"one" | "two">>()(
  "@cogwork/claude-code/harness.test/CredentialVersion",
) {
  static readonly layer = Layer.effect(CredentialVersion, Ref.make<"one" | "two">("one"));
}

const rotatingByokHarnessLayer = Layer.merge(
  runtimeLayer,
  Layer.effect(
    CredentialStore.CredentialStore,
    CredentialVersion.pipe(
      Effect.map((version) =>
        credentialStore(() =>
          Ref.get(version).pipe(
            Effect.map((current) => ({
              source: "stored-key" as const,
              key: Redacted.make(`anthropic-test-key-${current}`),
            })),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(CredentialVersion.layer)),
);

const fakeClaudeExecutable = (args = "") =>
  `node ${new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname}${args}`;
const testProcessDeadline = "5 seconds";
const createTestSandbox = () =>
  Effect.promise(() => localProcessSandbox({}).create({})).pipe(Effect.timeout(testProcessDeadline));
const destroyTestSandbox = (sandbox: SandboxHandle) =>
  Effect.promise(() => sandbox.destroy()).pipe(Effect.timeout(testProcessDeadline), Effect.ignore);

interface RequestOverrides {
  readonly session?: SessionId | null;
  readonly profile?: "read-only" | "full";
  readonly operation?: LifecycleStage;
  readonly mcp?: boolean;
}

const mcpSelection = (enabled?: boolean) => {
  if (!enabled) return [];
  return [
    {
      identity: "local:repo/mcp/linear",
      name: "linear",
      projectedName: "linear",
      endpoint: "https://mcp.example.test/readonly",
      authenticated: true,
      unavailableReason: null,
    },
  ];
};

const outputSchema = {
  type: "object",
  properties: {
    settingSources: { type: ["string", "null"] },
  },
  additionalProperties: true,
} as const;

const makeRequest = (checkoutPath: string, overrides: RequestOverrides = {}) => {
  const operation = overrides.operation ?? (overrides.profile === "read-only" ? "triage" : "implement");
  const profile = overrides.profile ?? OperationPolicy.operationPolicyProfile(operation);
  const mcp = mcpSelection(overrides.mcp);
  return {
    plan: Schema.decodeSync(RunPlan)({
      id: "run-claude-test",
      operation,
      harness: { name, model: "sonnet", effort: null, profile },
      instructions: [
        { kind: "rules", source: "/home/.agents/rules/global.md", content: "global rules" },
        { kind: "repo", source: "/repo/AGENTS.md", content: "repo rules" },
        {
          kind: "operating-instructions",
          source: "/operating-instructions/implement-agent/INSTRUCTIONS.md",
          content: "Operating Instructions rules",
        },
      ],
      operatingInstructions: {
        name: "implement-agent",
        path: "/home/operating-instructions/implement-agent",
        resources: [],
      },
      tools: [],
      skills: [],
      mcp,
      subagents: [],
      commands: [],
      hooks: [],
      middleware: ["sandbox"],
      structuredOutput: outputSchema,
      connections: [],
      messages: [{ role: "user", content: "implement the issue" }],
      workContext: {
        reference: { workItem: "#153", url: null },
        facts: {
          roles: ["ready-for-agent"],
          assignees: [],
          openBlockers: 0,
          claim: null,
          priority: "medium",
          pr: null,
        },
        observation: { generation: 1, observedAtMillis: 1 },
      },
      sandbox: { workspace: checkoutPath, policy: profile },
      persistence: { sessionKind: "opaque-handle" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: mcp.map(({ identity, projectedName }) => ({
          identity,
          name: projectedName,
        })),
        projection: [],
        observation: { generation: 1, observedAtMillis: 1 },
      },
    }),
    session: overrides.session === undefined ? freshSession : overrides.session,
    mcpCredentials: overrides.mcp
      ? new Map([["local:repo/mcp/linear", Redacted.make("mcp-test-bearer")]])
      : new Map(),
  };
};

const makeLiveHarness = (
  args = "",
  authentication: ClaudeCodeRunnerOptions["authentication"] = hostAuthentication,
) =>
  Effect.acquireRelease(createTestSandbox(), destroyTestSandbox).pipe(
    Effect.tap((handle) =>
      Effect.promise(() =>
        handle.process.exec(
          [
            "git init",
            'git config user.email "cogwork@example.com"',
            'git config user.name "Cogwork"',
            'printf "initial\\n" > tracked.txt',
            'printf "existing repo agents\\n" > AGENTS.md',
            "git add tracked.txt AGENTS.md",
            'git commit -m "initial"',
          ].join(" && "),
        ),
      ).pipe(Effect.timeout(testProcessDeadline)),
    ),
    Effect.map((handle) => ({
      handle,
      harness: Harness.make([
        claudeCodeRunner({
          name,
          authentication,
          claudeExecutable: fakeClaudeExecutable(args),
        }),
      ]),
    })),
  );

const structuredObjects = (events: ReadonlyArray<Harness.AgUiEvent>) =>
  events.flatMap((event) => (agUiIsStructuredOutputComplete(event) ? [event.value.object] : []));

const sessionHandles = (events: ReadonlyArray<Harness.AgUiEvent>) =>
  events.flatMap((event) => (agUiIsSessionHandleEvent(event) ? [event.value.sessionId] : []));

const runnerWithoutRuntimeCatalog = (claudeExecutable: string) => ({
  ...claudeCodeRunner({ name, authentication: hostAuthentication, claudeExecutable }),
  catalogSources: claudeCodeCatalogSources(claudeExecutable, []),
});

const Capture = Schema.Struct({
  args: Schema.Array(Schema.String),
  prompt: Schema.String,
  agents: Schema.String,
  cwd: Schema.String,
  files: Schema.Array(Schema.String),
  settingSources: Schema.NullOr(Schema.String),
  settings: Schema.NullOr(Schema.String),
  resume: Schema.NullOr(Schema.String),
  forkSession: Schema.Boolean,
  authMode: Schema.String,
  permissionMode: Schema.NullOr(Schema.String),
  systemPrompt: Schema.NullOr(Schema.String),
  mcpConfigArgument: Schema.NullOr(Schema.String),
  mcpConfig: Schema.NullOr(Schema.String),
  mcpBearer: Schema.NullOr(Schema.String),
  mcpBearerPresent: Schema.Boolean,
  apiKey: Schema.NullOr(Schema.String),
  apiKeyPresent: Schema.Boolean,
  apiKeyVersion: Schema.NullOr(Schema.String),
  authToken: Schema.NullOr(Schema.String),
  githubToken: Schema.NullOr(Schema.String),
  ghToken: Schema.NullOr(Schema.String),
});

const NativeSandboxSettings = Schema.fromJsonString(
  Schema.Struct({
    sandbox: Schema.Struct({
      enabled: Schema.Boolean,
      failIfUnavailable: Schema.Boolean,
      allowUnsandboxedCommands: Schema.Boolean,
      autoAllowBashIfSandboxed: Schema.Boolean,
    }),
  }),
);

const captureFrom = (events: ReadonlyArray<Harness.AgUiEvent>) => {
  const object = structuredObjects(events)[0];
  if (!object) return Effect.die("fake Claude emitted no structured result");
  return Schema.decodeUnknownEffect(Capture)(object);
};

const containsString = (value: unknown, expected: string): boolean => {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, expected));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) => containsString(entry, expected));
};

const captureRunFailure = (args: string) =>
  Effect.gen(function* () {
    const { handle, harness } = yield* makeLiveHarness(args);
    const seen: Array<Harness.AgUiEvent> = [];
    const error = yield* harness.run(makeRequest(handle.id)).pipe(
      Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
      Effect.flip,
    );
    return { error, seen };
  });

const occurrences = (content: string, expected: string) => content.split(expected).length - 1;
const assertSingleOccurrence = (content: string | null, expected: string) =>
  assert.strictEqual(occurrences(content ?? "", expected), 1);

const capturedDisallowedTools = (capture: typeof Capture.Type) => {
  const index = capture.args.indexOf("--disallowedTools");
  if (index < 0) return [];
  return capture.args.at(index + 1)?.split(",") ?? [];
};

const captureOperation = (operation: LifecycleStage) =>
  Effect.scoped(
    makeLiveHarness().pipe(
      Effect.flatMap(({ handle, harness }) =>
        harness.run(makeRequest(handle.id, { operation })).pipe(Stream.runCollect),
      ),
      Effect.flatMap(captureFrom),
      Effect.map((capture) => [operation, capture] satisfies [LifecycleStage, typeof Capture.Type]),
    ),
  );

const restoreEnvironment = (name: string, value: string | undefined) => {
  if (value === undefined) return Reflect.deleteProperty(process.env, name);
  return Reflect.set(process.env, name, value);
};

const withInheritedCredentialEnvironment = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      Reflect.set(process.env, "ANTHROPIC_API_KEY", "inherited-api-key");
      Reflect.set(process.env, "ANTHROPIC_AUTH_TOKEN", "inherited-auth-token");
      Reflect.set(process.env, "GITHUB_TOKEN", "inherited-github-token");
      Reflect.set(process.env, "GH_TOKEN", "inherited-gh-token");
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(inheritedEnvironment)) {
          restoreEnvironment(name, value);
        }
      }),
  );

describe("Claude Code Harness", () => {
  it.layer(harnessLayer)((it) => {
    it.effect("registers an explicit Claude authentication binding", () =>
      Effect.sync(() => {
        const hostRunner = claudeCodeRunner({ name, authentication: hostAuthentication });
        const byokRunner = claudeCodeRunner({ name, authentication: byokAuthentication });

        assert.strictEqual(hostRunner.name, name);
        assert.strictEqual(hostRunner.sessionKind, "opaque-handle");
        assert.deepStrictEqual(hostRunner.authentication, {
          mode: "host",
          reference: "Claude Code host login on this Runtime Host",
        });
        assert.deepStrictEqual(byokRunner.authentication, {
          mode: "byok",
          reference: "Anthropic provider key in the Credential store",
        });
        assert.deepStrictEqual(hostRunner.capabilities, {
          authenticationModes: ["host", "byok"],
          session: { affinity: "sandbox-lineage", fork: true, humanAttach: false },
          structuredOutput: "native",
          policyFidelity: "profile-only",
          fileEventFidelity: "terminal-only",
          usageQuality: "metered",
          readinessDiagnostics: true,
          journal: true,
          takeover: true,
        });
        assert.isFalse(adapterHasEffort);
      }),
    );

    it.effect("prefers TanStack runtime model metadata and exposes no unsupported effort", () =>
      Effect.gen(function* () {
        const harness = Harness.make([claudeCodeRunner({ name, authentication: hostAuthentication })]);
        const catalog = yield* harness.catalog(name);

        assert.deepStrictEqual(
          catalog.models.map(({ value }) => value),
          [...CLAUDE_CODE_MODELS],
        );
        assert.deepStrictEqual(catalog.provenance, {
          source: "tanstack-runtime",
          packageVersion: "0.6.3",
        });
        assert.isUndefined(catalog.efforts);
      }),
    );

    it.effect("falls through native Claude discovery to the versioned fallback with provenance", () =>
      Effect.gen(function* () {
        const nativeRunner = runnerWithoutRuntimeCatalog(fakeClaudeExecutable());
        const fallbackRunner = runnerWithoutRuntimeCatalog(fakeClaudeExecutable(" --empty-models"));
        const native = yield* Harness.make([nativeRunner]).catalog(name);
        const fallback = yield* Harness.make([fallbackRunner]).catalog(name);

        assert.deepStrictEqual(
          native.models.map(({ value }) => value),
          ["fable", "opus", "sonnet", "claude-fable-5"],
        );
        assert.deepStrictEqual(native.provenance, {
          source: "native-discovery",
          runtimeHost: "local-process",
          harnessVersion: "2.1.238 (Claude Code)",
        });
        assert.deepStrictEqual(
          fallback.models.map(({ value }) => value),
          ["sonnet", "opus", "haiku"],
        );
        assert.deepStrictEqual(fallback.provenance, {
          source: "cogwork-fallback",
          fallbackVersion: "claude-code-1",
        });
      }),
    );

    it.effect("diagnoses installation, compatibility, and host login separately", () =>
      Effect.gen(function* () {
        const missing = yield* claudeCodeRunner({
          name,
          authentication: hostAuthentication,
          claudeExecutable: "missing-claude-code-152",
        }).readiness();
        const outdated = yield* claudeCodeRunner({
          name,
          authentication: hostAuthentication,
          claudeExecutable: fakeClaudeExecutable(" --fake-version=2.1.82-old"),
        }).readiness();
        const loggedOut = yield* claudeCodeRunner({
          name,
          authentication: hostAuthentication,
          claudeExecutable: fakeClaudeExecutable(" --not-authenticated"),
        }).readiness();
        const scrubbed = yield* withInheritedCredentialEnvironment(
          claudeCodeRunner({
            name,
            authentication: hostAuthentication,
            claudeExecutable: fakeClaudeExecutable(" --require-clean-environment"),
          }).readiness(),
        );

        assert.strictEqual(missing.installation.status, "missing");
        assert.strictEqual(missing.authentication.status, "unknown");
        assert.include(missing.diagnostics[0] ?? "", "Install Claude Code");
        assert.strictEqual(outdated.installation.status, "installed");
        assert.strictEqual(outdated.compatibility.status, "incompatible");
        assert.strictEqual(outdated.authentication.status, "available");
        assert.strictEqual(loggedOut.installation.status, "installed");
        assert.strictEqual(loggedOut.installation.version, "2.1.238 (Claude Code)");
        assert.strictEqual(loggedOut.compatibility.status, "compatible");
        assert.strictEqual(loggedOut.authentication.status, "unavailable");
        assert.include(loggedOut.authentication.diagnostic, "claude auth login");
        assert.strictEqual(scrubbed.operational.status, "ready");
      }),
    );

    it.effect("keeps another Harness ready when Claude Code is unavailable", () =>
      Effect.gen(function* () {
        const harness = Harness.make([
          claudeCodeRunner({
            name,
            authentication: hostAuthentication,
            claudeExecutable: "missing-claude-code-152",
          }),
          companionRunner,
        ]);
        const claude = yield* harness.readiness(name);
        const companion = yield* harness.readiness(companionName);

        assert.strictEqual(claude.operational.status, "unavailable");
        assert.strictEqual(companion.operational.status, "ready");
      }),
    );

    it.effect("runs host auth with mandatory Workspace projection, native events, and usage", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --emit-change --commit-mcp-config");
        const events = yield* withInheritedCredentialEnvironment(
          harness.run(makeRequest(handle.id, { mcp: true })).pipe(Stream.runCollect),
        );
        const capture = yield* captureFrom(events);
        const mcpConfig = capture.mcpConfig ?? "";
        const systemPrompt = capture.systemPrompt ?? "";

        assert.strictEqual(capture.settingSources, "");
        assert.strictEqual(capture.authMode, "host");
        assert.strictEqual(capture.permissionMode, "bypassPermissions");
        assert.isNull(capture.apiKey);
        assert.isNull(capture.authToken);
        assert.notInclude(capture.files, ".mcp.json");
        assert.match(capture.mcpConfigArgument ?? "", /^\{"mcpServers":/);
        assert.notInclude(capture.files, ".cogwork-mcp.json");
        assert.include(mcpConfig, "https://mcp.example.test/readonly");
        assert.include(mcpConfig, "${COGWORK_MCP_");
        assert.include(mcpConfig, "Bearer\\u0020${COGWORK_MCP_");
        assert.notInclude(mcpConfig, "mcp-test-bearer");
        assert.strictEqual(capture.mcpBearer, "[redacted]");
        assert.isTrue(capture.mcpBearerPresent);
        assert.deepStrictEqual(capturedDisallowedTools(capture), [
          "Write",
          "Edit",
          "MultiEdit",
          "NotebookEdit",
        ]);
        assert.include(capture.args, "--json-schema");
        assert.strictEqual(capture.agents, "existing repo agents\n");
        assertSingleOccurrence(systemPrompt, "global rules");
        assertSingleOccurrence(systemPrompt, "repo rules");
        assertSingleOccurrence(systemPrompt, "Operating Instructions rules");
        assertSingleOccurrence(
          systemPrompt,
          "Mandatory Operating Instructions: /home/operating-instructions/implement-agent",
        );
        assert.lengthOf(structuredObjects(events), 1);
        assert.isFalse(containsString(events, "mcp-test-bearer"));
        assert.deepStrictEqual(sessionHandles(events), ["fake-claude-session-1"]);
        assert.isNull(capture.resume);
        assert.deepNestedInclude(
          events.find((event) => event.type === "RUN_STARTED"),
          { runId: "run-claude-test", threadId: freshSession },
        );
        assert.isTrue(events.some((event) => event.type === "REASONING_MESSAGE_CONTENT"));
        assert.isTrue(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
        assert.isTrue(events.some((event) => event.type === "TOOL_CALL_START"));
        assert.isTrue(events.some((event) => event.type === "TOOL_CALL_RESULT"));
        assert.isTrue(events.some((event) => event.type === "CUSTOM" && event.name === FILE_DIFF_EVENT));
        assert.isFalse(events.some((event) => event.type === "CUSTOM" && event.name === "file.changed"));
        const finished = events.find((event) => event.type === "RUN_FINISHED");
        assert.deepNestedInclude(finished?.usage, {
          promptTokens: 13,
          completionTokens: 8,
          totalTokens: 21,
          providerUsageDetails: { totalCostUsd: 0.01 },
        });
        assert.isFalse(yield* Effect.promise(() => handle.fs.exists("/workspace/.mcp.json")));
        assert.isFalse(yield* Effect.promise(() => handle.fs.exists("/workspace/.cogwork-mcp.json")));
        assert.strictEqual(
          yield* Effect.promise(() => handle.fs.read("/workspace/AGENTS.md")),
          "existing repo agents\n",
        );
        const committedPaths = yield* Effect.promise(() =>
          handle.process.exec("git ls-tree -r --name-only HEAD"),
        );
        assert.notInclude(committedPaths.stdout, ".cogwork-mcp.json");
        assert.notMatch(committedPaths.stdout, /\.tanstack-projected-/);
      }),
    );

    it.effect("projects read-only policy and resumes only the owning Sandbox lineage without forking", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness();
        const events = yield* harness
          .run(makeRequest(handle.id, { profile: "read-only", session: resumedSession }))
          .pipe(Stream.runCollect);
        const capture = yield* captureFrom(events);

        assert.strictEqual(capture.resume, "fake-claude-session-1");
        assert.deepNestedInclude(
          events.find((event) => event.type === "RUN_STARTED"),
          { runId: "run-claude-test", threadId: resumedSession },
        );
        assert.isFalse(capture.forkSession);
        assert.notMatch(capture.mcpConfigArgument ?? "", /^\{/);
        assert.include(capture.args, "--disallowedTools");
        assert.include(capture.args.join(" "), "Write,Edit,MultiEdit");
        assert.include(capture.args.join(" "), "NotebookEdit");
        assert.include(capturedDisallowedTools(capture), "Bash");
        assert.strictEqual(capture.permissionMode, "acceptEdits");
        assert.include(capture.args, "--permission-prompt-tool");
      }),
    );

    it.effect(
      "projects every Operation into a non-interactive native Sandbox posture",
      () =>
        Effect.gen(function* () {
          const captures = yield* Effect.forEach(LifecycleStage.literals, captureOperation);

          for (const [operation, capture] of captures) {
            const settings = yield* Schema.decodeUnknownEffect(NativeSandboxSettings)(capture.settings);
            const readOnly = OperationPolicy.operationPolicyProfile(operation) === "read-only";
            const disallowed = capturedDisallowedTools(capture);

            assert.deepStrictEqual(settings.sandbox, {
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              autoAllowBashIfSandboxed: !readOnly,
            });
            assert.strictEqual(capture.settingSources, "");
            assert.strictEqual(capture.permissionMode, readOnly ? "acceptEdits" : "bypassPermissions");
            assert.deepStrictEqual(
              disallowed,
              readOnly
                ? ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]
                : ["Write", "Edit", "MultiEdit", "NotebookEdit"],
            );
          }
        }),
      10_000,
    );

    it.effect("accepts safe inline settings and rejects settings containing spaces", () =>
      Effect.gen(function* () {
        const safe = '{"sandbox":{"enabled":true}}';
        const unsafe = '{"hooks":{"PreToolUse":[{"command":"/path with space/hook"}]}}';

        assert.strictEqual(inlineSettingsArgument(safe), safe);
        const cause = yield* Effect.try({
          try: () => inlineSettingsArgument(unsafe),
          catch: (cause) => {
            if (Schema.is(Harness.HarnessError)(cause)) return cause;
            return new Harness.HarnessError({
              reason: "launch",
              retryable: false,
              message: "Inline settings threw an unexpected error",
            });
          },
        }).pipe(Effect.flip);
        assert.include(cause.message, unsafe);
        assert.strictEqual(cause.reason, "launch");
        assert.isFalse(cause.retryable);
      }),
    );

    it.effect("cancels the Claude child when its Harness stream is interrupted", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --hang");

        yield* harness.run(makeRequest(handle.id)).pipe(Stream.take(2), Stream.runDrain);

        const pid = yield* Schema.decodeEffect(Schema.FiniteFromString)(
          yield* Effect.promise(() => handle.fs.read("/workspace/.claude-pid")),
        );
        const stopped = yield* Effect.promise(() =>
          handle.process.exec(
            `for attempt in $(seq 1 100); do state=$(ps -o stat= -p ${pid} 2>/dev/null); case "$state" in ""|Z*) exit 0 ;; esac; sleep 0.01; done; exit 1`,
          ),
        ).pipe(Effect.timeout(testProcessDeadline));
        assert.strictEqual(stopped.exitCode, 0);
      }),
    );

    it.effect("maps native Claude failures into retryable turn diagnostics", () =>
      Effect.gen(function* () {
        const { error, seen } = yield* captureRunFailure(" --run-error");

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
        assert.include(error.message, "Claude turn failed");
        assert.isTrue(seen.some((event) => event.type === "RUN_ERROR"));
      }),
    );

    it.effect("keeps service authentication failures retryable", () =>
      Effect.gen(function* () {
        const { error } = yield* captureRunFailure(" --authentication-run-error");

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
        assert.include(error.message, "MCP server authentication failed");
      }),
    );

    it.effect(
      "probes authenticated Claude launch, Session resume, and native structured output when enabled",
      () =>
        Effect.gen(function* () {
          const enabled = yield* Config.string("COGWORK_LIVE_CLAUDE_PROBE").pipe(Config.withDefault("0"));
          if (enabled !== "1") return;
          const handle = yield* Effect.acquireRelease(createTestSandbox(), destroyTestSandbox);
          const harness = Harness.make([claudeCodeRunner({ name, authentication: hostAuthentication })]);
          const fresh = yield* harness
            .run(makeRequest(handle.id))
            .pipe(Stream.runCollect, Effect.timeout("2 minutes"));
          const handleId = sessionHandles(fresh)[0];
          if (!handleId) return assert.fail("authenticated Claude emitted no Session handle");
          assert.lengthOf(structuredObjects(fresh), 1);
          const resumed = yield* harness.run(makeRequest(handle.id, { session: resumedSession })).pipe(
            Stream.runCollect,
            Effect.provideService(SessionStore.SessionStore, {
              ...sessionStore,
              resumeHandle: () => Effect.succeed(handleId),
            }),
            Effect.timeout("2 minutes"),
          );
          assert.isTrue(sessionHandles(resumed).length > 0);
          assert.lengthOf(structuredObjects(resumed), 1);
        }),
    );
  });

  it.layer(byokHarnessLayer)((it) => {
    it.effect("scrubs source-control credentials in every authentication mode", () =>
      withInheritedCredentialEnvironment(
        Effect.forEach(Object.values(authenticationByMode), (authentication) =>
          Effect.gen(function* () {
            const { handle, harness } = yield* makeLiveHarness("", authentication);
            const events = yield* harness.run(makeRequest(handle.id)).pipe(Stream.runCollect);
            return yield* captureFrom(events);
          }),
        ).pipe(
          Effect.tap((captures) =>
            Effect.sync(() => {
              for (const capture of captures) {
                assert.isNull(capture.githubToken);
                assert.isNull(capture.ghToken);
              }
            }),
          ),
        ),
      ),
    );

    it.effect("reports BYOK availability without requiring host login", () =>
      Effect.gen(function* () {
        const readiness = yield* claudeCodeRunner({
          name,
          authentication: byokAuthentication,
          claudeExecutable: fakeClaudeExecutable(" --not-authenticated"),
        }).readiness();

        assert.strictEqual(readiness.operational.status, "ready");
        assert.deepStrictEqual(readiness.authentication, {
          mode: "byok",
          status: "available",
          diagnostic: "Anthropic provider key is available",
        });
      }),
    );

    it.effect("injects and scrubs BYOK beside an MCP bearer", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness("", byokAuthentication);
        const events = yield* withInheritedCredentialEnvironment(
          harness.run(makeRequest(handle.id, { mcp: true })).pipe(Stream.runCollect),
        );
        const capture = yield* captureFrom(events);

        assert.strictEqual(capture.authMode, "host");
        assert.strictEqual(capture.apiKey, "[redacted]");
        assert.isTrue(capture.apiKeyPresent);
        assert.strictEqual(capture.apiKeyVersion, "one");
        assert.isNull(capture.authToken);
        assert.strictEqual(capture.mcpBearer, "[redacted]");
        assert.isTrue(capture.mcpBearerPresent);
        assert.isFalse(containsString(events, "anthropic-test-key-one"));
        assert.isFalse(containsString(events, "mcp-test-bearer"));
        assert.notInclude(capture.args.join(" "), "anthropic-test-key-one");
        assert.notInclude(capture.files.join(" "), "anthropic-test-key-one");
      }),
    );

    it.effect("resolves the Anthropic credential again for each Run", () =>
      Effect.gen(function* () {
        const version = yield* CredentialVersion;
        const { handle, harness } = yield* makeLiveHarness("", byokAuthentication);
        const first = yield* harness.run(makeRequest(handle.id)).pipe(Stream.runCollect);
        yield* Ref.set(version, "two");
        const second = yield* harness.run(makeRequest(handle.id)).pipe(Stream.runCollect);
        const captures = [yield* captureFrom(first), yield* captureFrom(second)];

        assert.deepStrictEqual(
          captures.map(({ apiKeyVersion }) => apiKeyVersion),
          ["one", "two"],
        );
        assert.isTrue(captures.every(({ apiKey }) => apiKey === "[redacted]"));
      }).pipe(Effect.provide(rotatingByokHarnessLayer)),
    );

    it.effect("scrubs rejected BYOK from events and diagnostics without falling back", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --api-key-run-error", byokAuthentication);
        const seen = yield* Ref.make<ReadonlyArray<Harness.AgUiEvent>>([]);
        const error = yield* harness.run(makeRequest(handle.id)).pipe(
          Stream.tap((event) => Ref.update(seen, (events) => [...events, event])),
          Stream.runDrain,
          Effect.flip,
        );
        const events = yield* Ref.get(seen);

        assert.strictEqual(error.reason, "credential");
        assert.isFalse(error.retryable);
        assert.include(error.message, "[redacted]");
        assert.notInclude(error.message, "anthropic-test-key-one");
        assert.include(error.message, "cogwork login key --provider anthropic");
        assert.isTrue(containsString(events, "[redacted]"));
        assert.isFalse(containsString(events, "anthropic-test-key-one"));
      }),
    );

    it.effect("classifies an unqualified Anthropic authentication error as a rejected BYOK key", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(
          " --unqualified-api-key-run-error",
          byokAuthentication,
        );
        const error = yield* harness.run(makeRequest(handle.id)).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "credential");
        assert.isFalse(error.retryable);
        assert.include(error.message, "cogwork login key --provider anthropic");
      }),
    );

    it.effect("keeps MCP API-key failures independent from Anthropic BYOK", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --mcp-api-key-run-error", byokAuthentication);
        const error = yield* harness
          .run(makeRequest(handle.id, { mcp: true }))
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
        assert.include(error.message, "MCP server invalid API key");
        assert.notInclude(error.message, "cogwork login key --provider anthropic");
      }),
    );
  });

  it.layer(missingByokHarnessLayer)((it) => {
    it.effect("reports a missing selected BYOK credential as actionable setup failure", () =>
      Effect.gen(function* () {
        const runner = claudeCodeRunner({
          name,
          authentication: byokAuthentication,
          claudeExecutable: fakeClaudeExecutable(),
        });
        const readiness = yield* runner.readiness();
        const error = yield* Harness.make([runner]).preflight(name, "full", "sonnet").pipe(Effect.flip);

        assert.strictEqual(readiness.operational.status, "unavailable");
        assert.isFalse(readiness.operational.retryable);
        assert.strictEqual(readiness.authentication.mode, "byok");
        assert.strictEqual(readiness.authentication.status, "unavailable");
        assert.include(readiness.authentication.diagnostic, "cogwork login key --provider anthropic");
        assert.strictEqual(error.reason, "credential");
        assert.isFalse(error.retryable);
        assert.include(error.message, "cogwork login key --provider anthropic");
        const launchError = yield* runner
          .preflight(
            Harness.HarnessPreflightInput.Launch({
              request: makeRequest("/missing-byok-checkout"),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(launchError.reason, "credential");
        assert.include(launchError.message, "cogwork login key --provider anthropic");
      }),
    );
  });
});
