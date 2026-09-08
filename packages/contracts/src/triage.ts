import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { StructuredOutputCompleteValue } from "./ag-ui";
import { TrimmedNonEmptyString } from "./base-schemas";

export const LifecycleStage = Schema.Literals(["triage", "implement", "follow-up"]);
export type LifecycleStage = typeof LifecycleStage.Type;

export const TriageRole = Schema.Literals([
  "needs-triage",
  "ready-for-agent",
  "needs-info",
  "ready-for-human",
  "wontfix",
]);
export type TriageRole = typeof TriageRole.Type;

export const TriageResultRole = Schema.Literals([
  "ready-for-agent",
  "needs-info",
  "ready-for-human",
  "wontfix",
]);
export type TriageResultRole = typeof TriageResultRole.Type;

export class TriageStageResult extends Schema.TaggedClass<TriageStageResult>()("triage", {
  role: TriageResultRole,
  proposal: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.role;
  }

  get detail() {
    return this.proposal;
  }
}

export const ImplementResultOutcome = Schema.Literals(["opened-pr", "stuck"]);
export type ImplementResultOutcome = typeof ImplementResultOutcome.Type;

export class ImplementStageResult extends Schema.TaggedClass<ImplementStageResult>()("implement", {
  outcome: ImplementResultOutcome,
  summary: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

export const FollowUpResultOutcome = Schema.Literals(["pushed", "noop", "stuck"]);
export type FollowUpResultOutcome = typeof FollowUpResultOutcome.Type;

export class FollowUpStageResult extends Schema.TaggedClass<FollowUpStageResult>()("follow-up", {
  outcome: FollowUpResultOutcome,
  summary: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

export const StageResult = Schema.Union([TriageStageResult, ImplementStageResult, FollowUpStageResult]).pipe(
  Schema.toTaggedUnion("_tag"),
);
export type StageResult = typeof StageResult.Type;

export const TriageStageResultCompletion = Schema.Struct({
  ...StructuredOutputCompleteValue.fields,
  object: TriageStageResult,
});

export const ImplementStageResultCompletion = Schema.Struct({
  ...StructuredOutputCompleteValue.fields,
  object: ImplementStageResult,
});

export const FollowUpStageResultCompletion = Schema.Struct({
  ...StructuredOutputCompleteValue.fields,
  object: FollowUpStageResult,
});

const standardSchema = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

const triageStageResultSchema = standardSchema(Schema.Struct(TriageStageResult.fields));
const implementStageResultSchema = standardSchema(Schema.Struct(ImplementStageResult.fields));
const followUpStageResultSchema = standardSchema(Schema.Struct(FollowUpStageResult.fields));

export type StageResultJsonSchema =
  | typeof triageStageResultSchema
  | typeof implementStageResultSchema
  | typeof followUpStageResultSchema;

export type StageResultCompletionSchema =
  | typeof TriageStageResultCompletion
  | typeof ImplementStageResultCompletion
  | typeof FollowUpStageResultCompletion;

interface StageResultSchemas {
  readonly json: StageResultJsonSchema;
  readonly completion: StageResultCompletionSchema;
}

const stageResultSchemas: Record<LifecycleStage, StageResultSchemas> = {
  triage: { json: triageStageResultSchema, completion: TriageStageResultCompletion },
  implement: { json: implementStageResultSchema, completion: ImplementStageResultCompletion },
  "follow-up": { json: followUpStageResultSchema, completion: FollowUpStageResultCompletion },
};

export const stageResultJsonSchema = (stage: LifecycleStage) => stageResultSchemas[stage].json;

export const stageResultCompletionSchema = (stage: LifecycleStage) => stageResultSchemas[stage].completion;

type StageResultCompletion =
  | typeof TriageStageResultCompletion.Type
  | typeof ImplementStageResultCompletion.Type
  | typeof FollowUpStageResultCompletion.Type;

type StageResultCompletionDecoder = (
  input: unknown,
) => Effect.Effect<StageResultCompletion, Schema.SchemaError>;

const stageResultCompletionDecoders: Record<LifecycleStage, StageResultCompletionDecoder> = {
  triage: Schema.decodeUnknownEffect(TriageStageResultCompletion),
  implement: Schema.decodeUnknownEffect(ImplementStageResultCompletion),
  "follow-up": Schema.decodeUnknownEffect(FollowUpStageResultCompletion),
};

export const decodeStageResultCompletion = (stage: LifecycleStage, input: unknown) =>
  stageResultCompletionDecoders[stage](input);

export const NeedsHumanReason = Schema.Literals(["needs-info", "ready-for-human"]);
export type NeedsHumanReason = typeof NeedsHumanReason.Type;

export const stagePriority: ReadonlyArray<LifecycleStage> = ["follow-up", "triage", "implement"];

export const Priority = Schema.Literals(["urgent", "high", "medium", "low"]);
export type Priority = typeof Priority.Type;

export const priorityRank: ReadonlyArray<Priority> = ["urgent", "high", "medium", "low"];

export const defaultPriority: Priority = "medium";

export const resolvePriority = (value: string | null | undefined): Priority => {
  if (value == null) return defaultPriority;
  const normalized = value.trim().toLowerCase();
  return priorityRank.find((priority) => priority === normalized) ?? defaultPriority;
};

export const byStageThenPriority = (
  a: { readonly stage: LifecycleStage; readonly priority: Priority },
  b: { readonly stage: LifecycleStage; readonly priority: Priority },
): number =>
  stagePriority.indexOf(a.stage) - stagePriority.indexOf(b.stage) ||
  priorityRank.indexOf(a.priority) - priorityRank.indexOf(b.priority);
