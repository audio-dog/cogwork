import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./base-schemas";

export const LifecycleStage = Schema.Literals(["triage", "implement", "follow-up", "verify"]);
export type LifecycleStage = typeof LifecycleStage.Type;

export const TriageRole = Schema.Literals([
  "needs-triage",
  "ready-for-agent",
  "needs-info",
  "ready-for-human",
  "wontfix",
]);
export type TriageRole = typeof TriageRole.Type;

export class TriageStageResult extends Schema.TaggedClass<TriageStageResult>()("triage", {
  role: TriageRole,
  proposal: TrimmedNonEmptyString,
}) {}

export const StageResult = Schema.Union([TriageStageResult]);
export type StageResult = typeof StageResult.Type;

export const NeedsHumanReason = Schema.Literals(["needs-info", "ready-for-human"]);
export type NeedsHumanReason = typeof NeedsHumanReason.Type;

export const stagePriority: ReadonlyArray<LifecycleStage> = ["follow-up", "triage", "implement", "verify"];

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
