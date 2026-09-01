import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { TokenUsage } from "./run";

const anyExtraKeys = Schema.Record(Schema.String, Schema.Unknown);

const AgUiUsage = Schema.StructWithRest(
  Schema.Struct({
    promptTokens: Schema.optional(Schema.Finite),
    completionTokens: Schema.optional(Schema.Finite),
    totalTokens: Schema.optional(Schema.Finite),
    estimated: Schema.optional(Schema.Boolean),
  }),
  [anyExtraKeys],
);

const eventVariant = <const Type extends string, const Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.StructWithRest(Schema.Struct({ type: Schema.tag(type), ...fields }), [anyExtraKeys]);

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

const AgUiNamedEvent = Schema.Union([
  eventVariant("RUN_STARTED", {
    threadId: Schema.optional(Schema.String),
  }),
  eventVariant("TEXT_MESSAGE_START", {
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("TEXT_MESSAGE_CONTENT", {
    delta: Schema.optional(Schema.String),
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("TEXT_MESSAGE_END", {
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("REASONING_MESSAGE_CONTENT", {
    delta: Schema.optional(Schema.String),
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("TOOL_CALL_START", {
    toolCallId: Schema.optional(Schema.String),
    toolCallName: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
  }),
  eventVariant("TOOL_CALL_ARGS", {
    toolCallId: Schema.optional(Schema.String),
    delta: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
  }),
  eventVariant("TOOL_CALL_END", {
    toolCallId: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
    result: Schema.optional(Schema.Unknown),
  }),
  eventVariant("TOOL_CALL_RESULT", {
    toolCallId: Schema.optional(Schema.String),
    content: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
  }),
  eventVariant("CUSTOM", {
    name: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
  }),
  eventVariant("STEP_STARTED", {
    stepName: Schema.optional(Schema.String),
  }),
  eventVariant("STEP_FINISHED", {
    stepName: Schema.optional(Schema.String),
  }),
  eventVariant("RUN_FINISHED", {
    finishReason: Schema.optional(Schema.NullOr(Schema.String)),
    threadId: Schema.optional(Schema.String),
    usage: Schema.optional(AgUiUsage),
  }),
  eventVariant("RUN_ERROR", {
    message: Schema.optional(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("type"));

const agUiNamedEventTypes = new Set<PropertyKey>(AgUiNamedEvent.discriminants);

const AgUiUnknownEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String.check(
      Schema.makeFilter((type) =>
        agUiNamedEventTypes.has(type) ? "Expected an unnamed harness event type" : undefined,
      ),
    ),
  }),
  [anyExtraKeys],
);

const AgUiEventUnionSchema = Schema.Union([AgUiNamedEvent, AgUiUnknownEvent]);
type AgUiEventUnionSchema = typeof AgUiEventUnionSchema.Type;
type AgUiNamedEvent = typeof AgUiNamedEvent.Type;
type AgUiEventCases<Output> = {
  readonly [Type in AgUiNamedEvent["type"]]?: (
    event: Extract<AgUiNamedEvent, { readonly type: Type }>,
  ) => Output;
};

const isAgUiNamedEvent = (event: AgUiEventUnionSchema): event is AgUiNamedEvent =>
  agUiNamedEventTypes.has(event.type);

const matchOrElse = <Output>(
  event: AgUiEventUnionSchema,
  cases: AgUiEventCases<Output>,
  orElse: (event: AgUiEventUnionSchema) => Output,
) => {
  if (!isAgUiNamedEvent(event)) return orElse(event);
  return AgUiNamedEvent.matchOrElse(event, cases, orElse);
};

export const AgUiEventUnion = Object.assign(AgUiEventUnionSchema, {
  guards: AgUiNamedEvent.guards,
  match: AgUiNamedEvent.match,
  matchOrElse,
});
export type AgUiEventUnion = typeof AgUiEventUnion.Type;

export const StructuredOutputCompleteValue = Schema.Struct({
  object: Schema.Unknown,
  raw: Schema.String,
});
export type StructuredOutputCompleteValue = typeof StructuredOutputCompleteValue.Type;

const decodeStructuredOutputCompleteValue = Schema.decodeUnknownOption(StructuredOutputCompleteValue);

export const agUiIsStructuredOutputComplete = (event: AgUiEvent) =>
  AgUiEventUnion.guards.CUSTOM(event) && event.name === "structured-output.complete";

export const agUiStructuredOutputComplete = (event: AgUiEvent) => {
  if (!agUiIsStructuredOutputComplete(event)) return null;
  return Option.getOrNull(decodeStructuredOutputCompleteValue(event.value));
};

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

const SessionIdValue = Schema.StructWithRest(Schema.Struct({ sessionId: Schema.String }), [anyExtraKeys]);

const AgUiSessionIdEvent = eventVariant("CUSTOM", {
  name: Schema.String.check(Schema.isPattern(/\.session-id$/)),
  value: SessionIdValue,
});

const isAgUiSessionIdEvent = Schema.is(AgUiSessionIdEvent);

export const agUiIsTerminal = (event: AgUiEvent) =>
  AgUiEventUnion.guards.RUN_FINISHED(event) || AgUiEventUnion.guards.RUN_ERROR(event);

export const agUiTextDelta = (event: AgUiEvent) =>
  AgUiEventUnion.guards.TEXT_MESSAGE_CONTENT(event) ? (event.delta ?? "") : "";

export const agUiSessionId = (event: AgUiEvent) => {
  if (!isAgUiSessionIdEvent(event)) return null;
  return event.value.sessionId;
};

export const agUiUsage = (event: AgUiEvent): TokenUsage | null => {
  if (!AgUiEventUnion.guards.RUN_FINISHED(event) || !event.usage) return null;
  return {
    inputTokens: event.usage.promptTokens,
    outputTokens: event.usage.completionTokens,
    totalTokens: event.usage.totalTokens,
    ...(event.usage.estimated ? { estimated: true } : {}),
  };
};

export const agUiDisplayName = (event: AgUiEvent) =>
  event.toolCallName ?? event.name ?? event.stepName ?? null;
