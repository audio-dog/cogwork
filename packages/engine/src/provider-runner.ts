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
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  type AssembleRequest,
  ContextAssembler,
  type ContextAssemblerService,
  type InstructionLayer,
} from "./context-assembler";
import { CredentialStore } from "./credential-store";
import {
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
  profileForStage,
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
  readonly watchDiffs?: typeof watchWorktreeDiffs;
}

// Read-only stages get fewer turns than the writing stages.
export const defaultLoopBudget = (stage: LifecycleStage) =>
  stage === "triage" || stage === "verify" ? 12 : 40;

const launchError = (retryable: boolean, message: string) =>
  new HarnessError({ reason: "launch", retryable, message });

// Falls back to the run-start layers when a refresh fails, so a broken read never
// strips context mid-run.
export const resolveContextLayers = (
  assembler: ContextAssemblerService,
  request: AssembleRequest,
  fallback: ReadonlyArray<InstructionLayer>,
) =>
  Effect.runPromise(Effect.result(assembler.assemble(request))).then((assembled) =>
    Result.match(assembled, { onFailure: () => fallback, onSuccess: (value) => value.layers }),
  );

// Runs on every turn so a mid-run edit to an AGENTS.md reaches the next prompt.
const contextMiddleware = (
  assembler: ContextAssemblerService,
  request: AssembleRequest,
  fallback: ReadonlyArray<InstructionLayer>,
): ChatMiddleware => ({
  name: "cogwork-context",
  onConfig: (_ctx, config) =>
    resolveContextLayers(assembler, request, fallback).then((layers) => ({
      systemPrompts: [...config.systemPrompts, ...layers.map((layer) => layer.content)],
    })),
});

export const providerRunner = (options: ProviderRunnerOptions): HarnessRunner => {
  const defaultModel = options.defaultModel ?? "anthropic/claude-sonnet-4-5";
  const makeAdapter = options.makeAdapter ?? defaultModelAdapterFactory;
  const runChat = options.runChat ?? defaultRunChat;
  const watchDiffs = options.watchDiffs ?? watchWorktreeDiffs;

  return {
    name: options.name,
    sessionKind: "owned-transcript",
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
          const toolSet = makeOwnedToolSet(sandbox, profileForStage(request.stage));

          const abortController = new AbortController();
          const chatStream = runChat({
            adapter,
            messages,
            tools: Object.values(toolSet),
            middleware: [
              withPersistence(store.persistence),
              contextMiddleware(assembler, assembleRequest, assembled.layers),
            ],
            agentLoopStrategy: maxIterations(defaultLoopBudget(request.stage)),
            abortController,
            threadId: session ?? undefined,
            outputSchema: stageResultSchema(request.stage),
          });

          const diffs = watchDiffs(sandbox, baseSha).pipe(Stream.catchCause(() => Stream.empty));
          return Stream.merge(bridgeChat(chatStream), diffs, { haltStrategy: "left" }).pipe(
            Stream.ensuring(Effect.sync(() => abortController.abort())),
          );
        }),
      ),
  };
};
