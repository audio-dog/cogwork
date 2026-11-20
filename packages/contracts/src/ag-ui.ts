import * as Schema from "effect/Schema";

import type { TokenUsage } from "./run";

export const FILE_DIFF_EVENT = "sandbox.file.diff";
export const FILE_DIFF_UNAVAILABLE_EVENT = "sandbox.file.diff.unavailable";

const anyExtraKeys = Schema.Record(Schema.String, Schema.Unknown);
const SessionHandleValue = Schema.Struct({ sessionId: Schema.String });
const SessionHandleEventName = Schema.TemplateLiteral([Schema.String, ".session-id"]);

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

const subagentRunId = Schema.optional(Schema.String);

const AgUiNamedEvent = Schema.Union([
  eventVariant("RUN_STARTED", {
    threadId: Schema.optional(Schema.String),
  }),
  eventVariant("TEXT_MESSAGE_START", {
    subagentRunId,
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("TEXT_MESSAGE_CONTENT", {
    subagentRunId,
    delta: Schema.optional(Schema.String),
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("TEXT_MESSAGE_END", {
    subagentRunId,
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("REASONING_MESSAGE_CONTENT", {
    subagentRunId,
    delta: Schema.optional(Schema.String),
    messageId: Schema.optional(Schema.String),
  }),
  eventVariant("TOOL_CALL_START", {
    subagentRunId,
    toolCallId: Schema.optional(Schema.String),
    toolCallName: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
  }),
  eventVariant("TOOL_CALL_ARGS", {
    subagentRunId,
    toolCallId: Schema.optional(Schema.String),
    toolCallName: Schema.optional(Schema.String),
    delta: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
  }),
  eventVariant("TOOL_CALL_END", {
    subagentRunId,
    toolCallId: Schema.optional(Schema.String),
    toolCallName: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
    result: Schema.optional(Schema.Unknown),
  }),
  eventVariant("TOOL_CALL_RESULT", {
    subagentRunId,
    toolCallId: Schema.optional(Schema.String),
    toolCallName: Schema.optional(Schema.String),
    content: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
  }),
  eventVariant("CUSTOM", {
    subagentRunId,
    name: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
  }),
  eventVariant("STEP_STARTED", {
    subagentRunId,
    stepName: Schema.optional(Schema.String),
  }),
  eventVariant("STEP_FINISHED", {
    subagentRunId,
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
  eventVariant("SUBAGENT_STARTED", { subagentRunId }),
  eventVariant("SUBAGENT_FINISHED", { subagentRunId }),
  eventVariant("SUBAGENT_ERROR", { subagentRunId }),
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

const AgUiEventSchema = Schema.Union([AgUiNamedEvent, AgUiUnknownEvent]);
type AgUiEventSchema = typeof AgUiEventSchema.Type;
type AgUiNamedEvent = typeof AgUiNamedEvent.Type;
type AgUiEventCases<Output> = {
  readonly [Type in AgUiNamedEvent["type"]]?: (
    event: Extract<AgUiNamedEvent, { readonly type: Type }>,
  ) => Output;
};

const isAgUiNamedEvent = (event: AgUiEventSchema): event is AgUiNamedEvent =>
  agUiNamedEventTypes.has(event.type);

const matchOrElse = <Output>(
  event: AgUiEventSchema,
  cases: AgUiEventCases<Output>,
  orElse: (event: AgUiEventSchema) => Output,
) => {
  if (!isAgUiNamedEvent(event)) return orElse(event);
  return AgUiNamedEvent.matchOrElse(event, cases, orElse);
};

export const AgUiEvent = Object.assign(AgUiEventSchema, {
  guards: AgUiNamedEvent.guards,
  match: AgUiNamedEvent.match,
  matchOrElse,
});
export type AgUiEvent = typeof AgUiEvent.Type;

export const FileDiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
export type FileDiffValue = typeof FileDiffValue.Type;

const AgUiFileDiffEvent = eventVariant("CUSTOM", {
  name: Schema.Literal(FILE_DIFF_EVENT),
  value: FileDiffValue,
});
export type AgUiFileDiffEvent = typeof AgUiFileDiffEvent.Type;

export const agUiIsFileDiffEvent = Schema.is(AgUiFileDiffEvent);

export const agUiFileDiffEvent = (path: string, diff: string) =>
  ({ type: "CUSTOM", name: FILE_DIFF_EVENT, value: { path, diff } }) satisfies AgUiFileDiffEvent;

export const FileDiffUnavailableValue = Schema.Struct({ message: Schema.String });
export type FileDiffUnavailableValue = typeof FileDiffUnavailableValue.Type;

const AgUiFileDiffUnavailableEvent = eventVariant("CUSTOM", {
  name: Schema.Literal(FILE_DIFF_UNAVAILABLE_EVENT),
  value: FileDiffUnavailableValue,
});
export type AgUiFileDiffUnavailableEvent = typeof AgUiFileDiffUnavailableEvent.Type;

export const agUiIsFileDiffUnavailableEvent = Schema.is(AgUiFileDiffUnavailableEvent);

export const agUiFileDiffUnavailableEvent = () =>
  ({
    type: "CUSTOM",
    name: FILE_DIFF_UNAVAILABLE_EVENT,
    value: { message: "The live file-change feed stopped. File changes may be incomplete." },
  }) satisfies AgUiFileDiffUnavailableEvent;

export const StructuredOutputCompleteValue = Schema.Struct({
  object: Schema.Unknown,
  raw: Schema.String,
});
export type StructuredOutputCompleteValue = typeof StructuredOutputCompleteValue.Type;

const AgUiStructuredOutputCompleteEvent = eventVariant("CUSTOM", {
  name: Schema.Literal("structured-output.complete"),
  value: StructuredOutputCompleteValue,
});

const AgUiSessionHandleEvent = eventVariant("CUSTOM", {
  name: SessionHandleEventName,
  value: SessionHandleValue,
});

export const AgUiCorrelation = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
  toolCallId: Schema.NullOr(Schema.String),
});
export type AgUiCorrelation = typeof AgUiCorrelation.Type;

const stringField = (event: AgUiEvent, key: string) => {
  const value = event[key];
  return typeof value === "string" ? value : null;
};

export const agUiCorrelation = (event: AgUiEvent) => ({
  threadId: stringField(event, "threadId"),
  messageId: stringField(event, "messageId"),
  toolCallId: stringField(event, "toolCallId"),
});

export const agUiIsSubagentEvent = (event: AgUiEvent) => stringField(event, "subagentRunId") !== null;

export const agUiIsTerminal = (event: AgUiEvent) =>
  AgUiEvent.guards.RUN_FINISHED(event) || AgUiEvent.guards.RUN_ERROR(event);

export const agUiTextDelta = (event: AgUiEvent) =>
  AgUiEvent.guards.TEXT_MESSAGE_CONTENT(event) ? (event.delta ?? "") : "";

export const agUiIsStructuredOutputComplete = Schema.is(AgUiStructuredOutputCompleteEvent);

export const agUiIsSessionHandleEvent = Schema.is(AgUiSessionHandleEvent);

export const agUiUsage = (event: AgUiEvent): TokenUsage | null => {
  if (!AgUiEvent.guards.RUN_FINISHED(event) || !event.usage) return null;
  return {
    inputTokens: event.usage.promptTokens,
    outputTokens: event.usage.completionTokens,
    totalTokens: event.usage.totalTokens,
    ...(event.usage.estimated ? { estimated: true } : {}),
  };
};

export const agUiDisplayName = (event: AgUiEvent) =>
  stringField(event, "toolCallName") ?? stringField(event, "name") ?? stringField(event, "stepName");
