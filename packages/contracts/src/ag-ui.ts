import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { TokenUsage } from "./run";

const anyExtraKeys = Schema.Record(Schema.String, Schema.Unknown);

const AgUiUsage = Schema.StructWithRest(
  Schema.Struct({
    promptTokens: Schema.optional(Schema.Finite),
    completionTokens: Schema.optional(Schema.Finite),
    totalTokens: Schema.optional(Schema.Finite),
  }),
  [anyExtraKeys],
);

export const AgUiEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    delta: Schema.optional(Schema.String),
    toolCallId: Schema.optional(Schema.String),
    toolCallName: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
    result: Schema.optional(Schema.Unknown),
    content: Schema.optional(Schema.Unknown),
    name: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.String),
    stepName: Schema.optional(Schema.String),
    messageId: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
    finishReason: Schema.optional(Schema.NullOr(Schema.String)),
    usage: Schema.optional(AgUiUsage),
  }),
  [anyExtraKeys],
);
export type AgUiEvent = typeof AgUiEvent.Type;

export const AgUiCorrelation = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
  toolCallId: Schema.NullOr(Schema.String),
});
export type AgUiCorrelation = typeof AgUiCorrelation.Type;

export const agUiCorrelation = (event: AgUiEvent) => ({
  threadId: event.threadId ?? null,
  messageId: event.messageId ?? null,
  toolCallId: event.toolCallId ?? null,
});

const SessionIdValue = Schema.Struct({ sessionId: Schema.String });
const decodeSessionIdValue = Schema.decodeUnknownOption(SessionIdValue);

const terminalTypes = new Set(["RUN_FINISHED", "RUN_ERROR"]);

export const agUiIsTerminal = (event: AgUiEvent) => terminalTypes.has(event.type);

export const agUiTextDelta = (event: AgUiEvent) =>
  event.type === "TEXT_MESSAGE_CONTENT" ? (event.delta ?? "") : "";

export const agUiSessionId = (event: AgUiEvent) => {
  if (event.type !== "CUSTOM" || !event.name?.endsWith(".session-id")) return null;
  return Option.getOrNull(Option.map(decodeSessionIdValue(event.value), (v) => v.sessionId));
};

export const agUiUsage = (event: AgUiEvent): TokenUsage | null => {
  if (event.type !== "RUN_FINISHED" || !event.usage) return null;
  return {
    inputTokens: event.usage.promptTokens,
    outputTokens: event.usage.completionTokens,
    totalTokens: event.usage.totalTokens,
  };
};

export const agUiDisplayName = (event: AgUiEvent) =>
  event.toolCallName ?? event.name ?? event.stepName ?? null;
