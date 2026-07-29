import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkspaceId } from "./baseSchemas";

export const DaemonHealth = Schema.Literals(["running"]);
export type DaemonHealth = typeof DaemonHealth.Type;

export const WorkspaceInfo = Schema.Struct({
  name: WorkspaceId,
  checkoutPath: TrimmedNonEmptyString,
  workSource: TrimmedNonEmptyString,
  harness: TrimmedNonEmptyString,
});
export type WorkspaceInfo = typeof WorkspaceInfo.Type;

export const WorkspaceFailureInfo = Schema.Struct({
  source: TrimmedNonEmptyString,
  message: Schema.String,
});
export type WorkspaceFailureInfo = typeof WorkspaceFailureInfo.Type;

export const DaemonStatus = Schema.Struct({
  health: DaemonHealth,
  startedAtMillis: Schema.Finite,
  uptimeMillis: Schema.Finite,
  workspaces: Schema.Array(WorkspaceInfo),
  failures: Schema.Array(WorkspaceFailureInfo),
});
export type DaemonStatus = typeof DaemonStatus.Type;
