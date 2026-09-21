import {
  agUiIsSessionHandleEvent,
  agUiIsStructuredOutputComplete,
  HarnessName,
  type LifecycleStage,
  RunPlan,
  SessionId,
} from "@cogwork/contracts";
import { ContextAssembler, CredentialStore, Harness, OperationPolicy, SessionStore } from "@cogwork/engine";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert } from "@effect/vitest";
import type { ClaudeCodeTextProviderOptions } from "@tanstack/ai-claude-code";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { type ClaudeCodeRunnerOptions, claudeCodeRunner } from "./harness";

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
  CLAUDE_CONFIG_DIR: environmentValue("CLAUDE_CONFIG_DIR"),
  USERPROFILE: environmentValue("USERPROFILE"),
  HOMEDRIVE: environmentValue("HOMEDRIVE"),
  HOMEPATH: environmentValue("HOMEPATH"),
  APPDATA: environmentValue("APPDATA"),
  SYSTEMROOT: environmentValue("SYSTEMROOT"),
  PATHEXT: environmentValue("PATHEXT"),
  COMSPEC: environmentValue("COMSPEC"),
  HTTP_PROXY: environmentValue("HTTP_PROXY"),
  HTTPS_PROXY: environmentValue("HTTPS_PROXY"),
  NO_PROXY: environmentValue("NO_PROXY"),
  http_proxy: environmentValue("http_proxy"),
  https_proxy: environmentValue("https_proxy"),
  NODE_EXTRA_CA_CERTS: environmentValue("NODE_EXTRA_CA_CERTS"),
};

const windowsEnvironmentProbe = {
  USERPROFILE: "C:\\Users\\cogwork",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\cogwork",
  APPDATA: "C:\\Users\\cogwork\\AppData\\Roaming",
  SYSTEMROOT: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
};

const networkEnvironmentProbe = {
  HTTP_PROXY: "http://proxy.example.test:8080",
  HTTPS_PROXY: "https://proxy.example.test:8443",
  NO_PROXY: "localhost,.example.test",
  http_proxy: "http://lowercase-proxy.example.test:8080",
  https_proxy: "https://lowercase-proxy.example.test:8443",
  NODE_EXTRA_CA_CERTS: "/tmp/cogwork-enterprise-ca.pem",
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
  "@cogwork/claude-code/harness-fixtures/CredentialVersion",
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
  readonly model?: string | null;
  readonly effort?: string | null;
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
  const profile = overrides.profile ?? OperationPolicy.operationDefaultProfile(operation);
  const mcp = mcpSelection(overrides.mcp);
  return {
    plan: Schema.decodeSync(RunPlan)({
      id: "run-claude-test",
      operation,
      harness: {
        name,
        model: overrides.model ?? null,
        effort: overrides.effort ?? null,
        profile,
      },
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
    Effect.map((handle) => {
      const runner = claudeCodeRunner({
        name,
        authentication,
        claudeExecutable: fakeClaudeExecutable(args),
      });
      return { handle, harness: Harness.make([runner]), runner };
    }),
  );

const structuredObjects = (events: ReadonlyArray<Harness.AgUiEvent>) =>
  events.flatMap((event) => (agUiIsStructuredOutputComplete(event) ? [event.value.object] : []));

const sessionHandles = (events: ReadonlyArray<Harness.AgUiEvent>) =>
  events.flatMap((event) => (agUiIsSessionHandleEvent(event) ? [event.value.sessionId] : []));

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
  claudeConfigDir: Schema.NullOr(Schema.String),
  windowsEnvironment: Schema.Struct({
    USERPROFILE: Schema.NullOr(Schema.String),
    HOMEDRIVE: Schema.NullOr(Schema.String),
    HOMEPATH: Schema.NullOr(Schema.String),
    APPDATA: Schema.NullOr(Schema.String),
    SYSTEMROOT: Schema.NullOr(Schema.String),
    PATHEXT: Schema.NullOr(Schema.String),
    COMSPEC: Schema.NullOr(Schema.String),
  }),
  networkEnvironment: Schema.Struct({
    HTTP_PROXY: Schema.NullOr(Schema.String),
    HTTPS_PROXY: Schema.NullOr(Schema.String),
    NO_PROXY: Schema.NullOr(Schema.String),
    http_proxy: Schema.NullOr(Schema.String),
    https_proxy: Schema.NullOr(Schema.String),
    NODE_EXTRA_CA_CERTS: Schema.NullOr(Schema.String),
  }),
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
      Reflect.set(process.env, "CLAUDE_CONFIG_DIR", "/tmp/cogwork-claude-config");
      Object.assign(process.env, windowsEnvironmentProbe);
      Object.assign(process.env, networkEnvironmentProbe);
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(inheritedEnvironment)) {
          restoreEnvironment(name, value);
        }
      }),
  );

export type { AdapterHasEffort, RequestOverrides };
export {
  adapterHasEffort,
  assertSingleOccurrence,
  authenticationByMode,
  byokAuthentication,
  byokHarnessLayer,
  Capture,
  CredentialVersion,
  capturedDisallowedTools,
  captureFrom,
  captureOperation,
  captureRunFailure,
  companionName,
  companionRunner,
  containsString,
  createTestSandbox,
  credentialStore,
  destroyTestSandbox,
  environmentValue,
  fakeClaudeExecutable,
  freshSession,
  harnessLayer,
  harnessLayerWith,
  hostAuthentication,
  inheritedEnvironment,
  makeLiveHarness,
  makeRequest,
  mcpSelection,
  missingByokHarnessLayer,
  NativeSandboxSettings,
  name,
  networkEnvironmentProbe,
  occurrences,
  outputSchema,
  persistence,
  restoreEnvironment,
  resumedSession,
  rotatingByokHarnessLayer,
  runtimeLayer,
  sessionHandles,
  sessionStore,
  structuredObjects,
  testProcessDeadline,
  windowsEnvironmentProbe,
  withInheritedCredentialEnvironment,
};
