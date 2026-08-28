import type { HarnessName, LifecycleStage } from "@cogwork/contracts";
import {
  type AgentLoopStrategy,
  type AnyTool,
  type ChatMiddleware,
  chat,
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
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  type AssembleRequest,
  ContextAssembler,
  type ContextAssemblerService,
  type InstructionLayer,
} from "./context-assembler";
import { CredentialStore } from "./credential-store";
import {
  fullHarnessExecution,
  HarnessError,
  type HarnessRequest,
  type HarnessRunner,
  type StageResultSchema,
  stageResultSchema,
} from "./harness";
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
  readonly outputSchema?: StageResultSchema;
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

// Falls back to the run-start layers when a refresh fails, so a broken read never
// strips context mid-run.
export const resolveContextLayers = Effect.fn("ProviderRunner.resolveContextLayers")(
  (assembler: ContextAssemblerService, request: AssembleRequest, fallback: ReadonlyArray<InstructionLayer>) =>
    assembler
      .assemble(request)
      .pipe(Effect.match({ onFailure: () => fallback, onSuccess: (value) => value.layers })),
);

// Runs on every turn so a mid-run edit to an AGENTS.md reaches the next prompt.
const contextMiddleware = (
  runPromise: Effect.Success<ReturnType<typeof FiberSet.makeRuntimePromise<HttpClient.HttpClient>>>,
  assembler: ContextAssemblerService,
  request: AssembleRequest,
  fallback: ReadonlyArray<InstructionLayer>,
): ChatMiddleware => ({
  name: "cogwork-context",
  onConfig: (_ctx, config) =>
    runPromise(resolveContextLayers(assembler, request, fallback)).then((layers) => ({
      systemPrompts: [...config.systemPrompts, ...layers.map((layer) => layer.content)],
    })),
});

export const providerRunner = (options: ProviderRunnerOptions): HarnessRunner => {
  const defaultModel = options.defaultModel ?? "anthropic/claude-sonnet-4-5";
  const makeAdapter = options.makeAdapter ?? defaultModelAdapterFactory;
  const runChat = options.runChat ?? defaultRunChat;

  return {
    name: options.name,
    sessionKind: "owned-transcript",
    execution: fullHarnessExecution,
    run: (request: HarnessRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const reference = request.model ?? defaultModel;
          const credentials = yield* CredentialStore;
          const adapter = yield* resolveModelAdapter(credentials, reference, makeAdapter).pipe(
            Effect.mapError((error) => launchError(false, error.message)),
          );

          const assembler = yield* ContextAssembler;
          const assembleRequest: AssembleRequest = {
            cwd: request.checkoutPath,
            projectRoot: request.checkoutPath,
            skill: request.skill,
            contributions: request.contributions,
          };
          const assembled = yield* assembler
            .assemble(assembleRequest)
            .pipe(Effect.mapError((error) => launchError(false, error.message)));
          const store = yield* SessionStore;
          const session = request.session;
          // History comes from the ledger-backed message store; the new prompt
          // is this run's only fresh turn. We pass the full list so the middleware
          // uses it verbatim rather than reloading — the ledger stays the truth.
          const history = session
            ? yield* Effect.promise(() => store.persistence.stores.messages.loadThread(session))
            : [];
          const messages: ReadonlyArray<ModelMessage> = [
            ...history,
            { role: "user", content: request.prompt },
          ];

          const sandbox = yield* openWorktreeSandbox(request.checkoutPath).pipe(
            Effect.mapError((error) => launchError(true, error.message)),
          );
          const baseSha = yield* resolveBaseSha(sandbox);
          const runPromise = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>().pipe(
            Effect.provide(FetchHttpClient.layer),
          );
          const toolSet = makeOwnedToolSet(sandbox, runPromise, policyForProfile(request.profile));

          const abortController = new AbortController();
          const chatStream = runChat({
            adapter,
            messages,
            tools: Object.values(toolSet),
            middleware: [
              withPersistence(store.persistence),
              contextMiddleware(runPromise, assembler, assembleRequest, assembled.layers),
            ],
            agentLoopStrategy: maxIterations(defaultLoopBudget(request.stage)),
            abortController,
            threadId: session ?? undefined,
            outputSchema: stageResultSchema(request.stage),
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
