import { HarnessName, RunId, RunPlan, SessionId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  type DefaultMessageMetadataByModality,
  EventType,
  type JSONSchema,
  type StreamChunk,
  type TextAdapter,
  type TextOptions,
} from "@tanstack/ai";
import { memoryPersistence } from "@tanstack/ai-persistence";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ContextAssembler } from "./context-assembler";
import { CredentialStore } from "./credential-store";
import {
  type ExternalHarnessAuthentication,
  type ExternalHarnessDescriptor,
  externalHarnessRunner,
} from "./external-harness-runtime";
import { fullHarnessExecution, HarnessError, make } from "./harness";
import { messageFromUnknown } from "./provider-bridge";
import { SessionStore } from "./session-store";

export const name = Schema.decodeSync(HarnessName)("controlled-external");
export const checkoutPath = process.cwd();
export const freshSession = Schema.decodeSync(SessionId)("sess-external-fresh");
export const resumedSession = Schema.decodeSync(SessionId)("sess-external-147");
export const secondCheckoutRunId = Schema.decodeSync(RunId)("run-second-checkout");
export const secretWorkspace = Schema.decodeSync(WorkspaceId)("workspace-secret-test");
export const secretWorkItem = Schema.decodeSync(WorkItemId)("#153");
export const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export interface ControlledOptions {
  readonly effort: string;
  readonly authentication: string;
  readonly sessionId: string | null;
}

export class ControlledAdapter implements TextAdapter<
  "controlled",
  ControlledOptions,
  readonly ["text"],
  DefaultMessageMetadataByModality
> {
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

export class ControlledProbe {
  readonly resolved: Array<Parameters<ExternalHarnessDescriptor<ControlledAdapter>["makeAdapter"]>[0]> = [];
  readonly chatOptions: Array<TextOptions<ControlledOptions>> = [];
  readonly cancellations: Array<true> = [];
  inspect?: (options: TextOptions<ControlledOptions>) => Promise<void>;
}

export const runtimeCapabilities = (options: TextOptions<ControlledOptions>) => {
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

export const toAsyncIterable = <Value>(values: ReadonlyArray<Value>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = values[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  },
});

export const cancellableAsyncIterable = <Value>(
  values: ReadonlyArray<Value>,
  cancellations: Array<true>,
) => ({
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

export const harnessRunnerLayer = Layer.mergeAll(
  Layer.succeed(SessionStore, harnessServices.sessionStore),
  Layer.succeed(ContextAssembler, harnessServices.contextAssembler),
  Layer.succeed(CredentialStore, harnessServices.credentialStore),
  NodeFileSystem.layer,
  NodePath.layer,
  FetchHttpClient.layer,
);

export const hostAuthentication = () =>
  Effect.succeed({ mode: "host", secrets: {} } satisfies ExternalHarnessAuthentication);

export const request = Schema.decodeSync(RunPlan)({
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
      assignees: [],
      openBlockers: 0,
      claim: null,
      priority: "medium",
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

export const descriptor = (
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

export const makeHarness = (
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

export const terminalEvents: ReadonlyArray<StreamChunk> = [
  { type: EventType.RUN_STARTED, threadId: "session-148", runId: request.id },
  {
    type: EventType.CUSTOM,
    name: "structured-output.complete",
    value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
  },
  { type: EventType.RUN_FINISHED, threadId: "session-148", runId: request.id },
];
