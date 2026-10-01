import {
  type AgUiEvent,
  agUiIsFileDiffEvent,
  agUiIsFileDiffUnavailableEvent,
  FILE_DIFF_EVENT,
  HarnessName,
  RunId,
  RunPlan,
  type RunRecord,
  SessionId,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
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
import {
  createSecrets,
  getSandbox,
  getSandboxPolicy,
  getWorkspaceProjection,
  SandboxDurabilityCapability,
} from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { afterEach, vi } from "vitest";
import { ContextAssembler } from "./context-assembler";
import { CredentialStore } from "./credential-store";
import {
  defaultInheritedEnvironment,
  type ExternalHarnessAuthentication,
  type ExternalHarnessDescriptor,
  environmentVariablesToRemove,
  externalHarnessRunner,
  mcpBearerEnvironmentName,
  mergeCheckoutFileDiffs,
  withLocalProcessSandbox,
} from "./external-harness-runtime";
import { fullHarnessExecution, HarnessError, make } from "./harness";
import { messageFromUnknown } from "./provider-bridge";
import * as RunLedger from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { engineTestLayer } from "./testing/engine-test-layer";
import { fullProfile } from "./tools/policy";

afterEach(() => vi.restoreAllMocks());

const name = Schema.decodeSync(HarnessName)("controlled-external");
const checkoutPath = process.cwd();
const freshSession = Schema.decodeSync(SessionId)("sess-external-fresh");
const resumedSession = Schema.decodeSync(SessionId)("sess-external-147");
const secondCheckoutRunId = Schema.decodeSync(RunId)("run-second-checkout");
const secretWorkspace = Schema.decodeSync(WorkspaceId)("workspace-secret-test");
const secretWorkItem = Schema.decodeSync(WorkItemId)("#153");
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
    const stream = this.stream(options);
    const inspection = this.probe.inspect?.(options) ?? Promise.resolve();
    return afterInspection(inspection, stream);
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
  readonly resolved: Array<Parameters<ExternalHarnessDescriptor<ControlledAdapter>["makeAdapter"]>[0]> = [];
  readonly chatOptions: Array<TextOptions<ControlledOptions>> = [];
  readonly cancellations: Array<true> = [];
  inspect?: (options: TextOptions<ControlledOptions>) => Promise<void>;
}

const runtimeCapabilities = (options: TextOptions<ControlledOptions>) => {
  if (options.capabilities) return options.capabilities;
  throw new Error("missing runtime capabilities");
};

const afterInspection = <Value>(inspection: Promise<void>, stream: AsyncIterable<Value>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = stream[Symbol.asyncIterator]();
    return {
      next: () => inspection.then(() => iterator.next()),
      return: (value?: unknown): Promise<IteratorResult<Value>> =>
        inspection.then(() =>
          iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value: undefined }),
        ),
    };
  },
});

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

const harnessServices = {
  sessionStore: {
    persistence: memoryPersistence(),
    resumeHandle: (session: SessionId) =>
      Effect.succeed(session === resumedSession ? "native-session-147" : null),
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
};

const harnessRunnerLayer = Layer.mergeAll(
  Layer.succeed(SessionStore, harnessServices.sessionStore),
  Layer.succeed(ContextAssembler, harnessServices.contextAssembler),
  Layer.succeed(CredentialStore, harnessServices.credentialStore),
  NodeFileSystem.layer,
  NodePath.layer,
  FetchHttpClient.layer,
);

const hostAuthentication = () =>
  Effect.succeed({ mode: "host", secrets: {} } satisfies ExternalHarnessAuthentication);

const request = Schema.decodeSync(RunPlan)({
  id: "run-external-test",
  operation: "implement",
  harness: { name, model: "controlled", options: {}, profile: "full" },
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
    prose: {
      body: "Ship the external Harness change.",
      comments: [
        {
          author: "maintainer",
          authorAssociation: "MEMBER",
          body: "Keep this instruction in the admitted snapshot.",
          createdAtMillis: 2,
        },
      ],
    },
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
  sandbox: { workspace: checkoutPath, policy: "full" },
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
): ExternalHarnessDescriptor<ControlledAdapter> => ({
  name,
  capabilities: {
    execution: fullHarnessExecution,
    profile: {
      authenticationModes: ["host"],
      session: { affinity: "runtime-host", fork: false, humanAttach: false },
      structuredOutput: "native",
      policyFidelity: "exact",
      fileEventFidelity: "terminal-only",
      usageQuality: "estimated",
      readinessDiagnostics: true,
      journal: false,
      takeover: false,
    },
  },
  authentication: { mode: "host", reference: "controlled host login" },
  catalog: {
    models: [{ value: "controlled", label: "Controlled" }],
  },
  readiness: () =>
    Effect.succeed({
      operational: {
        status: "ready",
        retryable: false,
        diagnostic: "Controlled runner is ready",
      },
      installation: { status: "installed", version: "1.0.0" },
      compatibility: { status: "compatible", requirement: ">=1" },
      authentication: {
        mode: "host",
        status: "available",
        diagnostic: "controlled login is available",
      },
      diagnostics: [],
    }),
  sharedGit: "none",
  inheritedEnvironment: ["PATH"],
  makeAdapter: (resolved) => {
    probe.resolved.push(resolved);
    return new ControlledAdapter(() => toAsyncIterable(chunks), probe);
  },
  projectModel: () => "controlled",
  projectOptions: (resolved) => {
    const effort = resolved.selection.options.effort;
    return {
      effort: typeof effort === "string" ? effort : "high",
      authentication: resolved.authentication.mode,
      sessionId: resolved.identity.resumeHandle,
    };
  },
  transport: { instructionProjection: "system-prompt" },
  diagnostics: (cause) =>
    new HarnessError({
      reason: "launch",
      retryable: false,
      message: messageFromUnknown(cause),
    }),
  turnDiagnostics: (cause) =>
    new HarnessError({
      reason: "turn",
      retryable: true,
      message: messageFromUnknown(cause),
    }),
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
  controlledDescriptor: ExternalHarnessDescriptor<ControlledAdapter>,
  options: {
    readonly authentication?: Effect.Effect<ExternalHarnessAuthentication>;
  } = {},
) =>
  make([
    externalHarnessRunner(controlledDescriptor, {
      authentication: () => options.authentication ?? Effect.succeed({ mode: "host", secrets: {} }),
    }),
  ]);

const terminalEvents: ReadonlyArray<StreamChunk> = [
  { type: EventType.RUN_STARTED, threadId: "session-148", runId: request.id },
  {
    type: EventType.CUSTOM,
    name: "structured-output.complete",
    value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
  },
  { type: EventType.RUN_FINISHED, threadId: "session-148", runId: request.id },
];

describe("external Harness runtime", { timeout: 30_000 }, () => {
  it("removes every environment variable outside the inherited list", () => {
    assert.deepStrictEqual(
      environmentVariablesToRemove(
        ["PATH", "COGWORK_ALLOWED", "COGWORK_REMOVED"],
        ["PATH", "COGWORK_ALLOWED"],
      ),
      ["COGWORK_REMOVED"],
    );
    assert.deepStrictEqual(
      environmentVariablesToRemove(
        ["PATH", "COGWORK_ALLOWED", "COGWORK_REMOVED"],
        ["PATH"],
        ["COGWORK_ALLOWED"],
        ["PATH"],
      ),
      ["PATH", "COGWORK_REMOVED"],
    );
  });

  it("matches environment variable names case-insensitively on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    assert.deepStrictEqual(environmentVariablesToRemove(["Path", "SECRET"], ["PATH"]), ["SECRET"]);
  });

  it.effect("removes environment variables added after sandbox creation", () => {
    const name = "COGWORK_LATE_EXTERNAL_SECRET";
    return withLocalProcessSandbox(process.cwd(), defaultInheritedEnvironment, String, (sandbox) =>
      Effect.acquireUseRelease(
        Effect.sync(() => Reflect.get(process.env, name)),
        () =>
          Effect.sync(() => Reflect.set(process.env, name, "late-secret")).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: (signal) =>
                  sandbox.process.exec(
                    `node -e 'process.stdout.write(process.env[process.argv[1]] ?? "")' '${name}'`,
                    { signal },
                  ),
                catch: String,
              }).pipe(Effect.timeout("5 seconds")),
            ),
            Effect.tap((result) => Effect.sync(() => assert.strictEqual(result.stdout, ""))),
          ),
        (previous) =>
          Effect.sync(() =>
            previous === undefined
              ? Reflect.deleteProperty(process.env, name)
              : Reflect.set(process.env, name, previous),
          ),
      ),
    );
  });

  it("keeps the Codex inherited environment unchanged", () => {
    assert.deepStrictEqual(defaultInheritedEnvironment, [
      "HOME",
      "PATH",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
    ]);
  });

  it.layer(harnessRunnerLayer)((it) => {
    it("owns the common external Harness declaration", () => {
      const runner = externalHarnessRunner(descriptor([], new ControlledProbe()), {
        authentication: () => Effect.succeed({ mode: "host", secrets: {} }),
      });

      assert.strictEqual(runner.sessionKind, "opaque-handle");
      assert.deepStrictEqual(runner.projectedMembers, [
        "Harness Adapter",
        "Instructions",
        "Messages",
        "MCP",
        "Middleware",
        "Sandbox",
        "Structured Output",
        "Persistence",
        "Connections",
      ]);
      assert.deepStrictEqual(runner.planMiddleware, ["sandbox"]);
    });

    it.effect(
      "projects mandatory instructions through one Harness Workspace and keeps work context user-authored",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-projection-" });
          const probe = new ControlledProbe();
          const base = descriptor(terminalEvents, probe);
          const harness = makeHarness({ ...base, transport: {} });
          const plan = RunPlan.make({
            ...request,
            sandbox: { ...request.sandbox, workspace: checkout },
          });

          yield* harness
            .run({ plan, session: freshSession, mcpCredentials: new Map() })
            .pipe(Stream.runDrain);

          const chatOptions = probe.chatOptions[0];
          if (!chatOptions) return assert.fail("adapter received no chat options");
          const projection = getWorkspaceProjection(runtimeCapabilities(chatOptions));
          const instructions = yield* fs.readFileString(`${checkout}/AGENTS.md`);
          assert.include(instructions, "Follow repo rules.");
          assert.include(instructions, "Mandatory Operating Instructions: /instructions/implement-agent");
          assert.strictEqual(projection.root, checkout);
          const messages = probe.chatOptions[0]?.messages ?? [];
          assert.strictEqual(messages.length, 2);
          assert.strictEqual(messages[0]?.role, "user");
          assert.include(messages[0]?.content ?? "", "Ship the external Harness change.");
          assert.include(messages[0]?.content ?? "", "Keep this instruction in the admitted snapshot.");
          assert.deepStrictEqual(messages[1], { role: "user", content: "Implement #147." });
          assert.deepStrictEqual(probe.chatOptions[0]?.systemPrompts, []);
        }),
    );

    it.effect("ends a Run whose checkout feed never sees an event", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-harness-feed-" });
        const base = descriptor(terminalEvents, new ControlledProbe());
        const harness = makeHarness({ ...base, transport: { runtimeFileDiffFeed: true } });
        const seen: Array<AgUiEvent> = [];

        yield* harness
          .run({
            plan: RunPlan.make({ ...request, sandbox: { ...request.sandbox, workspace: checkout } }),
            session: freshSession,
            mcpCredentials: new Map(),
          })
          .pipe(Stream.runForEach((event) => Effect.sync(() => seen.push(event))));

        assert.isFalse(
          seen.some((event) => event.type === EventType.CUSTOM && event.name === "sandbox.file"),
        );
        assert.deepNestedInclude(seen.at(-1), { type: EventType.RUN_FINISHED });
        assert.lengthOf(
          seen.filter((event) => event.type === EventType.RUN_FINISHED),
          1,
        );
      }),
    );

    it.effect("warns before finishing when the checkout diff feed dies", () =>
      Effect.gen(function* () {
        const harnessEvents = Stream.fromIterable([
          { type: "RUN_STARTED" } satisfies AgUiEvent,
          { type: "RUN_FINISHED", finishReason: "stop" } satisfies AgUiEvent,
        ]);
        const output = yield* mergeCheckoutFileDiffs(harnessEvents, () =>
          Stream.fail(new Error("raw external watcher failure")),
        ).pipe(Effect.flatMap(Stream.runCollect));
        const warningIndex = output.findIndex(agUiIsFileDiffUnavailableEvent);
        const finishedIndex = output.findIndex((event) => event.type === EventType.RUN_FINISHED);

        assert.isAtLeast(warningIndex, 0);
        assert.isAbove(finishedIndex, warningIndex);
        assert.strictEqual(output.at(-1)?.type, EventType.RUN_FINISHED);
      }),
    );

    it.effect("keeps Operating Instructions resources host-provisioned and readable", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-harness-checkout-" });
        const resourceDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "cogwork-operating-instructions-",
        });
        const resource = `${resourceDirectory}/GUIDE.md`;
        yield* fs.writeFileString(resource, "supporting guide");
        const probe = new ControlledProbe();
        const reads: Array<string> = [];
        probe.inspect = (options) => {
          const sandbox = getSandbox(runtimeCapabilities(options));
          return sandbox.process
            .exec(
              `node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))' '${resource}'`,
            )
            .then((result) => {
              reads.push(result.stdout);
            });
        };
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, workspace: checkout },
          operatingInstructions: {
            name: "implement-agent",
            path: resourceDirectory,
            resources: [{ source: resource, content: "supporting guide" }],
          },
        });
        const base = descriptor(terminalEvents, probe);
        const harness = make([
          externalHarnessRunner(
            { ...base, transport: {} },
            {
              authentication: hostAuthentication,
            },
          ),
        ]);

        yield* harness.run({ plan, session: freshSession, mcpCredentials: new Map() }).pipe(Stream.runDrain);

        assert.deepStrictEqual(reads, ["supporting guide"]);
        assert.isFalse(yield* fs.exists(`${checkout}/GUIDE.md`));
        assert.include(yield* fs.readFileString(`${checkout}/AGENTS.md`), resourceDirectory);
      }),
    );

    it.effect("binds each Run to its prepared checkout when a Session resumes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const firstCheckout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-first-checkout-" });
        const secondCheckout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-second-checkout-" });
        const probe = new ControlledProbe();
        const observedCheckouts: Array<string> = [];
        probe.inspect = (options) =>
          getSandbox(runtimeCapabilities(options))
            .process.exec("pwd -P")
            .then(({ stdout }) => {
              observedCheckouts.push(stdout.trim());
            });
        const harness = make([
          externalHarnessRunner(descriptor(terminalEvents, probe), {
            authentication: hostAuthentication,
          }),
        ]);
        const runAt = (id: RunId, workspace: string) =>
          harness
            .run({
              plan: RunPlan.make({
                ...request,
                id,
                sandbox: { ...request.sandbox, workspace },
              }),
              session: resumedSession,
              mcpCredentials: new Map(),
            })
            .pipe(Stream.runDrain);

        yield* runAt(request.id, firstCheckout);
        yield* runAt(secondCheckoutRunId, secondCheckout);

        assert.deepStrictEqual(observedCheckouts, [
          yield* fs.realPath(firstCheckout),
          yield* fs.realPath(secondCheckout),
        ]);
      }),
    );

    it.effect("projects public and authenticated MCP servers with collision-safe live secrets per Run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-harness-workspace-" });
        const probe = new ControlledProbe();
        const observations: Array<{
          readonly names: ReadonlyArray<string>;
          readonly publicHasAuthorization: boolean;
          readonly liveBearers: ReadonlyArray<string>;
        }> = [];
        probe.inspect = (options) => {
          const capabilities = runtimeCapabilities(options);
          const sandbox = getSandbox(capabilities);
          const projection = getWorkspaceProjection(capabilities);
          const servers = projection.skills.filter((skill) => skill.kind === "mcp");
          const publicServer = servers.find(({ name }) => name === "public.mcp");
          const readBearer = (name: string) => {
            const authorization = servers.find((server) => server.name === name)?.config.headers
              ?.Authorization;
            if (
              typeof authorization !== "object" ||
              authorization === null ||
              !("__bearerRef" in authorization)
            ) {
              return Promise.reject(new Error(`authenticated MCP server ${name} has no bearer SecretRef`));
            }
            return sandbox.process
              .exec(
                `node -e 'process.stdout.write(process.env[process.argv[1]] ?? "")' '${authorization.__bearerRef.__secretName}'`,
              )
              .then(({ stdout }) => stdout);
          };
          return Promise.all([readBearer("linear.api"), readBearer("linear-api")]).then((liveBearers) => {
            observations.push({
              names: servers.map(({ name }) => name),
              publicHasAuthorization: publicServer?.config.headers?.Authorization !== undefined,
              liveBearers,
            });
          });
        };
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, workspace: checkout },
          mcp: [
            {
              identity: "local:repo/mcp/public.mcp",
              name: "public.mcp",
              projectedName: "public.mcp",
              endpoint: "https://public.example.test/mcp",
              authenticated: false,
              unavailableReason: null,
            },
            {
              identity: "local:repo/mcp/linear.api",
              name: "linear.api",
              projectedName: "linear.api",
              endpoint: "https://dot.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
            {
              identity: "local:repo/mcp/linear-api",
              name: "linear-api",
              projectedName: "linear-api",
              endpoint: "https://dash.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
          ],
        });
        const controlledDescriptor = descriptor(terminalEvents, probe);
        const runWith = (version: string) =>
          make([
            externalHarnessRunner(controlledDescriptor, {
              authentication: hostAuthentication,
            }),
          ])
            .run({
              plan,
              session: freshSession,
              mcpCredentials: new Map([
                ["local:repo/mcp/linear.api", Redacted.make(`${version}-dot-bearer`)],
                ["local:repo/mcp/linear-api", Redacted.make(`${version}-dash-bearer`)],
              ]),
            })
            .pipe(Stream.runCollect);

        const bearerNames = ["linear.api", "linear-api"].map(mcpBearerEnvironmentName);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const original = Object.fromEntries(
              bearerNames.map((environmentName) => [
                environmentName,
                Reflect.get(process.env, environmentName),
              ]),
            );
            Object.assign(
              process.env,
              Object.fromEntries(bearerNames.map((environmentName) => [environmentName, "host-bearer"])),
            );
            return original;
          }),
          () => Effect.forEach(["first", "rotated"], runWith, { discard: true }),
          (original) =>
            Effect.sync(() =>
              Object.entries(original).map(([environmentName, value]) =>
                value === undefined
                  ? Reflect.deleteProperty(process.env, environmentName)
                  : Reflect.set(process.env, environmentName, value),
              ),
            ),
        );
        assert.deepStrictEqual(observations, [
          {
            names: ["public.mcp", "linear.api", "linear-api"],
            publicHasAuthorization: false,
            liveBearers: ["first-dot-bearer", "first-dash-bearer"],
          },
          {
            names: ["public.mcp", "linear.api", "linear-api"],
            publicHasAuthorization: false,
            liveBearers: ["rotated-dot-bearer", "rotated-dash-bearer"],
          },
        ]);
      }),
    );

    it.effect("hands native MCP a latched Sandbox projection marker", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-native-mcp-" });
        yield* fs.writeFileString(`${checkout}/.git`, "gitdir: /elsewhere\n");
        const probe = new ControlledProbe();
        probe.inspect = (options) => {
          const capabilities = runtimeCapabilities(options);
          const sandbox = getSandbox(capabilities);
          const projection = getWorkspaceProjection(capabilities);
          return Promise.all([
            sandbox.fs.exists(projection.markerPath),
            sandbox.fs.exists(".git"),
            sandbox.fs.read("../outside").then(
              () => false,
              (error) =>
                error instanceof Error &&
                error.message.includes('path "../outside" resolves outside the sandbox root'),
            ),
            sandbox.fs.exists("/workspace/.git"),
          ]).then(([markerExists, relativeMarkerExists, traversalEscapeRejected, virtualMarkerExists]) => {
            assert.strictEqual(projection.root, "/workspace");
            assert.strictEqual(projection.skills.length, 0);
            assert.isTrue(markerExists);
            assert.isTrue(relativeMarkerExists);
            assert.isTrue(traversalEscapeRejected);
            assert.isTrue(virtualMarkerExists);
            return sandbox.fs.write(projection.markerPath, "gitdir: /elsewhere\n");
          });
        };
        const base = descriptor(terminalEvents, probe);
        const nativeDescriptor: ExternalHarnessDescriptor<ControlledAdapter> = {
          ...base,
          transport: { instructionProjection: "system-prompt", mcpProjection: "native" },
        };
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, workspace: checkout },
          mcp: [
            {
              identity: "local:repo/mcp/linear.api",
              name: "linear.api",
              projectedName: "linear__api__native",
              endpoint: "https://dot.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
          ],
        });

        const harness = make([
          externalHarnessRunner(nativeDescriptor, {
            authentication: hostAuthentication,
          }),
        ]);
        yield* harness
          .run({
            plan,
            session: freshSession,
            mcpCredentials: new Map([["local:repo/mcp/linear.api", Redacted.make("native-bearer")]]),
          })
          .pipe(Stream.runDrain);

        assert.deepStrictEqual(
          probe.resolved[0]?.request.mcp.map(({ name, endpoint, bearer }) => ({
            name,
            endpoint,
            bearer: bearer === null ? null : Redacted.value(bearer),
          })),
          [
            {
              name: "linear__api__native",
              endpoint: "https://dot.example.test/mcp",
              bearer: "native-bearer",
            },
          ],
        );
        assert.deepStrictEqual(yield* fs.readDirectory(checkout), [".git"]);
      }),
    );

    it.effect("rejects an authenticated MCP server without a live credential before launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor(terminalEvents, probe));
        const plan = RunPlan.make({
          ...request,
          mcp: [
            {
              identity: "local:repo/mcp/required-auth",
              name: "required-auth",
              projectedName: "required-auth",
              endpoint: "https://required.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
          ],
        });

        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "credential");
        assert.strictEqual(error.retryable, false);
        assert.include(error.message, "required-auth");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("launches through Harness and preserves complete AG-UI and structured-result events", () =>
      Effect.gen(function* () {
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
            name: "file.changed",
            value: { path: `${checkoutPath}/file.ts`, diff: "diff --git a/file.ts b/file.ts" },
            metadata: { controlled: { fidelity: "terminal" } },
          },
          {
            type: EventType.CUSTOM,
            name: "structured-output.complete",
            value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
          },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const harness = makeHarness(descriptor(events, probe));
        const output = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);

        const chatOptions = probe.chatOptions[0];
        if (!chatOptions) return assert.fail("adapter received no chat options");
        assert.strictEqual(getSandboxPolicy(runtimeCapabilities(chatOptions)), fullProfile);
        assert.strictEqual(output.filter((event) => event.name === "structured-output.complete").length, 1);
        const diagnostic = output.find((event) => event.name === "controlled.diagnostic");
        assert.deepStrictEqual(diagnostic?.value, { native: true });
        assert.deepStrictEqual(diagnostic?.metadata, { controlled: { trace: "trace-147" } });
        const fileDiff = output.find((event) => event.name === FILE_DIFF_EVENT);
        assert.deepStrictEqual(fileDiff?.value, {
          path: "file.ts",
          diff: "diff --git a/file.ts b/file.ts",
        });
        assert.deepStrictEqual(fileDiff?.metadata, { controlled: { fidelity: "terminal" } });
        assert.isFalse(output.some((event) => event.name === "file.changed"));
        const finished = output.find((event) => event.type === EventType.RUN_FINISHED);
        assert.deepStrictEqual(finished?.usage, {
          promptTokens: 2,
          completionTokens: 5,
          totalTokens: 7,
          estimated: true,
        });

        const launch = probe.resolved[0];
        assert.strictEqual(launch?.model, "controlled");
        assert.strictEqual(launch?.nativeAuthentication, "host");
        assert.strictEqual(launch?.request.identity.run, request.id);
        assert.strictEqual(launch?.request.identity.session, freshSession);
        assert.strictEqual(launch?.request.policy, "full");
        assert.strictEqual(launch?.request.checkout.path, checkoutPath);
        assert.strictEqual(launch?.request.operatingInstructions.path, "/instructions/implement-agent");
        assert.deepStrictEqual(launch?.request.prompt.slice(1), request.messages);
        assert.include(launch?.request.prompt[0]?.content ?? "", "Ship the external Harness change.");
        assert.include(
          launch?.request.prompt[0]?.content ?? "",
          "Keep this instruction in the admitted snapshot.",
        );
        assert.deepStrictEqual(launch?.request.outputSchema, request.structuredOutput);
        assert.strictEqual(probe.chatOptions[0]?.runId, request.id);
        assert.strictEqual(probe.chatOptions[0]?.threadId, freshSession);
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

    it.effect("bounds, drops, and hides file diffs on the shared client contract", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const oversized = "d".repeat(80 * 1024);
        const events: ReadonlyArray<StreamChunk> = [
          { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/big.ts`, diff: oversized },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/touched.ts`, diff: "" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/.tanstack-projected-abc123`, diff: "diff --git a/x b/x" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: {
              path: `${checkoutPath}/.tanstack-output-schema-run-1.json`,
              diff: "diff --git a/y b/y",
            },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/src/.tanstack-nested.ts`, diff: "diff --git a/n b/n" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: checkoutPath, diff: "diff --git a/z b/z" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: {
              path: `${checkoutPath}/.repos/effect/packages/effect/src/Stream.ts`,
              diff: "diff --git a/r b/r",
            },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/node_modules/left-pad/index.js`, diff: "diff --git a/m b/m" },
          },
          // TanStack makes `diff` optional, so a file event with no diff is a real
          // shape. It cannot carry the shared contract and must not survive under
          // its native name.
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/nodiff.ts`, type: "change", timestamp: 1 },
          },
          {
            type: EventType.CUSTOM,
            name: "structured-output.complete",
            value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
          },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const output = yield* makeHarness(descriptor(events, probe))
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);
        const diffs = output.filter(agUiIsFileDiffEvent);

        assert.deepStrictEqual(
          diffs.map((event) => event.value.path),
          ["big.ts", "src/.tanstack-nested.ts", "."],
        );
        // Nothing escapes under the native name, whatever the payload was.
        assert.isFalse(output.some((event) => event.name === "file.changed"));
        const big = diffs[0];
        if (!big) return assert.fail("the oversized diff was dropped");
        assert.isBelow(Buffer.byteLength(big.value.diff), Buffer.byteLength(oversized));
        assert.include(big.value.diff, "diff truncated by Cogwork");
      }),
    );

    it.effect("scrubs secrets before output, Workspace serialization, and persistence", () =>
      Effect.gen(function* () {
        const secret = "anthropic-test-key-secret";
        const probe = new ControlledProbe();
        const harness = makeHarness(
          descriptor(
            [
              { type: EventType.RUN_STARTED, threadId: "RUN", runId: "RUN" },
              {
                type: EventType.CUSTOM,
                name: "RUN",
                value: { message: `rejected RUN and ${secret}` },
              },
              {
                type: EventType.CUSTOM,
                name: "structured-output.complete",
                value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
              },
              { type: EventType.RUN_FINISHED, threadId: "RUN", runId: "RUN" },
            ],
            probe,
          ),
          {
            authentication: Effect.succeed({
              mode: "host",
              secrets: createSecrets({ LONG_KEY: secret, SHORT_KEY: "RUN" }),
            }),
          },
        );
        const output = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);
        const options = probe.chatOptions[0];
        if (!options) return yield* Effect.die("external Harness opened no chat");

        assert.strictEqual(output[0]?.type, EventType.RUN_STARTED);
        assert.strictEqual(output[0]?.threadId, "RUN");
        assert.strictEqual(output[1]?.name, "RUN");
        assert.deepStrictEqual(output[1]?.value, {
          message: "rejected [redacted] and [redacted]",
        });
        // The native adapter's own logger is the one channel cogwork cannot scrub on
        // the way out, so a request carrying secrets has to silence it outright. Drop
        // the `debug: false` wiring and this logger writes the secret to the console.
        const logs: Array<unknown> = [];
        vi.spyOn(console, "error").mockImplementation((...values) => logs.push(values));
        options.logger.errors("native adapter failed", { secret });
        assert.notInclude(yield* encodeJson(logs), secret);
        assert.notInclude(yield* encodeJson(getWorkspaceProjection(runtimeCapabilities(options))), secret);

        const record: RunRecord = {
          id: request.id,
          workspace: secretWorkspace,
          workItem: secretWorkItem,
          stage: "implement",
          harness: name,
          branch: null,
          session: freshSession,
          usage: null,
          status: "running",
          startedAtMillis: 1,
          endedAtMillis: null,
        };
        const recorder = yield* RunRecorder;
        yield* Effect.forEach(output, (event) => recorder.record(record, event));
        const persisted = yield* (yield* RunLedger.RunLedger).events(record.id).pipe(Stream.runCollect);
        assert.notInclude(yield* encodeJson(persisted), secret);
      }).pipe(Effect.provide(engineTestLayer())),
    );

    it.effect("resolves the native session handle before descriptor projection", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(
          descriptor(
            [
              { type: EventType.RUN_STARTED, threadId: resumedSession, runId: request.id },
              { type: EventType.RUN_FINISHED, threadId: resumedSession, runId: request.id },
            ],
            probe,
          ),
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
        assert.strictEqual(probe.chatOptions[0]?.runId, request.id);
        assert.strictEqual(probe.chatOptions[0]?.threadId, resumedSession);
        assert.strictEqual(probe.chatOptions[0]?.modelOptions?.sessionId, "native-session-147");
      }),
    );

    it.effect("keeps the shared external Harness launch nondurable", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor(terminalEvents, probe));

        yield* harness
          .run({ plan: request, session: resumedSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain);

        const options = probe.chatOptions[0];
        if (!options) return yield* Effect.die("external Harness opened no chat");
        assert.isFalse(SandboxDurabilityCapability.has(runtimeCapabilities(options)));
      }),
    );

    it.effect("rejects an external launch without a Cogwork Session", () =>
      Effect.gen(function* () {
        const harness = makeHarness(descriptor(terminalEvents, new ControlledProbe()));

        const error = yield* harness
          .run({ plan: request, session: null, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "launch");
        assert.include(error.message, "requires a Cogwork Session");
      }),
    );

    it.effect("aborts the adapter when the Harness consumer cancels the stream", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const events: ReadonlyArray<StreamChunk> = [
          { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const base = descriptor(events, probe);
        const harness = makeHarness({
          ...base,
          makeAdapter: (resolved) => {
            probe.resolved.push(resolved);
            return new ControlledAdapter(() => cancellableAsyncIterable(events, probe.cancellations), probe);
          },
        });

        yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.take(1), Stream.runDrain);

        assert.deepStrictEqual(probe.cancellations, [true]);
        assert.isTrue(probe.chatOptions[0]?.request?.signal?.aborted);
      }),
    );

    it.effect("maps native launch failures through the descriptor diagnostics", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const nativeFailure = new Error("controlled executable missing");
        const controlledDescriptor: ExternalHarnessDescriptor<ControlledAdapter> = {
          ...descriptor([], probe),
          makeAdapter: () => {
            throw nativeFailure;
          },
        };
        const harness = makeHarness(controlledDescriptor);
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "launch");
        assert.strictEqual(error.retryable, false);
        assert.strictEqual(error.message, nativeFailure.message);
      }),
    );

    it.effect("refuses authentication mismatch without trying another mode", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor([], probe), {
          authentication: Effect.succeed({ mode: "byok", secrets: {} }),
        });
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "credential");
        assert.include(error.message, "requires host authentication, received byok");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects a Run Plan without Sandbox middleware before adapter launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor([], probe));
        const plan = RunPlan.make({
          ...request,
          middleware: [],
        });
        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "sandbox");
        assert.include(error.message, "missing mandatory Sandbox projection");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects a Sandbox policy mismatch before adapter launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor([], probe));
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, policy: "read-only" },
        });
        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "policy");
        assert.include(error.message, "does not match its immutable Harness profile");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("preserves a run error event before failing through the Harness taxonomy", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const seen: Array<{ readonly [key: string]: unknown; readonly type: string }> = [];
        const harness = makeHarness(
          descriptor(
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
        );
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(
            Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
            Effect.flip,
          );

        assert.strictEqual(error.reason, "turn");
        assert.strictEqual(error.retryable, true);
        assert.strictEqual(error.message, "controlled turn failed");
        assert.strictEqual(seen[1]?.type, EventType.RUN_ERROR);
        assert.strictEqual(seen[1]?.code, "CONTROLLED_FAILURE");
        assert.deepStrictEqual(seen[1]?.metadata, { controlled: { retryAfter: 3 } });
      }),
    );
  });
});
