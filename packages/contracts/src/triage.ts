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

export const ImplementResultOutcome = Schema.Literals(["opened-pr", "ready-for-pr", "stuck"]);
export type ImplementResultOutcome = typeof ImplementResultOutcome.Type;

class OpenedPrImplementResult extends Schema.TaggedClass<OpenedPrImplementResult>()("implement", {
  outcome: Schema.Literal("opened-pr"),
  summary: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

class ReadyForPrImplementResult extends Schema.TaggedClass<ReadyForPrImplementResult>()("implement", {
  outcome: Schema.Literal("ready-for-pr"),
  summary: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

class StuckImplementResult extends Schema.TaggedClass<StuckImplementResult>()("implement", {
  outcome: Schema.Literal("stuck"),
  summary: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

export const ImplementStageResult = Schema.Union([
  OpenedPrImplementResult,
  ReadyForPrImplementResult,
  StuckImplementResult,
]).pipe(Schema.toTaggedUnion("outcome"));
export type ImplementStageResult = typeof ImplementStageResult.Type;

export const FollowUpResultOutcome = Schema.Literals(["pushed", "noop", "stuck"]);
export type FollowUpResultOutcome = typeof FollowUpResultOutcome.Type;

class PushedFollowUpResult extends Schema.TaggedClass<PushedFollowUpResult>()("follow-up", {
  outcome: Schema.Literal("pushed"),
  summary: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

class NoopFollowUpResult extends Schema.TaggedClass<NoopFollowUpResult>()("follow-up", {
  outcome: Schema.Literal("noop"),
  summary: TrimmedNonEmptyString,
  speak: Schema.Boolean,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

class StuckFollowUpResult extends Schema.TaggedClass<StuckFollowUpResult>()("follow-up", {
  outcome: Schema.Literal("stuck"),
  summary: TrimmedNonEmptyString,
}) {
  get resultKey() {
    return this.outcome;
  }

  get detail() {
    return this.summary;
  }
}

export const FollowUpStageResult = Schema.Union([
  PushedFollowUpResult,
  NoopFollowUpResult,
  StuckFollowUpResult,
]).pipe(Schema.toTaggedUnion("outcome"));
export type FollowUpStageResult = typeof FollowUpStageResult.Type;

export const StageResult = Schema.Union([TriageStageResult, ImplementStageResult, FollowUpStageResult]);
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
const implementStageResultInput = Schema.TaggedStruct("implement", {
  outcome: ImplementResultOutcome,
  summary: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.NullOr(TrimmedNonEmptyString),
});
const hasRequiredPullRequestContent = (result: typeof implementStageResultInput.Type) =>
  result.outcome !== "ready-for-pr" || (result.title !== null && result.body !== null);
const implementStageResultSchema = standardSchema(
  implementStageResultInput.check(
    Schema.makeFilter(hasRequiredPullRequestContent, {
      message: "ready-for-pr requires title and body",
    }),
  ),
);
const followUpStageResultInput = Schema.TaggedStruct("follow-up", {
  outcome: FollowUpResultOutcome,
  summary: TrimmedNonEmptyString,
  speak: Schema.NullOr(Schema.Boolean),
});
const hasRequiredSpeakingDecision = (result: typeof followUpStageResultInput.Type) =>
  result.outcome !== "noop" || result.speak !== null;
const followUpStageResultSchema = standardSchema(
  followUpStageResultInput.check(
    Schema.makeFilter(hasRequiredSpeakingDecision, {
      message: "noop requires a speaking decision",
    }),
  ),
);

export type StageResultJsonSchema =
  | typeof triageStageResultSchema
  | typeof implementStageResultSchema
  | typeof followUpStageResultSchema;

export type StageResultCompletionSchema =
  | typeof TriageStageResultCompletion
  | typeof ImplementStageResultCompletion
  | typeof FollowUpStageResultCompletion;

export const stageResultSchemas = {
  triage: { json: triageStageResultSchema, completion: TriageStageResultCompletion },
  implement: { json: implementStageResultSchema, completion: ImplementStageResultCompletion },
  "follow-up": { json: followUpStageResultSchema, completion: FollowUpStageResultCompletion },
} satisfies Record<
  LifecycleStage,
  { readonly json: StageResultJsonSchema; readonly completion: StageResultCompletionSchema }
>;
export type StageResultSchemas = typeof stageResultSchemas;

export const stageResultJsonSchema = (stage: LifecycleStage) => stageResultSchemas[stage].json;

export const stageResultCompletionSchema = (stage: LifecycleStage) => stageResultSchemas[stage].completion;

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
