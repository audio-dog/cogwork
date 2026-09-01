import { HarnessName, RunPlan, SessionId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  type DefaultMessageMetadataByModality,
  EventType,
  type JSONSchema,
  type StreamChunk,
  type TextAdapter,
  type TextOptions,
} from "@tanstack/ai";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { SandboxCapabilities, SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ContextAssembler } from "./context-assembler";
import { CredentialStore } from "./credential-store";
import {
  type ExternalHarnessAuthentication,
  type ExternalHarnessDescriptor,
  externalHarnessRunner,
  preparedCheckoutWorkspace,
} from "./external-harness-runtime";
import {
  fullHarnessExecution,
  HarnessError,
  HarnessPreflightInput,
  make,
  staticCatalogSource,
} from "./harness";
import { SessionStore } from "./session-store";

const name = Schema.decodeSync(HarnessName)("controlled-external");
const resumedSession = Schema.decodeSync(SessionId)("sess-external-147");

interface ControlledOptions {
  readonly effort: string;
  readonly authentication: string;
  readonly sessionId: string | null;
}

class ControlledAdapter
  implements TextAdapter<"controlled", ControlledOptions, readonly ["text"], DefaultMessageMetadataByModality>
{
  readonly kind = "text";
  readonly name = "controlled";
  readonly model = "controlled";
  declare readonly "~types": {
    readonly providerOptions: ControlledOptions;
    readonly inputModalities: readonly ["text"];
    readonly messageMetadataByModality: DefaultMessageMetadataByModality;
    readonly toolCapabilities: ReadonlyArray<string>;
    readonly toolCallMetadata: unknown;
    readonly systemPromptMetadata: never;
  };

  constructor(
    private readonly stream: (options: TextOptions<ControlledOptions>) => AsyncIterable<StreamChunk>,
    private readonly probe: ControlledProbe,
  ) {}

  chatStream(options: TextOptions<ControlledOptions>) {
    this.probe.chatOptions.push(options);
    return this.stream(options);
  }

  structuredOutput(_options: { readonly outputSchema: JSONSchema }) {
    return Promise.reject(new Error("unexpected separate structured output"));
  }

  supportsCombinedToolsAndSchema() {
    return true;
  }

  combinedStructuredOutputSource(): "event" {
    return "event";
  }
}

class ControlledProbe {
  readonly resolved: Array<
    Parameters<ExternalHarnessDescriptor<ControlledAdapter, string>["makeAdapter"]>[0]
  > = [];
  readonly chatOptions: Array<TextOptions<ControlledOptions>> = [];
  readonly cancellations: Array<true> = [];
  readonly sandboxDestructions: Array<true> = [];
}

const capabilities: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: true,
  backgroundProcesses: true,
  writableStdin: true,
  killableProcesses: true,
  snapshots: false,
  networkPolicy: false,
  durableFilesystem: false,
  fork: false,
};

const toAsyncIterable = <Value>(values: ReadonlyArray<Value>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = values[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  },
});

const cancellableAsyncIterable = <Value>(values: ReadonlyArray<Value>, cancellations: Array<true>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = values[Symbol.iterator]();
    return {
      next: () => Promise.resolve(iterator.next()),
      return: (): Promise<IteratorResult<Value>> => {
        cancellations.push(true);
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  },
});

const sandboxHandle = (id: string) =>
  ({
    id,
    provider: "controlled",
    workspaceRoot: "/checkout",
    capabilities,
    fs: {
      read: () => Promise.reject(new Error("unexpected read")),
      readBytes: () => Promise.reject(new Error("unexpected byte read")),
      write: () => Promise.reject(new Error("unexpected write")),
      list: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      exists: () => Promise.resolve(false),
    },
    git: {
      clone: () => Promise.reject(new Error("unexpected clone")),
      status: () => Promise.resolve(""),
      add: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      push: () => Promise.resolve(),
      pull: () => Promise.resolve(),
      branch: () => Promise.resolve("issue-147"),
    },
    process: {
      exec: () => Promise.resolve({ stdout: "controlled-base\n", stderr: "", exitCode: 0 }),
      spawn: () => Promise.reject(new Error("unexpected spawn")),
    },
    ports: { connect: () => Promise.reject(new Error("unexpected port")) },
    env: { set: () => Promise.resolve() },
    destroy: () => Promise.resolve(),
  }) satisfies SandboxHandle;

const controlledProvider = (created: Array<string>, destructions: Array<true>): SandboxProvider => ({
  name: "controlled",
  capabilities: () => capabilities,
  create: (input) => {
    created.push(input.workspace?.source.type ?? "missing");
    return Promise.resolve(sandboxHandle("controlled-sandbox"));
  },
  resume: () => Promise.resolve(null),
  destroy: () => {
    destructions.push(true);
    return Promise.resolve();
  },
});

const harnessServices = {
  sessionStore: {
    persistence: memoryPersistence(),
    resumeHandle: () => Effect.succeed("native-session-147"),
    mint: () => Effect.die("unexpected mint"),
  },
  contextAssembler: {
    assemble: () => Effect.die("unexpected context assembly"),
    cleanup: () => Effect.die("unexpected context cleanup"),
  },
  credentialStore: {
    bearerToken: () => Effect.die("unexpected bearer lookup"),
    resolveSource: () => Effect.die("unexpected credential source resolution"),
    persist: () => Effect.die("unexpected credential persistence"),
    invalidate: () => Effect.die("unexpected credential invalidation"),
    providerKey: () => Effect.die("unexpected provider key lookup"),
    persistProviderKey: () => Effect.die("unexpected provider key persistence"),
    configureConnection: () => Effect.die("unexpected Connection configuration"),
    removeConnection: () => Effect.die("unexpected Connection removal"),
  },
  fileSystem: FileSystem.makeNoop({}),
};

const harnessRunnerLayer = Layer.mergeAll(
  Layer.succeed(SessionStore, harnessServices.sessionStore),
  Layer.succeed(ContextAssembler, harnessServices.contextAssembler),
  Layer.succeed(CredentialStore, harnessServices.credentialStore),
  Layer.succeed(FileSystem.FileSystem, harnessServices.fileSystem),
  FetchHttpClient.layer,
);

const request = Schema.decodeSync(RunPlan)({
  id: "run-external-test",
  operation: "implement",
  harness: { name, model: "controlled", effort: "high", profile: "full" },
  instructions: [{ kind: "repo", source: "repo", content: "Follow repo rules." }],
  operatingInstructions: {
    name: "implement-agent",
    path: "/instructions/implement-agent",
    resources: [],
  },
  tools: [],
  skills: [],
  mcp: [],
  subagents: [],
  commands: [],
  hooks: [],
  middleware: ["sandbox"],
  structuredOutput: {
    type: "object",
    properties: { outcome: { type: "string" } },
    required: ["outcome"],
  },
  connections: [],
  messages: [{ role: "user", content: "Implement #147." }],
  workContext: {
    reference: { workItem: "#147", url: null },
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
  sandbox: { workspace: "/checkout", policy: "full" },
  persistence: { sessionKind: "opaque-handle" },
  provenance: {
    resolution: [],
    stamps: [],
    projectedNames: [],
    projection: [],
    observation: { generation: 1, observedAtMillis: 1 },
  },
});

const descriptor = (
  chunks: ReadonlyArray<StreamChunk>,
  probe: ControlledProbe,
): ExternalHarnessDescriptor<ControlledAdapter, string> => ({
  name,
  sessionKind: "opaque-handle",
  capabilities: {
    execution: fullHarnessExecution,
    profile: {
      authenticationModes: ["host"],
      session: { affinity: "runtime-host", fork: false },
      policyFidelity: "exact",
      fileEventFidelity: "sandbox",
      usageQuality: "estimated",
      readinessDiagnostics: true,
      journal: false,
      takeover: false,
    },
    projectedMembers: ["Harness Adapter", "Sandbox", "Structured Output"],
    planMiddleware: ["sandbox"],
  },
  authentication: { mode: "host", reference: "controlled host login" },
  catalogSources: {
    fallback: staticCatalogSource(
      {
        models: [{ value: "controlled", label: "Controlled" }],
        efforts: [{ value: "high", label: "High" }],
      },
      { source: "cogwork-fallback", fallbackVersion: "controlled-1" },
    ),
  },
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "Controlled runner is ready" },
      installation: { status: "installed", version: "1.0.0" },
      compatibility: { status: "compatible", requirement: ">=1" },
      authentication: { mode: "host", status: "available", diagnostic: "controlled login is available" },
      diagnostics: [],
    }),
  makeAdapter: (resolved) => {
    probe.resolved.push(resolved);
    return new ControlledAdapter(() => toAsyncIterable(chunks), probe);
  },
  projectModel: () => "controlled",
  projectOptions: (resolved) => ({
    effort: resolved.selection.effort ?? "high",
    authentication: resolved.authentication.mode,
    sessionId: resolved.identity.resumeHandle,
  }),
  projectAuthentication: (authentication) => authentication.mode,
  transport: {
    systemPrompts: (resolved) => resolved.instructions.map(({ content }) => content),
  },
  diagnostics: (cause) => new HarnessError({ reason: "turn", retryable: true, message: String(cause) }),
  estimateUsage: (_resolved, event, characters) =>
    event.type === EventType.RUN_FINISHED
      ? {
          ...event,
          usage: {
            promptTokens: 2,
            completionTokens: characters,
            totalTokens: characters + 2,
            estimated: true,
          },
        }
      : event,
});

const makeHarness = (
  controlledDescriptor: ExternalHarnessDescriptor<ControlledAdapter, string>,
  created: Array<string>,
  destructions: Array<true> = [],
  authentication: Effect.Effect<ExternalHarnessAuthentication> = Effect.succeed({
    mode: "host",
    secrets: {},
  }),
  provider: SandboxProvider = controlledProvider(created, destructions),
) =>
  make([
    externalHarnessRunner(controlledDescriptor, {
      authentication: () => authentication,
      sandboxProvider: () => Effect.succeed(provider),
      workspace: preparedCheckoutWorkspace(),
      sandboxPolicy: () => Effect.succeed(undefined),
    }),
  ]);

describe("external Harness runtime", () => {
  it.layer(harnessRunnerLayer)((it) => {
    it.effect("launches through Harness and preserves complete AG-UI and structured-result events", () =>
      Effect.gen(function* () {
        const created: Array<string> = [];
        const probe = new ControlledProbe();
        const events: ReadonlyArray<StreamChunk> = [
          { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "message-147", delta: "built" },
          {
            type: EventType.CUSTOM,
            name: "controlled.diagnostic",
            value: { native: true },
            metadata: { controlled: { trace: "trace-147" } },
          },
          {
            type: EventType.CUSTOM,
            name: "structured-output.complete",
            value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
          },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const harness = makeHarness(descriptor(events, probe), created);
        const output = yield* harness
          .run({ plan: request, session: null, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);

        assert.deepStrictEqual(created, ["none"]);
        assert.strictEqual(output.filter((event) => event.name === "structured-output.complete").length, 1);
        const diagnostic = output.find((event) => event.name === "controlled.diagnostic");
        assert.deepStrictEqual(diagnostic?.value, { native: true });
        assert.deepStrictEqual(diagnostic?.metadata, { controlled: { trace: "trace-147" } });
        const finished = output.find((event) => event.type === EventType.RUN_FINISHED);
        assert.deepStrictEqual(finished?.usage, {
          promptTokens: 2,
          completionTokens: 5,
          totalTokens: 7,
          estimated: true,
        });

        const launch = probe.resolved[0];
        assert.strictEqual(launch?.model, "controlled");
        assert.strictEqual(launch?.authentication, "host");
        assert.strictEqual(launch?.request.identity.run, request.id);
        assert.isNull(launch?.request.identity.session);
        assert.strictEqual(launch?.request.policy, "full");
        assert.strictEqual(launch?.request.checkout.path, "/checkout");
        assert.strictEqual(launch?.request.operatingInstructions.path, "/instructions/implement-agent");
        assert.deepStrictEqual(launch?.request.prompt, request.messages);
        assert.deepStrictEqual(launch?.request.outputSchema, request.structuredOutput);
        assert.strictEqual(probe.chatOptions[0]?.runId, request.id);
        assert.strictEqual(probe.chatOptions[0]?.threadId, request.id);
        assert.deepStrictEqual(probe.chatOptions[0]?.modelOptions, {
          effort: "high",
          authentication: "host",
          sessionId: null,
        });
        assert.deepNestedInclude(probe.chatOptions[0]?.outputSchema, request.structuredOutput ?? {});
        const outputSchema = probe.chatOptions[0]?.outputSchema;
        if (!outputSchema || !("additionalProperties" in outputSchema)) {
          return assert.fail("adapter received no converted JSON Schema");
        }
        assert.strictEqual(outputSchema.additionalProperties, false);
      }),
    );

    it.effect("resolves the native session handle before descriptor projection", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const harness = makeHarness(
          descriptor(
            [
              { type: EventType.RUN_STARTED, threadId: resumedSession, runId: request.id },
              { type: EventType.RUN_FINISHED, threadId: resumedSession, runId: request.id },
            ],
            probe,
          ),
          created,
        );

        yield* harness
          .run({ plan: request, session: resumedSession, mcpCredentials: new Map() })
          .pipe(Stream.take(1), Stream.runDrain);

        assert.deepNestedInclude(probe.resolved[0]?.request, {
          identity: {
            run: request.id,
            session: resumedSession,
            resumeHandle: "native-session-147",
          },
        });
        assert.strictEqual(probe.chatOptions[0]?.modelOptions?.sessionId, "native-session-147");
      }),
    );

    it.effect("aborts the adapter when the Harness consumer cancels the stream", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const events: ReadonlyArray<StreamChunk> = [
          { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const base = descriptor(events, probe);
        const harness = makeHarness(
          {
            ...base,
            makeAdapter: (resolved) => {
              probe.resolved.push(resolved);
              return new ControlledAdapter(
                () => cancellableAsyncIterable(events, probe.cancellations),
                probe,
              );
            },
          },
          created,
          probe.sandboxDestructions,
        );

        yield* harness
          .run({ plan: request, session: null, mcpCredentials: new Map() })
          .pipe(Stream.take(1), Stream.runDrain);

        assert.deepStrictEqual(probe.cancellations, [true]);
        assert.deepStrictEqual(probe.sandboxDestructions, [true]);
        assert.isTrue(probe.chatOptions[0]?.request?.signal?.aborted);
      }),
    );

    it.effect("maps native launch failures through the descriptor diagnostics", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const nativeFailure = new Error("controlled executable missing");
        const controlledDescriptor: ExternalHarnessDescriptor<ControlledAdapter, string> = {
          ...descriptor([], probe),
          makeAdapter: () => {
            throw nativeFailure;
          },
          diagnostics: (cause) =>
            new HarnessError({
              reason: "launch",
              retryable: false,
              message: cause === nativeFailure ? nativeFailure.message : "unexpected failure",
            }),
        };
        const harness = makeHarness(controlledDescriptor, created);
        const error = yield* harness
          .run({ plan: request, session: null, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "launch");
        assert.strictEqual(error.retryable, false);
        assert.strictEqual(error.message, nativeFailure.message);
      }),
    );

    it.effect("refuses authentication mismatch without trying another mode", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const harness = makeHarness(
          descriptor([], probe),
          created,
          [],
          Effect.succeed({ mode: "byok", secrets: {} }),
        );
        const error = yield* harness
          .run({ plan: request, session: null, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "credential");
        assert.include(error.message, "requires host authentication, received byok");
        assert.deepStrictEqual(probe.resolved, []);
        assert.deepStrictEqual(created, []);
      }),
    );

    it.effect("refuses an incompatible Sandbox provider before adapter launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const provider = {
          ...controlledProvider(created, []),
          capabilities: () => ({ ...capabilities, killableProcesses: false }),
        } satisfies SandboxProvider;
        const harness = makeHarness(
          descriptor([], probe),
          created,
          [],
          Effect.succeed({ mode: "host", secrets: {} }),
          provider,
        );
        const error = yield* harness
          .run({ plan: request, session: null, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "sandbox");
        assert.include(error.message, "killable processes");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("resolves the Workspace and policy during launch preflight", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const failure = new HarnessError({
          reason: "workspace",
          retryable: false,
          message: "Workspace projection failed",
        });
        const runner = externalHarnessRunner(descriptor([], probe), {
          authentication: () => Effect.succeed({ mode: "host", secrets: {} }),
          sandboxProvider: () => Effect.succeed(controlledProvider([], [])),
          workspace: () => Effect.fail(failure),
          sandboxPolicy: () => Effect.die(new Error("policy resolution must follow Workspace resolution")),
        });

        const error = yield* runner
          .preflight(
            HarnessPreflightInput.Launch({
              request: { plan: request, session: null, mcpCredentials: new Map() },
            }),
          )
          .pipe(Effect.flip);

        assert.strictEqual(error, failure);
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("preserves a run error event before failing through the Harness taxonomy", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const seen: Array<{ readonly [key: string]: unknown; readonly type: string }> = [];
        const harness = makeHarness(
          {
            ...descriptor(
              [
                { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
                {
                  type: EventType.RUN_ERROR,
                  message: "controlled turn failed",
                  code: "CONTROLLED_FAILURE",
                  metadata: { controlled: { retryAfter: 3 } },
                },
              ],
              probe,
            ),
            diagnostics: (cause) => {
              const message =
                typeof cause === "object" && cause && "message" in cause
                  ? String(cause.message)
                  : "unexpected failure";
              return new HarnessError({ reason: "launch", retryable: false, message });
            },
          },
          created,
        );
        const error = yield* harness.run({ plan: request, session: null, mcpCredentials: new Map() }).pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.flip,
        );

        assert.strictEqual(error.reason, "launch");
        assert.strictEqual(error.retryable, false);
        assert.strictEqual(error.message, "controlled turn failed");
        assert.strictEqual(seen[1]?.type, EventType.RUN_ERROR);
        assert.strictEqual(seen[1]?.code, "CONTROLLED_FAILURE");
        assert.deepStrictEqual(seen[1]?.metadata, { controlled: { retryAfter: 3 } });
      }),
    );
  });
});
