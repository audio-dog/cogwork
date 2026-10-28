import type {
  Cause,
  WorkflowAvailability,
  WorkflowCatalogEntry,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkflowOption,
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

export interface TriggerSubscription {
  readonly workflow: WorkflowId;
  readonly trigger: WorkflowNodeId;
  readonly entry: WorkflowCatalogKey;
  readonly parameters: ReadonlyArray<WorkflowParameterValue>;
  readonly workspaces: ReadonlyArray<WorkspaceId>;
  readonly catchUp: { readonly since: number } | null;
}

export interface TriggerEvent {
  readonly key: WorkItemRef;
  readonly revision: string;
  readonly cause: Cause;
  readonly atMillis: number;
  readonly entry: WorkflowCatalogKey;
  readonly workspace: WorkspaceId | null;
}

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
}

export class TriggerSources extends Context.Service<TriggerSources, ReadonlyArray<TriggerSource>>()(
  "@cogwork/engine/trigger-source/TriggerSources",
) {}
