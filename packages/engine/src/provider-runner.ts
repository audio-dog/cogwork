import type { HarnessName, LifecycleStage, RunPlan } from "@cogwork/contracts";
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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CredentialStore } from "./credential-store";
import { fullHarnessExecution, HarnessError, type HarnessRunner } from "./harness";
import { defaultModelAdapterFactory, type ModelAdapterFactory } from "./provider-adapter";
import { bridgeChat } from "./provider-bridge";
import { resolveModelAdapter } from "./provider-resolve";
import { SessionStore } from "./session-store";
import {
  makeOwnedToolSet,
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
  readonly threadId?: string;
  readonly outputSchema?: JSONSchema;
}

export type RunChat = (options: RunChatOptions) => AsyncIterable<StreamChunk>;

const defaultRunChat: RunChat = (options) =>
  chat({
    adapter: options.adapter,
    messages: [...options.messages],
    tools: [...options.tools],
    middleware: [...options.middleware],
    agentLoopStrategy: options.agentLoopStrategy,
    abortController: options.abortController,
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

const isReadOnlyStage = (stage: LifecycleStage) => stage === "triage" || stage === "verify";
const readOnlyLoopBudget = 12;
const writingLoopBudget = 40;
const readOnlyRunBudget = "15 minutes";
const writingRunBudget = "2 hours";

export const defaultLoopBudget = (stage: LifecycleStage) =>
  isReadOnlyStage(stage) ? readOnlyLoopBudget : writingLoopBudget;

export const defaultRunBudget = (stage: LifecycleStage) =>
  isReadOnlyStage(stage) ? readOnlyRunBudget : writingRunBudget;

const launchError = (retryable: boolean, message: string) =>
  new HarnessError({ reason: "launch", retryable, message });

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
  const preflight = Effect.fn("ProviderRunner.preflight")(function* (model: string | null) {
    const credentials = yield* CredentialStore;
    yield* resolveModelAdapter(credentials, model ?? defaultModel, makeAdapter);
  });

  return {
    name: options.name,
    sessionKind: "owned-transcript",
    projectedMembers: [
      "Harness Adapter",
      "Instructions",
      "Messages",
      "Tools",
      "Middleware",
      "Sandbox",
      "Structured Output",
      "Persistence",
    ],
    planMiddleware: ["persistence", "instruction-context"],
    execution: fullHarnessExecution,
    preflight: (model) =>
      preflight(model).pipe(
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
          const session = request.session;
          const history = session
            ? yield* Effect.promise(() => store.persistence.stores.messages.loadThread(session))
            : [];
          const messages: ReadonlyArray<ModelMessage> = [
            ...history,
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
          const persistence = withPersistence(store.persistence);
          const instructions = providerInstructionContext(plan);
          const middleware = plan.middleware.flatMap((name) =>
            providerMiddleware(name, persistence, instructions),
          );

          const abortController = new AbortController();
          const chatStream = runChat({
            adapter,
            messages,
            tools,
            middleware,
            agentLoopStrategy: maxIterations(defaultLoopBudget(plan.operation)),
            abortController,
            threadId: session ?? undefined,
            outputSchema: plan.structuredOutput ?? undefined,
          });

          // Live diffs are a nicety: a dead feed must not end the run, but it
          // must leave a trace — on Linux a large ignored tree can exhaust
          // inotify watches, and recursive watching cannot exclude subtrees.
          return Stream.merge(
            bridgeChat(chatStream),
            watchWorktreeDiffs(sandbox, baseSha).pipe(
              Stream.catchCause((cause) =>
                // Interruption is the merge tearing the feed down, not a death.
                Cause.hasInterruptsOnly(cause)
                  ? Stream.empty
                  : Stream.fromEffect(Effect.logWarning("worktree diff feed stopped", { cause })).pipe(
                      Stream.drain,
                    ),
              ),
            ),
            { haltStrategy: "left" },
          ).pipe(Stream.ensuring(Effect.sync(() => abortController.abort())));
        }),
      ),
  };
};
