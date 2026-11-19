import type {
  AgUiEvent,
  HarnessName,
  ModelOptionSelections,
  RunId,
  RunPlanInstruction,
  RunPlanMember,
  RunPlanMessage,
  RunPlanOperatingInstructions,
  SessionId,
} from "@cogwork/contracts";
import {
  type AnyTextAdapter,
  type AnyTool,
  type ChatMiddleware,
  chat,
  type JSONSchema,
  RUN_CANCEL_REASON,
} from "@tanstack/ai";
import {
  defineSandbox,
  defineWorkspace,
  type SandboxProvider,
  type Secrets,
  type WorkspaceDefinition,
  withSandbox,
} from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  checkoutFileDiffs,
  mergeCheckoutFileDiffs,
  normalizeFileEvent,
  preserveUsage,
  publicFileEvent,
  withUsage,
} from "./external-harness-runtime-events";
import { projectedSkills, resolveExternalLaunch } from "./external-harness-runtime-launch";
import {
  satisfiedProjection,
  scrubEvent,
  scrubHarnessError,
  workspaceInstructions,
  writesWorkspaceFiles,
} from "./external-harness-runtime-workspace";
import {
  type HarnessAuthenticationBinding,
  type HarnessAuthenticationMode,
  type HarnessCapabilityProfile,
  type HarnessCatalogOptions,
  type HarnessError,
  type HarnessExecution,
  HarnessPreflightInput,
  type HarnessReadiness,
  type HarnessRequest,
  type HarnessRunner,
  type HarnessRunnerEnv,
  type OperationPolicyProfile,
  type ResolvedMcpSkill,
  validateCheckoutDirectory,
} from "./harness";
import { bridgeChat } from "./provider-bridge";
import {
  type AvailableSubagent,
  type ModelLevels,
  makeSubagentFeed,
  mergeSubagentFeed,
  modelLevelRunner,
  type SubagentFeed,
  subagentProjection,
} from "./subagent-runner";
import { policyForProfile } from "./tools/policy";

type AdapterModel<Adapter extends AnyTextAdapter> = Adapter["model"];
type AdapterOptions<Adapter extends AnyTextAdapter> = Adapter["~types"]["providerOptions"];

export interface ExternalHarnessAuthentication {
  readonly mode: HarnessAuthenticationMode;
  readonly secrets: Secrets;
}

export interface ExternalHarnessIdentity {
  readonly run: RunId;
  readonly session: SessionId;
  readonly resumeHandle: string | null;
}

export interface ExternalHarnessSelection {
  readonly model: string | null;
  readonly options: ModelOptionSelections;
}

export interface ExternalHarnessCheckout {
  readonly path: string;
  readonly gitWritablePaths: ReadonlyArray<string>;
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
  readonly tools: ReadonlyArray<AnyTool>;
  readonly subagents: ReadonlyArray<AvailableSubagent>;
}

export interface ExternalHarnessCapabilities {
  readonly execution: HarnessExecution;
  readonly profile: HarnessCapabilityProfile;
}

export interface ExternalHarnessTransport {
  readonly instructionProjection?: "workspace" | "system-prompt";
  /**
   * `"native"` promises the descriptor delivers `request.mcp` itself through its
   * adapter's own transport (Codex: documented `config`/`env` passthrough), so the
   * runtime keeps MCP servers and their secrets out of the Harness Workspace.
   */
  readonly mcpProjection?: "workspace" | "native";
  /**
   * Whether the runtime supplies this descriptor's File-diff feed from the checkout.
   * A transport fact, never read off the capability profile: a more honest profile
   * label must not switch the feed off.
   */
  readonly runtimeFileDiffFeed?: boolean;
}

export type ExternalHarnessUsageEstimator = (
  request: ExternalHarnessResolvedRequest,
  event: AgUiEvent,
  outputTextCharacters: number,
) => AgUiEvent;

export interface ExternalHarnessDescriptor<Adapter extends AnyTextAdapter> {
  readonly name: HarnessName;
  readonly capabilities: ExternalHarnessCapabilities;
  readonly authentication: HarnessAuthenticationBinding;
  readonly signIn?: string;
  readonly catalog: HarnessCatalogOptions;
  readonly readiness: () => Effect.Effect<HarnessReadiness, never, HarnessRunnerEnv>;
  readonly sharedGit: "none" | "required";
  readonly declaredMembers?: ReadonlyArray<Extract<RunPlanMember, "Tools" | "Skills" | "Subagents">>;
  readonly modelLevels?: ModelLevels;
  readonly inheritedEnvironment: ReadonlyArray<string>;
  readonly makeAdapter: (input: {
    readonly model: AdapterModel<Adapter>;
    readonly nativeAuthentication: "host";
    readonly request: ExternalHarnessResolvedRequest;
  }) => Adapter;
  readonly projectModel: (request: ExternalHarnessResolvedRequest) => AdapterModel<Adapter>;
  readonly projectOptions: (request: ExternalHarnessResolvedRequest) => AdapterOptions<Adapter>;
  readonly transport: ExternalHarnessTransport;
  readonly diagnostics: (cause: unknown) => HarnessError;
  readonly turnDiagnostics?: (cause: unknown) => HarnessError;
  readonly estimateUsage?: ExternalHarnessUsageEstimator;
}

type ExternalInputEffect<Value> = Effect.Effect<Value, HarnessError, HarnessRunnerEnv>;

export interface ExternalHarnessRuntimeInputs {
  readonly authentication: (request: HarnessRequest) => ExternalInputEffect<ExternalHarnessAuthentication>;
}

export const defaultInheritedEnvironment = Object.freeze([
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

export const windowsInheritedEnvironment = Object.freeze([
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "SYSTEMROOT",
  "PATHEXT",
  "COMSPEC",
]);

export const nodeNetworkInheritedEnvironment = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
]);

export const externalHarnessDeclaration = Object.freeze({
  sessionKind: "opaque-handle",
  projectedMembers: Object.freeze([
    "Harness Adapter",
    "Instructions",
    "Messages",
    "MCP",
    "Middleware",
    "Sandbox",
    "Structured Output",
    "Persistence",
    "Connections",
  ]),
  planMiddleware: Object.freeze(["sandbox"]),
} satisfies Pick<HarnessRunner, "sessionKind" | "projectedMembers" | "planMiddleware">);

const makeChatStream = <Adapter extends AnyTextAdapter>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  request: ExternalHarnessResolvedRequest,
  adapter: Adapter,
  middleware: ReadonlyArray<ChatMiddleware>,
  abortController: AbortController,
  secretValues: ReadonlyArray<string>,
) =>
  chat({
    adapter,
    messages: request.prompt.map(({ role, content }) => ({ role, content })),
    systemPrompts:
      descriptor.transport.instructionProjection === "system-prompt" ? [workspaceInstructions(request)] : [],
    middleware: [...middleware],
    abortController,
    modelOptions: descriptor.projectOptions(request),
    outputSchema: request.outputSchema ?? undefined,
    tools: request.tools,
    threadId: request.identity.session,
    runId: request.identity.run,
    stream: true,
    ...(secretValues.length > 0 ? { debug: false } : {}),
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

const childRequest = (request: ExternalHarnessResolvedRequest, model: string) =>
  ({
    ...request,
    identity: { ...request.identity, resumeHandle: null },
    selection: { model, options: model === request.selection.model ? request.selection.options : {} },
    tools: [],
    subagents: [],
  }) satisfies ExternalHarnessResolvedRequest;

const openChat = <Adapter extends AnyTextAdapter>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  request: ExternalHarnessResolvedRequest,
  provider: SandboxProvider,
  workspaceDefinition: WorkspaceDefinition,
  secretValues: ReadonlyArray<string>,
  skills: ReadonlyArray<ChatMiddleware>,
  feed: SubagentFeed,
) => {
  const model = descriptor.projectModel(request);
  const adapter = descriptor.makeAdapter({ model, nativeAuthentication: "host", request });
  const policy = policyForProfile(request.policy);
  const sandbox = defineSandbox({
    id: `cogwork-${descriptor.name}`,
    provider,
    workspace: defineWorkspace(workspaceDefinition),
    lifecycle: { reuse: "none", snapshot: "none", destroyOnComplete: true },
    policy,
    // Kept off: turning it on retains one diff promise per filesystem event for the whole Run.
    fileEvents: false,
  });
  const abortController = new AbortController();
  const sandboxed = (extra: ReadonlyArray<ChatMiddleware>) => [
    withSandbox(sandbox),
    ...extra,
    ...(writesWorkspaceFiles(workspaceDefinition) ? [] : [satisfiedProjection()]),
  ];
  const runner = modelLevelRunner(descriptor.modelLevels ?? {}, model, (childModel) => {
    const child = childRequest(request, childModel);
    return descriptor.makeAdapter({
      model: descriptor.projectModel(child),
      nativeAuthentication: "host",
      request: child,
    });
  });
  const subagents = subagentProjection(
    request.subagents,
    { runId: request.identity.run, threadId: request.identity.session, tools: request.tools },
    runner,
    { tools: [], middleware: sandboxed([]) },
    feed,
  );
  const stream = makeChatStream(
    descriptor,
    { ...request, tools: [...request.tools, ...subagents.tools] },
    adapter,
    sandboxed([...skills, ...subagents.middleware]),
    abortController,
    secretValues,
  );
  return { abortController, stream };
};

export const externalHarnessRunner = <Adapter extends AnyTextAdapter>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  inputs: ExternalHarnessRuntimeInputs,
): HarnessRunner => {
  const preflightPhase = HarnessPreflightInput.$match({
    Static: () => Effect.void,
    Launch: ({ request }) => resolveExternalLaunch(descriptor, inputs, request).pipe(Effect.asVoid),
  });
  const preflight = Effect.fn("ExternalHarnessRuntime.preflight")((input: HarnessPreflightInput) =>
    preflightPhase(input),
  );
  return {
    name: descriptor.name,
    ...externalHarnessDeclaration,
    projectedMembers: [...externalHarnessDeclaration.projectedMembers, ...(descriptor.declaredMembers ?? [])],
    execution: descriptor.capabilities.execution,
    capabilities: descriptor.capabilities.profile,
    authentication: descriptor.authentication,
    ...(descriptor.signIn ? { signIn: descriptor.signIn } : {}),
    catalog: descriptor.catalog,
    readiness: descriptor.readiness,
    validateLaunch: (request) =>
      validateCheckoutDirectory(descriptor.name, request.plan.sandbox.workspace).pipe(Effect.asVoid),
    preflight,
    run: (request) =>
      Stream.unwrap(
        resolveExternalLaunch(descriptor, inputs, request).pipe(
          Effect.flatMap((launch) =>
            Effect.map(
              Effect.all({ skills: projectedSkills(descriptor, request), feed: makeSubagentFeed }),
              (projected) => ({ ...launch, ...projected }),
            ),
          ),
          Effect.flatMap(({ resolved, provider, workspaceDefinition, secretValues, skills, feed }) =>
            Effect.try({
              try: () =>
                openChat(descriptor, resolved, provider, workspaceDefinition, secretValues, skills, feed),
              catch: descriptor.diagnostics,
            }).pipe(
              Effect.mapError((error) => scrubHarnessError(error, secretValues)),
              Effect.flatMap((opened) => {
                const harnessEvents = withUsage(
                  resolved,
                  descriptor.estimateUsage ?? preserveUsage,
                  mergeSubagentFeed(
                    bridgeChat(
                      abortOnReturn(opened.stream, opened.abortController),
                      descriptor.turnDiagnostics ?? descriptor.diagnostics,
                      descriptor.turnDiagnostics ?? descriptor.diagnostics,
                    ),
                    feed,
                  ).pipe(
                    Stream.map((event) => normalizeFileEvent(event, resolved.checkout.path)),
                    Stream.filter(publicFileEvent),
                    Stream.map((event) => scrubEvent(event, secretValues)),
                    Stream.mapError((error) => scrubHarnessError(error, secretValues)),
                    Stream.ensuring(Effect.sync(() => opened.abortController.abort())),
                  ),
                );
                return descriptor.transport.runtimeFileDiffFeed
                  ? mergeCheckoutFileDiffs(harnessEvents, (stop) =>
                      checkoutFileDiffs(resolved.checkout.path, secretValues, stop),
                    )
                  : Effect.succeed(harnessEvents);
              }),
            ),
          ),
          Effect.withSpan("ExternalHarnessRuntime.run"),
        ),
      ),
  };
};
