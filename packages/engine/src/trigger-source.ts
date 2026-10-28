import {
  Cause,
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
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
  prose: Schema.optional(
    Schema.Struct({
      body: Schema.String,
      comments: Schema.Array(
        Schema.Struct({
          author: Schema.NullOr(Schema.String),
          authorAssociation: Schema.NullOr(Schema.String),
          body: Schema.String,
          createdAtMillis: Schema.Natural,
        }),
      ),
    }),
  ),
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
}

const ownsEntry = (source: TriggerSource, entry: WorkflowCatalogKey) =>
  source.entries.some(({ key }) => key === entry);

export const combineTriggerSources = (sources: ReadonlyArray<TriggerSource>) =>
  [...Map.groupBy(sources, ({ id }) => id)].map(
    ([id, grouped]) =>
      ({
        id,
        entries: grouped.flatMap(({ entries }) => entries),
        availability: (entry) =>
          grouped.find((source) => ownsEntry(source, entry))?.availability(entry) ??
          Effect.succeed({ _tag: "Unavailable", reason: `Unknown ${entry} entry` }),
        listOptions: (entry, parameter, workspace) =>
          grouped.find((source) => ownsEntry(source, entry))?.listOptions(entry, parameter, workspace) ??
          Effect.succeed([]),
        observe: (subscriptions) => {
          const streams = grouped
            .map((source) => ({
              source,
              subscriptions: subscriptions.filter(({ entry }) => ownsEntry(source, entry)),
            }))
            .filter(({ subscriptions: selected }) => selected.length > 0)
            .map(({ source, subscriptions: selected }) => source.observe(selected));
          return streams.length === 0 ? Stream.empty : Stream.mergeAll(streams, { concurrency: "unbounded" });
        },
      }) satisfies TriggerSource,
  );

export class TriggerSources extends Context.Service<TriggerSources, ReadonlyArray<TriggerSource>>()(
  "@cogwork/engine/trigger-source/TriggerSources",
) {}
