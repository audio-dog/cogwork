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

export const AttemptRecord = Schema.Struct({
  stage: LifecycleStage,
  outcome: AttemptOutcome,
  atMillis: Schema.Natural,
});
export type AttemptRecord = typeof AttemptRecord.Type;
