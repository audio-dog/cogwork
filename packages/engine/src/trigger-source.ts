import {
  Cause,
  RunPlanWorkContextProse,
  type WorkflowAvailability,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowOption,
  WorkflowParameterValue,
  WorkItemRef,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export const TriggerSourceId = Schema.Literals(["github", "linear", "granola", "slack", "clock"]);
export type TriggerSourceId = typeof TriggerSourceId.Type;

export const TriggerSubscription = Schema.Struct({
  workflow: WorkflowId,
  trigger: WorkflowNodeId,
  operation: WorkflowNodeId,
  entry: WorkflowCatalogKey,
  parameters: Schema.Array(WorkflowParameterValue),
  workspaces: Schema.Array(WorkspaceId),
  catchUp: Schema.NullOr(Schema.Struct({ since: Schema.Natural })),
});
export type TriggerSubscription = typeof TriggerSubscription.Type;

export const TriggerEvent = Schema.Struct({
  key: WorkItemRef,
  revision: Schema.String,
  cause: Cause,
  atMillis: Schema.Natural,
  entry: WorkflowCatalogKey,
  workspace: Schema.NullOr(WorkspaceId),
  parameters: Schema.optional(Schema.Array(WorkflowParameterValue)),
  workContext: Schema.optional(RunPlanWorkContextProse),
});
export type TriggerEvent = typeof TriggerEvent.Type;

export class SourceFailure extends Schema.TaggedError<SourceFailure>()("SourceFailure", {
  source: TriggerSourceId,
  reason: Schema.Literals(["auth", "unavailable", "rate-limited", "decode", "connection-not-ready"]),
  retryAfterMillis: Schema.NullOr(Schema.Natural),
  message: Schema.String,
}) {}

export interface TriggerSource {
  readonly id: TriggerSourceId;
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly availability: (entry: WorkflowCatalogKey) => Effect.Effect<WorkflowAvailability>;
  readonly listOptions: (
    entry: WorkflowCatalogKey,
    parameter: string,
    workspace?: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<WorkflowOption>, SourceFailure>;
  readonly observe: (
    subscriptions: ReadonlyArray<TriggerSubscription>,
  ) => Stream.Stream<TriggerEvent, SourceFailure>;
  readonly acknowledge?: (
    event: TriggerEvent,
    subscriptions: ReadonlyArray<TriggerSubscription>,
  ) => Effect.Effect<void>;
}

export class TriggerSources extends Context.Service<TriggerSources, ReadonlyArray<TriggerSource>>()(
  "@cogwork/engine/trigger-source/TriggerSources",
) {}
