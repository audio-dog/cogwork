import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkItemId } from "./base-schemas";

export const WorkItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
});
export type WorkItem = typeof WorkItem.Type;
