import {
  type AgUiEvent,
  agUiIsFileDiffEvent,
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
import type {
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  WorkspaceDefinition,
} from "@tanstack/ai-sandbox";
import {
  createSecrets,
  getSandbox,
  getWorkspaceProjection,
  SandboxDurabilityCapability,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
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
  type ExternalHarnessAuthentication,
  type ExternalHarnessDescriptor,
  externalHarnessRunner,
} from "./external-harness-runtime";
import {
  fullHarnessExecution,
  HarnessError,
  HarnessPreflightInput,
  make,
  staticCatalogSource,
} from "./harness";
import { messageFromUnknown } from "./provider-bridge";
import * as RunLedger from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { engineTestLayer } from "./testing/engine-test-layer";

afterEach(() => vi.restoreAllMocks());

const name = Schema.decodeSync(HarnessName)("controlled-external");
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
  readonly resolved: Array<
    Parameters<ExternalHarnessDescriptor<ControlledAdapter, string>["makeAdapter"]>[0]
  > = [];
  readonly chatOptions: Array<TextOptions<ControlledOptions>> = [];
  readonly cancellations: Array<true> = [];
  readonly sandboxDestructions: Array<true> = [];
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

const watchProbeSandbox = (probe: { watches: number }) => {
  const handle = sandboxHandle("watch-probe-sandbox");
  return {
    ...handle,
    fs: {
      ...handle.fs,
      list: () => Promise.resolve([]),
      exists: () => Promise.resolve(true),
      watch: () => {
        probe.watches += 1;
        return Promise.resolve({ stop: () => Promise.resolve() });
      },
    },
  } satisfies SandboxHandle;
};

const sandboxHandle = (id: string) =>
  ({
    id,
    provider: "controlled",
    workspaceRoot: "/checkout",
    capabilities,
    fs: {
      read: () => Promise.reject(new Error("unexpected read")),
      readBytes: () => Promise.reject(new Error("unexpected byte read")),
      write: () => Promise.resolve(),
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

const controlledProvider = (
  created: Array<string>,
  destructions: Array<true>,
  workspaces: Array<WorkspaceDefinition> = [],
) =>
  ({
    name: "controlled",
    capabilities: () => capabilities,
    create: (input) => {
      created.push(input.workspace?.source.type ?? "missing");
      if (input.workspace) workspaces.push(input.workspace);
      return Promise.resolve(sandboxHandle("controlled-sandbox"));
    },
    resume: () => Promise.resolve(null),
    destroy: () => {
      destructions.push(true);
      return Promise.resolve();
    },
  }) satisfies SandboxProvider;

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
      session: { affinity: "runtime-host", fork: false, humanAttach: false },
      structuredOutput: "native",
      policyFidelity: "exact",
      fileEventFidelity: "terminal-only",
      usageQuality: "estimated",
      readinessDiagnostics: true,
      journal: false,
      takeover: false,
    },
    projectedMembers: ["Harness Adapter", "Instructions", "Messages", "MCP", "Sandbox", "Structured Output"],
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
  transport: {},
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
  controlledDescriptor: ExternalHarnessDescriptor<ControlledAdapter, string>,
  created: Array<string>,
  destructions: Array<true> = [],
  options: {
    readonly authentication?: Effect.Effect<ExternalHarnessAuthentication>;
    readonly provider?: SandboxProvider;
    readonly workspaces?: Array<WorkspaceDefinition>;
  } = {},
) =>
  make([
    externalHarnessRunner(controlledDescriptor, {
      authentication: () => options.authentication ?? Effect.succeed({ mode: "host", secrets: {} }),
      sandboxProvider: () =>
        Effect.succeed(options.provider ?? controlledProvider(created, destructions, options.workspaces)),
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

describe("external Harness runtime", () => {
  it.layer(harnessRunnerLayer)((it) => {
    it.effect(
      "projects mandatory instructions through one Harness Workspace and keeps work context user-authored",
      () =>
        Effect.gen(function* () {
          const created: Array<string> = [];
          const destructions: Array<true> = [];
          const workspaces: Array<WorkspaceDefinition> = [];
          const probe = new ControlledProbe();
          const harness = makeHarness(descriptor(terminalEvents, probe), created, destructions, {
            workspaces,
          });

          yield* harness
            .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
            .pipe(Stream.runDrain);

          assert.strictEqual(workspaces.length, 1);
          assert.strictEqual(workspaces[0]?.source.type, "none");
          assert.include(workspaces[0]?.instructions ?? "", "Follow repo rules.");
          assert.include(
            workspaces[0]?.instructions ?? "",
            "Mandatory Operating Instructions: /instructions/implement-agent",
          );
          assert.deepStrictEqual(probe.chatOptions[0]?.messages, [
            { role: "user", content: "Implement #147." },
          ]);
          assert.deepStrictEqual(probe.chatOptions[0]?.systemPrompts, []);
          assert.deepStrictEqual(destructions, [true]);
        }),
    );

    it.effect("ends a Run whose checkout feed never sees an event", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-harness-feed-" });
        const created: Array<string> = [];
        const watchProbe = { watches: 0 };
        const base = descriptor(terminalEvents, new ControlledProbe());
        const harness = makeHarness({ ...base, transport: { runtimeFileDiffFeed: true } }, created, [], {
          provider: {
            ...controlledProvider(created, []),
            create: () => Promise.resolve(watchProbeSandbox(watchProbe)),
          },
        });
        const seen: Array<AgUiEvent> = [];

        yield* harness
          .run({
            plan: RunPlan.make({ ...request, sandbox: { ...request.sandbox, workspace: checkout } }),
            session: freshSession,
            mcpCredentials: new Map(),
          })
          .pipe(Stream.runForEach((event) => Effect.sync(() => seen.push(event))));

        assert.strictEqual(watchProbe.watches, 0);
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
          operatingInstructions: {
            name: "implement-agent",
            path: resourceDirectory,
            resources: [{ source: resource, content: "supporting guide" }],
          },
        });
        const harness = make([
          externalHarnessRunner(descriptor(terminalEvents, probe), {
            authentication: hostAuthentication,
            sandboxProvider: () => Effect.succeed(localProcessSandbox({ dir: checkout })),
          }),
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
            sandboxProvider: (resolved) =>
              Effect.succeed(localProcessSandbox({ dir: resolved.checkout.path })),
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
              sandboxProvider: () => Effect.succeed(localProcessSandbox({ dir: checkout })),
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

        yield* runWith("first");
        yield* runWith("rotated");
        const agents = yield* fs.readFileString(`${checkout}/AGENTS.md`);

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
        assert.notInclude(agents, "first-dot-bearer");
        assert.notInclude(agents, "first-dash-bearer");
        assert.notInclude(agents, "rotated-dot-bearer");
        assert.notInclude(agents, "rotated-dash-bearer");
      }),
    );

    it.effect("hands MCP to the descriptor and leaves the checkout untouched for native MCP projection", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-native-mcp-" });
        const probe = new ControlledProbe();
        const projections: Array<{ readonly skills: number; readonly markerGate: string }> = [];
        probe.inspect = (options) => {
          const projection = getWorkspaceProjection(runtimeCapabilities(options));
          projections.push({
            skills: projection.skills.length,
            markerGate: projection.markerPath.split("/").at(-1) ?? "",
          });
          return Promise.resolve();
        };
        const base = descriptor(terminalEvents, probe);
        const nativeDescriptor: ExternalHarnessDescriptor<ControlledAdapter, string> = {
          ...base,
          transport: { instructionProjection: "system-prompt", mcpProjection: "native" },
        };
        const plan = RunPlan.make({
          ...request,
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

        yield* make([
          externalHarnessRunner(nativeDescriptor, {
            authentication: hostAuthentication,
            sandboxProvider: () => Effect.succeed(localProcessSandbox({ dir: checkout })),
          }),
        ])
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
        assert.deepStrictEqual(projections, [{ skills: 0, markerGate: ".git" }]);
        assert.deepStrictEqual(yield* fs.readDirectory(checkout), []);
      }),
    );

    it.effect("rejects a required MCP projection before the native Harness launches", () =>
      Effect.gen(function* () {
        const created: Array<string> = [];
        const probe = new ControlledProbe();
        const base = descriptor(terminalEvents, probe);
        const harness = makeHarness(
          {
            ...base,
            capabilities: {
              ...base.capabilities,
              projectedMembers: base.capabilities.projectedMembers.filter((member) => member !== "MCP"),
            },
          },
          created,
        );
        const plan = RunPlan.make({
          ...request,
          mcp: [
            {
              identity: "local:repo/mcp/required",
              name: "required",
              projectedName: "required",
              endpoint: "https://required.example.test/mcp",
              authenticated: false,
              unavailableReason: null,
            },
          ],
        });

        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "workspace");
        assert.strictEqual(error.retryable, false);
        assert.include(error.message, "MCP");
        assert.deepStrictEqual(created, []);
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects an authenticated MCP server without a live credential before launch", () =>
      Effect.gen(function* () {
        const created: Array<string> = [];
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor(terminalEvents, probe), created);
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
        assert.deepStrictEqual(created, []);
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

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
            name: "file.changed",
            value: { path: "/checkout/file.ts", diff: "diff --git a/file.ts b/file.ts" },
            metadata: { controlled: { fidelity: "terminal" } },
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
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);

        assert.deepStrictEqual(created, ["none"]);
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
        assert.strictEqual(launch?.authentication, "host");
        assert.strictEqual(launch?.request.identity.run, request.id);
        assert.strictEqual(launch?.request.identity.session, freshSession);
        assert.strictEqual(launch?.request.policy, "full");
        assert.strictEqual(launch?.request.checkout.path, "/checkout");
        assert.strictEqual(launch?.request.operatingInstructions.path, "/instructions/implement-agent");
        assert.deepStrictEqual(launch?.request.prompt, request.messages);
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
            value: { path: "/checkout/big.ts", diff: oversized },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: "/checkout/touched.ts", diff: "" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: "/checkout/.tanstack-projected-abc123", diff: "diff --git a/x b/x" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: {
              path: "/checkout/.tanstack-output-schema-run-1.json",
              diff: "diff --git a/y b/y",
            },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: "/checkout/src/.tanstack-nested.ts", diff: "diff --git a/n b/n" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: "/checkout", diff: "diff --git a/z b/z" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: {
              path: "/checkout/.repos/effect/packages/effect/src/Stream.ts",
              diff: "diff --git a/r b/r",
            },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: "/checkout/node_modules/left-pad/index.js", diff: "diff --git a/m b/m" },
          },
          // TanStack makes `diff` optional, so a file event with no diff is a real
          // shape. It cannot carry the shared contract and must not survive under
          // its native name.
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: "/checkout/nodiff.ts", type: "change", timestamp: 1 },
          },
          {
            type: EventType.CUSTOM,
            name: "structured-output.complete",
            value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
          },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const output = yield* makeHarness(descriptor(events, probe), [])
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
        const workspaces: Array<WorkspaceDefinition> = [];
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
          [],
          [],
          {
            authentication: Effect.succeed({
              mode: "host",
              secrets: createSecrets({ LONG_KEY: secret, SHORT_KEY: "RUN" }),
            }),
            workspaces,
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
        assert.notInclude(yield* encodeJson(workspaces), secret);

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
        assert.strictEqual(probe.chatOptions[0]?.runId, request.id);
        assert.strictEqual(probe.chatOptions[0]?.threadId, resumedSession);
        assert.strictEqual(probe.chatOptions[0]?.modelOptions?.sessionId, "native-session-147");
      }),
    );

    it.effect("keeps the shared external Harness launch nondurable", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor(terminalEvents, probe), []);

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
        const harness = makeHarness(descriptor(terminalEvents, new ControlledProbe()), []);

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
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
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
        };
        const harness = makeHarness(controlledDescriptor, created);
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
        const created: Array<string> = [];
        const harness = makeHarness(descriptor([], probe), created, [], {
          authentication: Effect.succeed({ mode: "byok", secrets: {} }),
        });
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
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
        const harness = makeHarness(descriptor([], probe), created, [], { provider });
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "sandbox");
        assert.include(error.message, "killable processes");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects missing Workspace projection before resolving policy", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const base = descriptor([], probe);
        const runner = externalHarnessRunner(
          {
            ...base,
            capabilities: {
              ...base.capabilities,
              projectedMembers: base.capabilities.projectedMembers.filter(
                (member) => member !== "Instructions",
              ),
            },
          },
          {
            authentication: () => Effect.succeed({ mode: "host", secrets: {} }),
            sandboxProvider: () => Effect.succeed(controlledProvider([], [])),
            sandboxPolicy: () => Effect.die(new Error("policy resolution must follow Workspace resolution")),
          },
        );

        const error = yield* runner
          .preflight(
            HarnessPreflightInput.Launch({
              request: { plan: request, session: freshSession, mcpCredentials: new Map() },
            }),
          )
          .pipe(Effect.flip);

        assert.strictEqual(error.reason, "workspace");
        assert.include(error.message, "Instructions");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects a Run Plan without Sandbox middleware before adapter launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const harness = makeHarness(descriptor([], probe), created);
        const plan = RunPlan.make({
          ...request,
          middleware: [],
        });
        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "sandbox");
        assert.include(error.message, "missing mandatory Sandbox projection");
        assert.deepStrictEqual(created, []);
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects a Sandbox policy mismatch before adapter launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
        const harness = makeHarness(descriptor([], probe), created);
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, policy: "read-only" },
        });
        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "policy");
        assert.include(error.message, "does not match its immutable Harness profile");
        assert.deepStrictEqual(created, []);
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("preserves a run error event before failing through the Harness taxonomy", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const created: Array<string> = [];
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
          created,
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
