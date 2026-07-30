import * as Schema from "effect/Schema";

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

export const BlockReason = Schema.Literals(["needs-info", "ready-for-human"]);
export type BlockReason = typeof BlockReason.Type;

export const stagePriority: ReadonlyArray<LifecycleStage> = ["follow-up", "triage", "implement", "verify"];
