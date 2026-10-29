import {
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowParameterValue,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
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
) => subscriptions.filter(({ workspaces }) => workspaces.includes(workspace));

export interface ProviderPollCheckpoint {
  readonly cursors: ReadonlyMap<WorkspaceId, number>;
}

export interface ProviderPollRead extends ProviderPollCheckpoint {
  readonly events: ReadonlyArray<TriggerEvent>;
}

interface ProviderPollState extends ProviderPollCheckpoint {
  readonly pending: ReadonlyArray<TriggerEvent>;
}

const batchSize = 50;

const eventIdentity = (event: TriggerEvent) =>
  `${event.entry}:${event.workspace}:${event.revision}:${JSON.stringify(event.parameters ?? [])}`;

const uniqueEvents = (events: ReadonlyArray<TriggerEvent>) =>
  [...new Map(events.map((event) => [eventIdentity(event), event])).values()].sort(
    (left, right) => left.atMillis - right.atMillis,
  );

const poll = <R>(
  source: TriggerSourceId,
  state: Ref.Ref<ProviderPollState>,
  read: (checkpoint: ProviderPollCheckpoint) => Effect.Effect<ProviderPollRead, IssueTrackerError, R>,
) =>
  Ref.get(state).pipe(
    Effect.flatMap((current) => {
      if (current.pending.length > 0) {
        const emitted = current.pending.slice(0, batchSize);
        return Ref.set(state, { ...current, pending: current.pending.slice(batchSize) }).pipe(
          Effect.map(() => emitted),
        );
      }
      return read(current).pipe(
        Effect.flatMap(({ events, cursors }) => {
          const unique = uniqueEvents(events);
          const emitted = unique.slice(0, batchSize);
          return Ref.set(state, { cursors, pending: unique.slice(batchSize) }).pipe(
            Effect.map(() => emitted),
          );
        }),
      );
    }),
    Effect.mapError((error) => sourceFailure(source, error)),
  );

export const providerPollingStream = <R>(
  source: TriggerSourceId,
  read: (checkpoint: ProviderPollCheckpoint) => Effect.Effect<ProviderPollRead, IssueTrackerError, R>,
) =>
  Stream.unwrap(
    Ref.make<ProviderPollState>({ cursors: new Map(), pending: [] }).pipe(
      Effect.map((state) =>
        Stream.fromEffect(poll(source, state, read)).pipe(
          Stream.repeat(Schedule.spaced("60 seconds")),
          Stream.flattenIterable,
        ),
      ),
    ),
  );
