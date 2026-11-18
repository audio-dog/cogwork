import {
  Cause,
  Priority,
  RunPlanWorkContextProse,
  RunSubject,
  type WorkflowAvailability,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkflowParameterValue,
  WorkItemRef,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { SystemOptions } from "./workflow-options";

export const TriggerSourceId = Schema.Literals(["github", "linear", "granola", "slack", "clock"]);
export type TriggerSourceId = typeof TriggerSourceId.Type;

export const TriggerSubscription = Schema.Struct({
  workflow: WorkflowId,
  trigger: WorkflowNodeId,
  operation: WorkflowNodeId,
  entry: WorkflowCatalogKey,
  parameters: Schema.Array(WorkflowParameterValue),
  filters: Schema.Array(WorkflowCatalogKey).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  workspaces: Schema.Array(WorkspaceId),
  catchUp: Schema.NullOr(Schema.Struct({ since: Schema.Natural })),
});
export type TriggerSubscription = typeof TriggerSubscription.Type;

export const TriggerEventPayload = Schema.TaggedUnion({
  GranolaNote: {
    title: Schema.String,
    attendees: Schema.Array(Schema.String),
    calendarEvent: Schema.String,
    summary: Schema.String,
    transcript: Schema.String,
  },
  GranolaNoteRejected: { reason: Schema.String },
  NoLongerMatches: { reason: Schema.String },
});
export type TriggerEventPayload = typeof TriggerEventPayload.Type;

export const TriggerEvent = Schema.Struct({
  key: WorkItemRef,
  revision: Schema.String,
  cause: Cause,
  atMillis: Schema.Natural,
  entry: WorkflowCatalogKey,
  workspace: Schema.NullOr(WorkspaceId),
  priority: Schema.optional(Priority),
  target: Schema.optional(
    Schema.Struct({
      workflow: WorkflowId,
      trigger: WorkflowNodeId,
    }),
  ),
  parameters: Schema.optional(Schema.Array(WorkflowParameterValue)),
  passes: Schema.optional(Schema.Array(WorkflowCatalogKey)),
  subject: Schema.optional(RunSubject),
  workContext: Schema.optional(RunPlanWorkContextProse),
  payload: Schema.optional(TriggerEventPayload),
  pullRequest: Schema.optional(
    Schema.Struct({
      author: Schema.String,
      headRef: Schema.String,
      closingIssueNumbers: Schema.Array(Schema.Int),
    }),
  ),
});
export type TriggerEvent = typeof TriggerEvent.Type;

export interface SweepCandidate {
  readonly key: WorkItemRef;
  readonly workspace: WorkspaceId | null;
  readonly subject?: RunSubject | undefined;
  readonly lastTouchedAtMillis: number;
  readonly loadWorkContext?: Effect.Effect<RunPlanWorkContextProse | undefined, SourceFailure>;
}

export interface TriggerReadPort {
  readonly sweep: (
    subscription: TriggerSubscription,
    tickInstant: number,
  ) => Effect.Effect<ReadonlyArray<SweepCandidate>, SourceFailure>;
}

export class SourceFailure extends Schema.TaggedError<SourceFailure>()("SourceFailure", {
  source: TriggerSourceId,
  reason: Schema.Literals(["auth", "unavailable", "rate-limited", "decode", "connection-not-ready"]),
  retryAfterMillis: Schema.NullOr(Schema.Natural),
  message: Schema.String,
}) {}

export interface TriggerEntry extends WorkflowCatalogEntry {
  readonly triggerKind: "condition" | "occurrence";
}

export interface TriggerSource {
  readonly id: TriggerSourceId;
  readonly entries: ReadonlyArray<TriggerEntry>;
  readonly filters?: ReadonlyArray<WorkflowCatalogEntry>;
  readonly availability: (entry: WorkflowCatalogKey) => Effect.Effect<WorkflowAvailability>;
  readonly options?: ReadonlyArray<SystemOptions>;
  readonly observe: (
    subscriptions: ReadonlyArray<TriggerSubscription>,
    readPort?: TriggerReadPort,
  ) => Stream.Stream<TriggerEvent, SourceFailure>;
  readonly acknowledge?: (
    event: TriggerEvent,
    subscriptions: ReadonlyArray<TriggerSubscription>,
  ) => Effect.Effect<void>;
  readonly recheck?: (
    event: TriggerEvent,
    subscription: TriggerSubscription,
  ) => Effect.Effect<Recheck, SourceFailure>;
}

export type Recheck = Data.TaggedEnum<{
  Matches: Record<never, never>;
  Ended: { readonly reason: string };
  Waiting: { readonly reason: string };
}>;
export const Recheck = Data.taggedEnum<Recheck>();

export const ownsEntry = (source: TriggerSource, entry: WorkflowCatalogKey) =>
  source.entries.some(({ key }) => key === entry);

export const combineTriggerSources = (sources: ReadonlyArray<TriggerSource>) =>
  [...Map.groupBy(sources, ({ id }) => id)].map(
    ([id, grouped]) =>
      ({
        id,
        entries: grouped.flatMap(({ entries }) => entries),
        filters: grouped.flatMap(({ filters = [] }) => filters),
        availability: (entry) =>
          grouped.find((source) => ownsEntry(source, entry))?.availability(entry) ??
          Effect.succeed({ _tag: "Unavailable", reason: `Unknown ${entry} entry` }),
        options: grouped.flatMap(({ options = [] }) => options),
        observe: (subscriptions, readPort) => {
          const streams = grouped
            .map((source) => ({
              source,
              subscriptions: subscriptions.filter(({ entry }) => ownsEntry(source, entry)),
            }))
            .filter(({ subscriptions: selected }) => selected.length > 0)
            .map(({ source, subscriptions: selected }) => source.observe(selected, readPort));
          return streams.length === 0 ? Stream.empty : Stream.mergeAll(streams, { concurrency: "unbounded" });
        },
        acknowledge: (event, subscriptions) =>
          grouped.find((source) => ownsEntry(source, event.entry))?.acknowledge?.(event, subscriptions) ??
          Effect.void,
        recheck: (event, subscription) =>
          grouped.find((source) => ownsEntry(source, event.entry))?.recheck?.(event, subscription) ??
          Effect.succeed(Recheck.Matches()),
      }) satisfies TriggerSource,
  );

export class TriggerSources extends Context.Service<TriggerSources, ReadonlyArray<TriggerSource>>()(
  "@cogwork/engine/trigger-source/TriggerSources",
) {}
