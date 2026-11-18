import type {
  AgUiEvent,
  HarnessName,
  RunId,
  RunPlan,
  RunPlanPolicyProfile,
  SessionId,
} from "@cogwork/contracts";
import {
  type AgentLoopStrategy,
  type AnyTool,
  type ChatMiddleware,
  chat,
  type JSONSchema,
  type ModelMessage,
  maxIterations,
  type StreamChunk,
} from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import { withPersistence } from "@tanstack/ai-persistence";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as HttpClient from "effect/http/HttpClient";
import * as Stream from "effect/Stream";
import { CredentialStore } from "./credential-store";
import {
  fullHarnessExecution,
  HarnessError,
  type HarnessPreflightInput,
  type HarnessRunner,
  selectionOfPreflightInput,
} from "./harness";
import { defaultModelAdapterFactory, type ModelAdapterFactory, providerModelRefs } from "./provider-adapter";
import { bridgeChat } from "./provider-bridge";
import { resolveModelAdapter } from "./provider-resolve";
import { workContextMessage } from "./run-plan";
import { runPlanSkillsMiddleware } from "./run-plan-skill-source";
import { SessionStore } from "./session-store";
import {
  makeOwnedToolSet,
  mergeFileDiffFeed,
  openWorktreeSandbox,
  policyForProfile,
  resolveBaseSha,
  watchWorktreeDiffs,
} from "./tools";

export interface RunChatOptions {
  readonly adapter: AnyTextAdapter;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly tools: ReadonlyArray<AnyTool>;
  readonly middleware: ReadonlyArray<ChatMiddleware>;
  readonly agentLoopStrategy: AgentLoopStrategy;
  readonly abortController: AbortController;
  readonly runId: RunId;
  readonly threadId: SessionId;
  readonly outputSchema?: JSONSchema;
}

export type RunChat = (options: RunChatOptions) => AsyncIterable<StreamChunk>;

export const mergeProviderFileDiffs = <E, R>(
  harnessEvents: Stream.Stream<AgUiEvent, HarnessError>,
  fileDiffs: (stop: Effect.Effect<void>) => Stream.Stream<AgUiEvent, E, R>,
) => mergeFileDiffFeed(harnessEvents, fileDiffs, "worktree diff feed stopped");

const defaultRunChat: RunChat = (options) =>
  chat({
    adapter: options.adapter,
    messages: [...options.messages],
    tools: [...options.tools],
    middleware: [...options.middleware],
    agentLoopStrategy: options.agentLoopStrategy,
    abortController: options.abortController,
    runId: options.runId,
    threadId: options.threadId,
    outputSchema: options.outputSchema,
    stream: true,
  });

export interface ProviderRunnerOptions {
  readonly name: HarnessName;
  readonly defaultModel?: string;
  readonly makeAdapter?: ModelAdapterFactory;
  readonly runChat?: RunChat;
}

const loopBudgets = {
  "read-only": 12,
  full: 40,
} satisfies Record<RunPlanPolicyProfile, number>;

const runBudgets = {
  "read-only": "15 minutes",
  full: "2 hours",
} satisfies Record<RunPlanPolicyProfile, Duration.Input>;

export const defaultLoopBudget = (profile: RunPlanPolicyProfile) => loopBudgets[profile];

export const defaultRunBudget = (profile: RunPlanPolicyProfile) => runBudgets[profile];

const launchError = (retryable: boolean, message: string) =>
  new HarnessError({ reason: "launch", retryable, message });

const requireSession = (session: SessionId | null) =>
  session
    ? Effect.succeed(session)
    : Effect.fail(launchError(false, "provider Harness launch requires a Cogwork Session"));

const contextMiddleware = (instructions: ReadonlyArray<{ readonly content: string }>): ChatMiddleware => ({
  name: "cogwork-context",
  onConfig: (_ctx, config) => ({
    systemPrompts: [...config.systemPrompts, ...instructions.map((instruction) => instruction.content)],
  }),
});

const providerMiddleware = (
  name: string,
  persistence: ChatMiddleware,
  instructions: ReadonlyArray<{ readonly content: string }>,
): ReadonlyArray<ChatMiddleware> => {
  if (name === "persistence") return [persistence];
  if (name === "instruction-context") return [contextMiddleware(instructions)];
  return [];
};

export const providerInstructionContext = (plan: Pick<RunPlan, "instructions" | "operatingInstructions">) => [
  ...plan.instructions,
  ...plan.operatingInstructions.resources,
];

export const providerRunner = (options: ProviderRunnerOptions): HarnessRunner => {
  const defaultModel = options.defaultModel ?? "anthropic/claude-sonnet-4-5";
  const makeAdapter = options.makeAdapter ?? defaultModelAdapterFactory;
  const runChat = options.runChat ?? defaultRunChat;
  const preflight = Effect.fn("ProviderRunner.preflight")(function* (input: HarnessPreflightInput) {
    const credentials = yield* CredentialStore;
    yield* resolveModelAdapter(
      credentials,
      selectionOfPreflightInput(input).model ?? defaultModel,
      makeAdapter,
    );
  });

  return {
    name: options.name,
    sessionKind: "owned-transcript",
    projectedMembers: [
      "Harness Adapter",
      "Instructions",
      "Messages",
      "Tools",
      "Skills",
      "Middleware",
      "Sandbox",
      "Structured Output",
      "Persistence",
    ],
    planMiddleware: ["persistence", "instruction-context"],
    execution: fullHarnessExecution,
    capabilities: {
      authenticationModes: ["byok"],
      session: { affinity: "portable", fork: false, humanAttach: false },
      structuredOutput: "native",
      policyFidelity: "exact",
      fileEventFidelity: "best-effort",
      usageQuality: "metered",
      readinessDiagnostics: true,
      journal: false,
      takeover: false,
    },
    authentication: { mode: "byok", reference: "Cogwork provider key" },
    signIn: "cogwork login key --provider anthropic",
    catalog: {
      models: providerModelRefs.map((model) => ({ value: model, label: model })),
    },
    readiness: Effect.fn("ProviderRunner.readiness")(() =>
      Effect.succeed({
        operational: { status: "ready", retryable: false, diagnostic: "Provider runner is ready" },
        installation: { status: "installed", version: "built-in" },
        compatibility: { status: "compatible", requirement: "bundled" },
        authentication: {
          mode: "byok",
          status: "unknown",
          diagnostic: "Provider-key availability is verified for the selected model during preflight",
        },
        diagnostics: [],
      }),
    ),
    preflight: (input) =>
      preflight(input).pipe(
        Effect.mapError(
          (error) =>
            new HarnessError({
              reason: error.reason === "no-key" ? "credential" : "policy",
              retryable: false,
              message: error.message,
            }),
        ),
      ),
    run: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const plan = request.plan;
          const reference = plan.harness.model ?? defaultModel;
          const credentials = yield* CredentialStore;
          const adapter = yield* resolveModelAdapter(credentials, reference, makeAdapter).pipe(
            Effect.mapError((error) => launchError(false, error.message)),
          );

          const store = yield* SessionStore;
          const session = yield* requireSession(request.session);
          const history = yield* Effect.promise(() => store.persistence.stores.messages.loadThread(session));
          const messages: ReadonlyArray<ModelMessage> = [
            ...history,
            workContextMessage(plan.workContext),
            ...plan.messages.map(({ role, content }) => ({ role, content })),
          ];

          const sandbox = yield* openWorktreeSandbox(plan.sandbox.workspace).pipe(
            Effect.mapError((error) => launchError(true, error.message)),
          );
          const baseSha = yield* resolveBaseSha(sandbox).pipe(
            Effect.mapError((error) => launchError(true, error.message)),
          );
          const runPromise = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>();
          const toolSet = makeOwnedToolSet(sandbox, runPromise, policyForProfile(plan.harness.profile));
          const toolsByName: ReadonlyMap<string, AnyTool> = new Map(Object.entries(toolSet));
          const tools = plan.tools.flatMap((name) => {
            const tool = toolsByName.get(name);
            return tool ? [tool] : [];
          });
          const engineTools = request.engineTools?.filter(({ name }) => plan.tools.includes(name)) ?? [];
          const persistence = withPersistence(store.persistence);
          const instructions = providerInstructionContext(plan);
          const skills = yield* runPlanSkillsMiddleware(plan.skills);
          const middleware = [
            ...plan.middleware.flatMap((name) => providerMiddleware(name, persistence, instructions)),
            ...skills,
          ];

          const abortController = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          const chatStream = runChat({
            adapter,
            messages,
            tools: [...tools, ...engineTools],
            middleware,
            agentLoopStrategy: maxIterations(defaultLoopBudget(plan.harness.profile)),
            abortController,
            runId: plan.id,
            threadId: session,
            outputSchema: plan.structuredOutput ?? undefined,
          });

          return yield* mergeProviderFileDiffs(bridgeChat(chatStream), (stop) =>
            watchWorktreeDiffs(sandbox, baseSha, stop),
          );
        }),
      ),
  };
};
