import type {
  HarnessName,
  RunId,
  RunPlanInstruction,
  RunPlanMessage,
  RunPlanOperatingInstructions,
  SessionId,
  SessionKind,
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
  defineSandbox,
  defineWorkspace,
  type SandboxHooks,
  type SandboxPolicy,
  type SandboxProvider,
  type Secrets,
  type WorkspaceDefinition,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  type AgUiEvent,
  type HarnessError,
  type HarnessExecution,
  type HarnessRequest,
  type HarnessRunner,
  type HarnessRunnerEnv,
  type OperationPolicyProfile,
  type ResolvedMcpSkill,
  resolvedMcpSkills,
} from "./harness";
import { bridgeChat } from "./provider-bridge";

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
  readonly workspace: (request: ExternalHarnessResolvedRequest) => ExternalInputEffect<WorkspaceDefinition>;
  readonly sandboxPolicy: (
    request: ExternalHarnessResolvedRequest,
  ) => ExternalInputEffect<SandboxPolicy | undefined>;
  readonly fileHooks?: SandboxHooks;
}

const preparedWorkspace = { source: { type: "none" } } satisfies WorkspaceDefinition;

const resolvedRequest = (request: HarnessRequest, authentication: ExternalHarnessAuthentication) => ({
  identity: { run: request.plan.id, session: request.session },
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
});

const outputCharacters = (event: AgUiEvent) =>
  event.type === "TEXT_MESSAGE_CONTENT" || event.type === "REASONING_MESSAGE_CONTENT"
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
  policy: SandboxPolicy | undefined,
) => {
  const workspace = defineWorkspace(workspaceDefinition);
  const model = descriptor.projectModel(request);
  const nativeAuthentication = descriptor.projectAuthentication(request.authentication);
  const adapter = descriptor.makeAdapter({ model, authentication: nativeAuthentication, request });
  const sandbox = defineSandbox({
    id: `cogwork-${descriptor.name}`,
    provider,
    workspace,
    ...(policy ? { policy } : {}),
    fileEvents: true,
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
        const resolved = resolvedRequest(request, authentication);
        const provider = yield* inputs.sandboxProvider(resolved);
        const workspaceDefinition = yield* inputs.workspace(resolved);
        const policy = yield* inputs.sandboxPolicy(resolved);
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

export const preparedCheckoutWorkspace = () => (_request: ExternalHarnessResolvedRequest) =>
  Effect.succeed(preparedWorkspace);

export const trustedLocalProcessSandboxProvider =
  (options: { readonly scrubEnv: ReadonlyArray<string> }) => (request: ExternalHarnessResolvedRequest) =>
    Effect.succeed(
      localProcessSandbox({
        dir: request.checkout.path,
        scrubEnv: [...options.scrubEnv],
      }),
    );
