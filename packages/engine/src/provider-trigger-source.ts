import {
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowParameterValue,
  type WorkspaceId,
} from "@cogwork/contracts";
import type * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IssueTrackerError } from "./issue-tracker";
import { SourceFailure, type TriggerEvent, type TriggerSourceId } from "./trigger-source";

export const catchUpParameter = {
  id: "catch-up-at-most",
  required: false,
  source: "fixed",
  values: Array.from({ length: 31 }, (_, days) => String(days)),
} as const;

export const liveParameter = (id: string) => ({
  id,
  required: true,
  source: "live" as const,
  values: [],
});

export const triggerEntry = (
  key: string,
  name: string,
  system: "github" | "linear",
  itemKind: "issue" | "pull-request",
  parameters: WorkflowCatalogEntry["parameters"],
): WorkflowCatalogEntry => ({
  key: Schema.decodeSync(WorkflowCatalogKey)(key),
  name,
  kind: "trigger",
  system,
  connection: system,
  requires: [],
  parameters,
  itemKind,
  actsOn: [],
  requiresWorkspace: true,
  permissionProfile: "read-only",
  agentInputs: [],
  emits: [],
});

export const sourceFailure = (source: TriggerSourceId, error: IssueTrackerError) =>
  new SourceFailure({
    source,
    reason: error.reason === "rate-limited" || error.reason === "auth" ? error.reason : "unavailable",
    retryAfterMillis: error.retryAfterMillis ?? null,
    message: error.message,
  });

export const parameterValue = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  parameters.find((parameter) => parameter.id === id)?.value;

export const catchUpSince = (
  parameters: ReadonlyArray<WorkflowParameterValue>,
  switchedOnAt: number,
  now: number,
) => {
  const configured = Number(parameterValue(parameters, "catch-up-at-most") ?? "7");
  const days = Number.isInteger(configured) && configured >= 0 && configured <= 30 ? configured : 7;
  return Math.max(switchedOnAt, now - days * 86_400_000);
};

export const workspaceSubscriptions = <A extends { readonly workspaces: ReadonlyArray<WorkspaceId> }>(
  workspace: WorkspaceId,
  subscriptions: ReadonlyArray<A>,
) => subscriptions.filter(({ workspaces }) => workspaces.length === 0 || workspaces.includes(workspace));

export const pollingStream = <E, R>(read: Effect.Effect<ReadonlyArray<TriggerEvent>, E, R>) =>
  Stream.fromEffect(read).pipe(Stream.repeat(Schedule.spaced("5 seconds")), Stream.flattenIterable);
