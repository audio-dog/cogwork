import type { HarnessName, TokenUsage } from "@clanker-forge/contracts";
import { Harness } from "@clanker-forge/engine";
import { chat, EventType, type StreamChunk } from "@tanstack/ai";
import { acpCompatible } from "@tanstack/ai-acp";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CursorRunnerOptions {
  readonly name: HarnessName;
  readonly agentBin?: string;
  readonly defaultModel?: string;
  readonly scrubEnv?: ReadonlyArray<string>;
  readonly authMethodId?: string;
}

const sessionIdOf = (chunk: StreamChunk) =>
  chunk.type === EventType.CUSTOM && chunk.name.endsWith(".session-id")
    ? ((chunk.value as { readonly sessionId?: string }).sessionId ?? null)
    : null;

const usageOf = (chunk: StreamChunk): TokenUsage | null => {
  if (chunk.type !== EventType.RUN_FINISHED || !chunk.usage) return null;
  return {
    inputTokens: chunk.usage.promptTokens,
    outputTokens: chunk.usage.completionTokens,
    totalTokens: chunk.usage.totalTokens,
  };
};

const nameOf = (chunk: StreamChunk) => {
  if (chunk.type === EventType.CUSTOM) return chunk.name;
  if (chunk.type === EventType.TOOL_CALL_START) return chunk.toolCallName;
  return null;
};

const toEvent = (chunk: StreamChunk): Harness.HarnessEvent => ({
  type: chunk.type,
  name: nameOf(chunk),
  text: chunk.type === EventType.TEXT_MESSAGE_CONTENT ? (chunk.delta ?? null) : null,
  sessionId: sessionIdOf(chunk),
  usage: usageOf(chunk),
  finishReason: chunk.type === EventType.RUN_FINISHED ? (chunk.finishReason ?? null) : null,
});

const launchPattern = /ENOENT|EACCES|spawn|not found|command not found/i;

const fromThrown = (error: unknown): Harness.HarnessError => {
  const message = error instanceof Error ? error.message : String(error);
  const launch = launchPattern.test(message);
  return new Harness.HarnessError({ reason: launch ? "launch" : "turn", retryable: !launch, message });
};

const fromRunError = (chunk: Extract<StreamChunk, { type: EventType.RUN_ERROR }>): Harness.HarnessError =>
  new Harness.HarnessError({ reason: "turn", retryable: true, message: chunk.message });

const bridge = (stream: AsyncIterable<StreamChunk>) =>
  Stream.fromAsyncIterable(stream, fromThrown).pipe(
    Stream.flatMap((chunk) =>
      chunk.type === EventType.RUN_ERROR ? Stream.fail(fromRunError(chunk)) : Stream.succeed(toEvent(chunk)),
    ),
  );

export const cursorRunner = (options: CursorRunnerOptions): Harness.HarnessRunner => {
  const agentBin = options.agentBin ?? "agent";
  const defaultModel = options.defaultModel ?? "auto";
  const scrubEnv = [...(options.scrubEnv ?? ["GITHUB_TOKEN", "GH_TOKEN"])];
  const authMethodId = options.authMethodId ?? "cursor_login";
  return {
    name: options.name,
    run: (request) =>
      Stream.unwrap(
        Effect.sync(() => {
          const model = request.model ?? defaultModel;
          const adapter = acpCompatible({
            name: options.name,
            models: [model],
            command: ({ model: selected }) => `${agentBin} --model ${selected} acp`,
            planEventName: `${options.name}.plan`,
            authMethodId,
          });
          const sandbox = defineSandbox({
            id: `clanker-forge-${options.name}`,
            provider: localProcessSandbox({ dir: request.checkoutPath, scrubEnv }),
            workspace: defineWorkspace({ source: { type: "none" } }),
          });
          const stream = chat({
            adapter: adapter(model),
            messages: [{ role: "user", content: request.prompt }],
            middleware: [withSandbox(sandbox)],
            ...(request.sessionId ? { modelOptions: { sessionId: request.sessionId } } : {}),
          });
          return bridge(stream);
        }),
      ),
  };
};
