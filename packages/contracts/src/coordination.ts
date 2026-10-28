import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./base-schemas";
import { LifecycleStage } from "./triage";

export const Claim = Schema.Struct({
  by: TrimmedNonEmptyString,
  claimedAtMillis: Schema.Natural,
  stage: Schema.optional(LifecycleStage),
});
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

export const AttemptRecord = Schema.Struct({
  ...OperationKey.fields,
  outcome: AttemptOutcome,
  atMillis: Schema.Natural,
});
export type AttemptRecord = typeof AttemptRecord.Type;

export const HandbackRecord = Schema.Struct({
  by: TrimmedNonEmptyString,
  atMillis: Schema.Natural,
});
export type HandbackRecord = typeof HandbackRecord.Type;
