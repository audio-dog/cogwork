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

export const NeedsHumanReason = Schema.Literals(["needs-info", "ready-for-human"]);
export type NeedsHumanReason = typeof NeedsHumanReason.Type;

export const stagePriority: ReadonlyArray<LifecycleStage> = ["follow-up", "triage", "implement", "verify"];

// The one canonical priority scale. It only orders work within a lifecycle stage; stage always wins.
export const Priority = Schema.Literals(["urgent", "high", "medium", "low"]);
export type Priority = typeof Priority.Type;

// Highest first. A ticket earlier in this list is picked before a later one of the same stage.
export const priorityRank: ReadonlyArray<Priority> = ["urgent", "high", "medium", "low"];

// What an unset or unrecognized priority becomes. Priority orders work; it never gates eligibility,
// so a value we can't read must never drop an item — it just lands in the middle.
export const defaultPriority: Priority = "medium";

// Map anything a tracker hands us onto the canonical scale, case-insensitively. Absent, blank, or
// unknown resolves to the default rather than failing.
export const resolvePriority = (value: string | null | undefined): Priority => {
  if (value == null) return defaultPriority;
  const normalized = value.trim().toLowerCase();
  return priorityRank.find((priority) => priority === normalized) ?? defaultPriority;
};

// The one ordering rule the engine sorts work by: stage always wins, then priority breaks ties within
// a stage. It lives here so the classifier's eligible-work list and the scheduler's candidate list
// order identically and can't drift apart. Callers keep their own stable input order as the final
// tie-break, so equal stage and priority stay in tracker listing order. Priority never lets a ticket
// jump its stage.
export const byStageThenPriority = (
  a: { readonly stage: LifecycleStage; readonly priority: Priority },
  b: { readonly stage: LifecycleStage; readonly priority: Priority },
): number =>
  stagePriority.indexOf(a.stage) - stagePriority.indexOf(b.stage) ||
  priorityRank.indexOf(a.priority) - priorityRank.indexOf(b.priority);
