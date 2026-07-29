import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas";
import { WorkspaceConfig } from "./workspace";

export const WorkspaceRegistered = Schema.Struct({
  type: Schema.Literal("workspace.registered"),
  source: TrimmedNonEmptyString,
  config: WorkspaceConfig,
});
export type WorkspaceRegistered = typeof WorkspaceRegistered.Type;

export const WorkspaceRegistrationFailed = Schema.Struct({
  type: Schema.Literal("workspace.registration-failed"),
  source: TrimmedNonEmptyString,
  message: Schema.String,
});
export type WorkspaceRegistrationFailed = typeof WorkspaceRegistrationFailed.Type;

export const WorkspaceEvent = Schema.Union([WorkspaceRegistered, WorkspaceRegistrationFailed]);
export type WorkspaceEvent = typeof WorkspaceEvent.Type;
