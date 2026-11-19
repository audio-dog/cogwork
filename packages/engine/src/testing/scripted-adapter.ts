import { EventType, type StreamChunk, type TextOptions } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";

export interface SubagentCall {
  readonly id: string;
  readonly agent: string;
  readonly task: string;
}

const toAsyncIterable = <Value>(values: ReadonlyArray<Value>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = values[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  },
});

const usage = (tokens: number) => ({
  promptTokens: tokens,
  completionTokens: tokens,
  totalTokens: 2 * tokens,
});

export const textTurn = (text: string, tokens: number): ReadonlyArray<StreamChunk> => [
  { type: EventType.RUN_STARTED, runId: "scripted", threadId: "scripted" },
  { type: EventType.TEXT_MESSAGE_START, messageId: `text-${text}`, role: "assistant" },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: `text-${text}`, delta: text },
  { type: EventType.TEXT_MESSAGE_END, messageId: `text-${text}` },
  {
    type: EventType.RUN_FINISHED,
    runId: "scripted",
    threadId: "scripted",
    finishReason: "stop",
    usage: usage(tokens),
  },
];

export const subagentCallTurn = (
  calls: ReadonlyArray<SubagentCall>,
  tokens: number,
): ReadonlyArray<StreamChunk> => [
  { type: EventType.RUN_STARTED, runId: "scripted", threadId: "scripted" },
  ...calls.flatMap(
    ({ id, agent, task }): ReadonlyArray<StreamChunk> => [
      { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: agent },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify({ task }) },
      { type: EventType.TOOL_CALL_END, toolCallId: id },
    ],
  ),
  {
    type: EventType.RUN_FINISHED,
    runId: "scripted",
    threadId: "scripted",
    finishReason: "tool_calls",
    usage: usage(tokens),
  },
];

export const hasToolResults = (options: TextOptions) => options.messages.some(({ role }) => role === "tool");

export const scriptedAdapter = (
  model: string,
  turn: (options: TextOptions) => ReadonlyArray<StreamChunk>,
  calls: Array<TextOptions> = [],
) =>
  ({
    kind: "text",
    name: "scripted",
    model,
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: undefined,
      systemPromptMetadata: undefined,
    },
    chatStream: (options: TextOptions) => {
      calls.push(options);
      return toAsyncIterable(turn(options));
    },
    structuredOutput: () => Promise.reject(new Error("unexpected structured output")),
    supportsCombinedToolsAndSchema: () => true,
  }) satisfies AnyTextAdapter;
