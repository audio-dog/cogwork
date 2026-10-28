import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkItemId } from "./base-schemas";
import { LifecycleStage } from "./triage";

const WithoutLineage = {
  lineageRoot: Schema.optionalKey(Schema.Never),
  lineageParent: Schema.optionalKey(Schema.Never),
};

const WithLineage = {
  lineageRoot: WorkItemId,
  lineageParent: Schema.NullOr(WorkItemId),
};

const ClaimFields = {
  by: TrimmedNonEmptyString,
  claimedAtMillis: Schema.Natural,
  stage: Schema.optional(LifecycleStage),
};

export const Claim = Schema.Union([
  Schema.Struct({ ...ClaimFields, ...WithoutLineage }),
  Schema.Struct({ ...ClaimFields, ...WithLineage }),
]);
export type Claim = typeof Claim.Type;

export const AttemptOutcome = Schema.Literals(["succeeded", "failed", "abandoned"]);
export type AttemptOutcome = typeof AttemptOutcome.Type;

export const OperationKey = Schema.Struct({
  workflow: TrimmedNonEmptyString,
  operation: TrimmedNonEmptyString,
});
export type OperationKey = typeof OperationKey.Type;

export const codingOperation = (stage: LifecycleStage) => ({
  workflow: "coding",
  operation: stage,
});

const AttemptFields = {
  ...OperationKey.fields,
  outcome: AttemptOutcome,
  atMillis: Schema.Natural,
};

export const AttemptRecord = Schema.Union([
  Schema.Struct({ ...AttemptFields, ...WithoutLineage }),
  Schema.Struct({ ...AttemptFields, ...WithLineage }),
]);
export type AttemptRecord = typeof AttemptRecord.Type;

export const HandbackRecord = Schema.Struct({
  by: TrimmedNonEmptyString,
  atMillis: Schema.Natural,
});
export type HandbackRecord = typeof HandbackRecord.Type;
