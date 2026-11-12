import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkItemId } from "./base-schemas";

export const WorkItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
});
export type WorkItem = typeof WorkItem.Type;

export const Priority = Schema.Literals(["urgent", "high", "medium", "low"]);
export type Priority = typeof Priority.Type;

export const priorityRank: ReadonlyArray<Priority> = ["urgent", "high", "medium", "low"];
export const defaultPriority: Priority = "medium";

export const resolvePriority = (value: string | null | undefined): Priority => {
  if (value == null) return defaultPriority;
  const normalized = value.trim().toLowerCase();
  return priorityRank.find((priority) => priority === normalized) ?? defaultPriority;
};

export const workItemCandidates = (workItem: string) => {
  const bare = workItem.startsWith("#") ? workItem.slice(1) : workItem;
  return [bare, `#${bare}`];
};
