import { createHash } from "node:crypto";
import {
  AgUiEvent,
  type HarnessName,
  type RunId,
  type RunPlanInstruction,
  type RunPlanMessage,
  type RunPlanOperatingInstructions,
  type SessionId,
  type SessionKind,
} from "@cogwork/contracts";
import {
  type AnyTextAdapter,
  type ChatMiddleware,
  type ConstrainedModelMessage,
  chat,
  type JSONSchema,
  type ModelMessage,
  RUN_CANCEL_REASON,
  type SystemPrompt,
} from "@tanstack/ai";
import {
  bearer,
  createSecrets,
  defineSandbox,
  defineWorkspace,
  mcpSkill,
  type SandboxHooks,
  type SandboxPolicy,
  type SandboxProvider,
  type Secrets,
  type WorkspaceDefinition,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  HarnessError,
  type HarnessExecution,
  type HarnessRequest,
  type HarnessRunner,
  type HarnessRunnerEnv,
  type OperationPolicyProfile,
  type ResolvedMcpSkill,
  resolvedMcpSkills,
} from "./harness";
import { bridgeChat } from "./provider-bridge";
import { SessionStore } from "./session-store";

type AdapterModel<Adapter extends AnyTextAdapter> = Adapter["model"];
type AdapterOptions<Adapter extends AnyTextAdapter> = Adapter["~types"]["providerOptions"];
type AdapterSystemPrompt<Adapter extends AnyTextAdapter> = SystemPrompt<
  Adapter["~types"]["systemPromptMetadata"]
>;
type AdapterMessage<Adapter extends AnyTextAdapter> = ConstrainedModelMessage<{
  inputModalities: Adapter["~types"]["inputModalities"];
  messageMetadataByModality: Adapter["~types"]["messageMetadataByModality"];
}>;

export interface ExternalHarnessAuthentication {
  readonly mode: string;
  readonly secrets: Secrets;
}

export interface ExternalHarnessIdentity {
  readonly run: RunId;
  readonly session: SessionId | null;
  readonly resumeHandle: string | null;
}

export interface ExternalHarnessSelection {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface ExternalHarnessCheckout {
  readonly path: string;
}

export interface ExternalHarnessSecrets {
  readonly mcp: ReadonlyMap<string, Redacted.Redacted<string>>;
}

export interface ExternalHarnessResolvedRequest {
  readonly identity: ExternalHarnessIdentity;
  readonly selection: ExternalHarnessSelection;
  readonly authentication: ExternalHarnessAuthentication;
  readonly policy: OperationPolicyProfile;
  readonly instructions: ReadonlyArray<RunPlanInstruction>;
  readonly operatingInstructions: RunPlanOperatingInstructions;
  readonly mcp: ReadonlyArray<ResolvedMcpSkill>;
  readonly secrets: ExternalHarnessSecrets;
  readonly checkout: ExternalHarnessCheckout;
  readonly prompt: ReadonlyArray<RunPlanMessage>;
  readonly outputSchema: JSONSchema | null;
}

export interface ExternalHarnessCapabilities {
  readonly execution: HarnessExecution;
  readonly projectedMembers: HarnessRunner["projectedMembers"];
  readonly planMiddleware: HarnessRunner["planMiddleware"];
}

export interface ExternalHarnessOptionCatalogSource {
  readonly kind: string;
  readonly version: string;
}

export interface ExternalHarnessTransport<Adapter extends AnyTextAdapter> {
  readonly messages?: (
    request: ExternalHarnessResolvedRequest,
  ) => ReadonlyArray<ModelMessage | AdapterMessage<Adapter>>;
  readonly systemPrompts?: (
    request: ExternalHarnessResolvedRequest,
  ) => ReadonlyArray<AdapterSystemPrompt<Adapter>>;
  readonly middleware?: (request: ExternalHarnessResolvedRequest) => ReadonlyArray<ChatMiddleware>;
}

export type ExternalHarnessUsageEstimator = (
  request: ExternalHarnessResolvedRequest,
  event: AgUiEvent,
  outputTextCharacters: number,
) => AgUiEvent;

export interface ExternalHarnessDescriptor<Adapter extends AnyTextAdapter, NativeAuthentication = unknown> {
  readonly name: HarnessName;
  readonly sessionKind: SessionKind;
  readonly capabilities: ExternalHarnessCapabilities;
  readonly optionCatalogSource: ExternalHarnessOptionCatalogSource;
  readonly makeAdapter: (input: {
    readonly model: AdapterModel<Adapter>;
    readonly authentication: NativeAuthentication;
    readonly request: ExternalHarnessResolvedRequest;
  }) => Adapter;
  readonly projectModel: (request: ExternalHarnessResolvedRequest) => AdapterModel<Adapter>;
  readonly projectOptions: (request: ExternalHarnessResolvedRequest) => AdapterOptions<Adapter>;
  readonly projectAuthentication: (authentication: ExternalHarnessAuthentication) => NativeAuthentication;
  readonly transport: ExternalHarnessTransport<Adapter>;
  readonly diagnostics: (cause: unknown) => HarnessError;
  readonly estimateUsage?: ExternalHarnessUsageEstimator;
}

type ExternalInputEffect<Value> = Effect.Effect<Value, HarnessError, HarnessRunnerEnv>;

export interface ExternalHarnessRuntimeInputs {
  readonly authentication: (request: HarnessRequest) => ExternalInputEffect<ExternalHarnessAuthentication>;
  readonly sandboxProvider: (request: ExternalHarnessResolvedRequest) => ExternalInputEffect<SandboxProvider>;
  readonly sandboxPolicy?: (request: ExternalHarnessResolvedRequest) => ExternalInputEffect<SandboxPolicy>;
  readonly fileHooks?: SandboxHooks;
}

const preparedWorkspace = { source: { type: "none" } } satisfies WorkspaceDefinition;

const mcpSecretName = (name: string) =>
  `COGWORK_MCP_${createHash("sha256").update(name).digest("hex").toUpperCase()}_BEARER`;

const workspaceInstructions = (request: ExternalHarnessResolvedRequest) =>
  [
    ...request.instructions.map(({ content }) => content),
    `Mandatory Operating Instructions: ${request.operatingInstructions.path}`,
  ].join("\n\n");

const mcpSkillConfig = (secrets: Secrets, server: ResolvedMcpSkill) => {
  const secret = server.bearer === null ? undefined : secrets[mcpSecretName(server.name)];
  if (!secret) return { url: server.endpoint };
  return { url: server.endpoint, headers: { Authorization: bearer(secret) } };
};

const mcpSecretEntry = ({ name, bearer: secret }: ResolvedMcpSkill) => {
  if (secret === null) return [];
  return [[mcpSecretName(name), Redacted.value(secret)] satisfies readonly [string, string]];
};

const mcpWorkspaceProjection = (request: ExternalHarnessResolvedRequest) => {
  const secretValues = Object.fromEntries(request.mcp.flatMap(mcpSecretEntry));
  const secrets = createSecrets(secretValues);
  const skills = request.mcp.map((server) => mcpSkill(server.name, mcpSkillConfig(secrets, server)));
  return { secrets, skills, hasSecrets: Object.keys(secretValues).length > 0 };
};

const harnessWorkspace = (request: ExternalHarnessResolvedRequest) => {
  const mcp = mcpWorkspaceProjection(request);
  return {
    ...preparedWorkspace,
    instructions: workspaceInstructions(request),
    ...(mcp.skills.length > 0 ? { skills: mcp.skills } : {}),
    ...(mcp.hasSecrets ? { secrets: mcp.secrets } : {}),
  } satisfies WorkspaceDefinition;
};

const requiredWorkspaceMembers = (request: ExternalHarnessResolvedRequest) => {
  const base = ["Instructions", "Messages", "Sandbox"] satisfies HarnessRunner["projectedMembers"];
  if (request.mcp.length === 0) return base;
  return [...base, "MCP" satisfies HarnessRunner["projectedMembers"][number]];
};

const validateWorkspaceProjection = Effect.fn("ExternalHarnessRuntime.validateWorkspaceProjection")(
  function* <Adapter extends AnyTextAdapter, NativeAuthentication>(
    descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
    request: HarnessRequest,
    resolved: ExternalHarnessResolvedRequest,
  ) {
    const missingCredentials = request.plan.mcp.flatMap((server) =>
      "endpoint" in server && server.authenticated && !request.mcpCredentials.has(server.identity)
        ? [server.projectedName]
        : [],
    );
    if (missingCredentials.length > 0) {
      return yield* new HarnessError({
        reason: "credential",
        retryable: false,
        message: `authenticated MCP servers have no live credential: ${missingCredentials.join(", ")}`,
      });
    }
    const projected = new Set<string>(descriptor.capabilities.projectedMembers);
    const missing = requiredWorkspaceMembers(resolved).filter((member) => !projected.has(member));
    if (missing.length === 0) return;
    return yield* new HarnessError({
      reason: "launch",
      retryable: false,
      message: `harness runner ${descriptor.name} cannot project required Harness Workspace members: ${missing.join(", ")}`,
    });
  },
);

const resolveResumeHandle = Effect.fn("ExternalHarnessRuntime.resolveResumeHandle")(function* (
  session: SessionId | null,
) {
  if (!session) return null;
  const store = yield* SessionStore;
  return yield* store.resumeHandle(session);
});

const resolvedRequest = Effect.fn("ExternalHarnessRuntime.resolveRequest")(function* (
  request: HarnessRequest,
  authentication: ExternalHarnessAuthentication,
) {
  const resumeHandle = yield* resolveResumeHandle(request.session);
  return {
    identity: { run: request.plan.id, session: request.session, resumeHandle },
    selection: { model: request.plan.harness.model, effort: request.plan.harness.effort },
    authentication,
    policy: request.plan.harness.profile,
    instructions: request.plan.instructions,
    operatingInstructions: request.plan.operatingInstructions,
    mcp: resolvedMcpSkills(request),
    secrets: { mcp: request.mcpCredentials },
    checkout: { path: request.plan.sandbox.workspace },
    prompt: request.plan.messages,
    outputSchema: request.plan.structuredOutput,
  } satisfies ExternalHarnessResolvedRequest;
});

const outputCharacters = (event: AgUiEvent) =>
  AgUiEvent.guards.TEXT_MESSAGE_CONTENT(event) || AgUiEvent.guards.REASONING_MESSAGE_CONTENT(event)
    ? (event.delta?.length ?? 0)
    : 0;

const preserveUsage: ExternalHarnessUsageEstimator = (_request, event) => event;

const withUsage = (
  request: ExternalHarnessResolvedRequest,
  estimate: ExternalHarnessUsageEstimator,
  stream: Stream.Stream<AgUiEvent, HarnessError>,
) =>
  Stream.mapAccum(
    stream,
    () => 0,
    (characters, event): readonly [number, ReadonlyArray<AgUiEvent>] => {
      const next = characters + outputCharacters(event);
      return [next, [estimate(request, event, next)]];
    },
  );

const adapterMessages = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  request: ExternalHarnessResolvedRequest,
) =>
  descriptor.transport.messages?.(request) ?? request.prompt.map(({ role, content }) => ({ role, content }));

const makeChatStream = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  request: ExternalHarnessResolvedRequest,
  adapter: Adapter,
  middleware: ReadonlyArray<ChatMiddleware>,
  abortController: AbortController,
) =>
  chat({
    adapter,
    messages: [...adapterMessages(descriptor, request)],
    systemPrompts: [...(descriptor.transport.systemPrompts?.(request) ?? [])],
    middleware: [...middleware, ...(descriptor.transport.middleware?.(request) ?? [])],
    abortController,
    modelOptions: descriptor.projectOptions(request),
    outputSchema: request.outputSchema ?? undefined,
    threadId: request.identity.session ?? request.identity.run,
    runId: request.identity.run,
    stream: true,
  });

const abortOnReturn = <Value>(stream: AsyncIterable<Value>, abortController: AbortController) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = stream[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: (value?: unknown): Promise<IteratorResult<Value>> => {
        abortController.abort(RUN_CANCEL_REASON);
        if (iterator.return) {
          return iterator.return(value);
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  },
});

const openChat = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  inputs: ExternalHarnessRuntimeInputs,
  request: ExternalHarnessResolvedRequest,
  provider: SandboxProvider,
  workspaceDefinition: WorkspaceDefinition,
  policy: SandboxPolicy | null,
) => {
  const model = descriptor.projectModel(request);
  const nativeAuthentication = descriptor.projectAuthentication(request.authentication);
  const adapter = descriptor.makeAdapter({ model, authentication: nativeAuthentication, request });
  const sandbox = defineSandbox({
    id: `cogwork-${descriptor.name}`,
    provider,
    workspace: defineWorkspace(workspaceDefinition),
    lifecycle: { reuse: "none", snapshot: "none", destroyOnComplete: true },
    ...(policy ? { policy } : {}),
    fileEvents: inputs.fileHooks !== undefined,
    ...(inputs.fileHooks ? { hooks: inputs.fileHooks } : {}),
  });
  const abortController = new AbortController();
  const stream = makeChatStream(descriptor, request, adapter, [withSandbox(sandbox)], abortController);
  return { abortController, stream };
};

export const externalHarnessRunner = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  inputs: ExternalHarnessRuntimeInputs,
): HarnessRunner => ({
  name: descriptor.name,
  sessionKind: descriptor.sessionKind,
  execution: descriptor.capabilities.execution,
  projectedMembers: descriptor.capabilities.projectedMembers,
  planMiddleware: descriptor.capabilities.planMiddleware,
  run: (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const authentication = yield* inputs.authentication(request);
        const resolved = yield* resolvedRequest(request, authentication);
        yield* validateWorkspaceProjection(descriptor, request, resolved);
        const provider = yield* inputs.sandboxProvider(resolved);
        const workspaceDefinition = harnessWorkspace(resolved);
        const policy = yield* inputs.sandboxPolicy?.(resolved) ?? Effect.succeed(null);
        const opened = yield* Effect.try({
          try: () => openChat(descriptor, inputs, resolved, provider, workspaceDefinition, policy),
          catch: descriptor.diagnostics,
        });
        return withUsage(
          resolved,
          descriptor.estimateUsage ?? preserveUsage,
          bridgeChat(
            abortOnReturn(opened.stream, opened.abortController),
            descriptor.diagnostics,
            descriptor.diagnostics,
          ).pipe(Stream.ensuring(Effect.sync(() => opened.abortController.abort()))),
        );
      }).pipe(Effect.withSpan("ExternalHarnessRuntime.run")),
    ),
});

export const trustedLocalProcessSandboxProvider =
  (options: { readonly scrubEnv: ReadonlyArray<string> }) => (request: ExternalHarnessResolvedRequest) =>
    Effect.succeed(
      localProcessSandbox({
        dir: request.checkout.path,
        scrubEnv: [...options.scrubEnv],
      }),
    );
