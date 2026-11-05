import {
  keyOf,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowOption,
  type WorkflowParameterValue,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import {
  Recheck,
  SourceFailure,
  type TriggerEntry,
  type TriggerEvent,
  type TriggerSourceId,
  type TriggerSubscription,
} from "./trigger-source";
import type { OptionReader } from "./workflow-options";

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
  triggerKind: TriggerEntry["triggerKind"],
  parameters: WorkflowCatalogEntry["parameters"],
): TriggerEntry => ({
  key: Schema.decodeSync(WorkflowCatalogKey)(key),
  name,
  kind: "trigger",
  triggerKind,
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

export interface ItemFilter<Item> {
  readonly entry: WorkflowCatalogEntry;
  readonly holds: (item: Item) => boolean;
}

export const issueNotBlockedFilter = (system: "github" | "linear") =>
  ({
    entry: {
      key: Schema.decodeSync(WorkflowCatalogKey)(`${system}.issue-not-blocked`),
      name: "Issue is not blocked",
      kind: "filter",
      system,
      connection: system,
      requires: [],
      parameters: [],
      itemKind: "issue",
      actsOn: [],
      requiresWorkspace: true,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
    holds: ({ openBlockers }) => openBlockers === 0,
  }) satisfies ItemFilter<{ readonly openBlockers: number }>;

// A filter can start holding without the item changing (its blocker closes), so a modified-since
// read never sees it; a source reads every open item with a filtered Trigger's label on each poll.
export const filteredLabels = (subscriptions: ReadonlyArray<TriggerSubscription>) => [
  ...new Set(
    subscriptions.flatMap(({ parameters, filters }) => {
      const label = parameterValue(parameters, "label");
      return filters.length > 0 && label !== undefined ? [label] : [];
    }),
  ),
];

export const passedFilters = <Item>(filters: ReadonlyArray<ItemFilter<Item>>, item: Item) =>
  filters.filter(({ holds }) => holds(item)).map(({ entry }) => entry.key);

interface IssueSnapshot<Item> {
  readonly id: string;
  readonly open: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly item: Item;
}

interface IssueFacts extends Omit<IssueSnapshot<unknown>, "item"> {
  readonly label: string;
  readonly failed: ReadonlyArray<WorkflowCatalogEntry>;
}

const issueRecheckRules: ReadonlyArray<{
  readonly holds: (facts: IssueFacts) => boolean;
  readonly make: (facts: IssueFacts) => Recheck;
}> = [
  { holds: ({ open }) => !open, make: ({ id }) => Recheck.Ended({ reason: `${id} is closed` }) },
  {
    holds: ({ labels, label }) => !labels.includes(label),
    make: ({ id, label }) => Recheck.Ended({ reason: `${id} no longer has label ${label}` }),
  },
  {
    holds: ({ failed }) => failed.length > 0,
    make: ({ id, failed }) =>
      Recheck.Waiting({ reason: `${id} fails ${failed.map(({ name }) => name).join(", ")}` }),
  },
];

export const recheckIssue = <Item>(
  filters: ReadonlyArray<ItemFilter<Item>>,
  subscription: TriggerSubscription,
  { item, ...issue }: IssueSnapshot<Item>,
) => {
  const facts: IssueFacts = {
    ...issue,
    label: parameterValue(subscription.parameters, "label") ?? "",
    failed: filters
      .filter(({ entry, holds }) => subscription.filters.includes(entry.key) && !holds(item))
      .map(({ entry }) => entry),
  };
  return issueRecheckRules.find(({ holds }) => holds(facts))?.make(facts) ?? Recheck.Matches();
};

export const sourceFailure = (source: TriggerSourceId, error: IssueTrackerError) =>
  new SourceFailure({
    source,
    reason: error.reason === "rate-limited" || error.reason === "auth" ? error.reason : "unavailable",
    retryAfterMillis: error.retryAfterMillis ?? null,
    message: error.message,
  });

export const workspaceOptionReader =
  (
    source: TriggerSourceId,
    registry: Effect.Effect<RegistryState>,
    names: (workspace: RegisteredWorkspace) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>,
  ): OptionReader =>
  (workspace) =>
    Effect.gen(function* () {
      if (workspace === undefined) return [];
      const state = yield* registry;
      const registered = state.workspaces.find(({ config }) => config.name === workspace);
      if (!registered) return [];
      const listed = yield* names(registered);
      return [...new Set(listed)].map(
        (name) => ({ value: name, name, listedIn: [workspace] }) satisfies WorkflowOption,
      );
    }).pipe(Effect.mapError((error) => sourceFailure(source, error)));

export const parameterValue = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  parameters.find((parameter) => parameter.id === id)?.value;

export const providerSubject = (title: string | undefined, url: string | null) => {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  return { title: trimmed, url: url?.trim() || null };
};

export const providerModifiedSinceGraceMillis = 30_000;
const providerPollInterval = Duration.seconds(60);
const zeroCatchUpGraceMillis = Duration.toMillis(providerPollInterval) + providerModifiedSinceGraceMillis;

export const providerCursorAfterRead = (cursor: number | undefined, startedAtMillis: number) =>
  Math.max(cursor ?? 0, startedAtMillis);

export const catchUpSince = (
  parameters: ReadonlyArray<WorkflowParameterValue>,
  switchedOnAt: number,
  now: number,
) => {
  const configured = Number(parameterValue(parameters, "catch-up-at-most") ?? "7");
  const days = Number.isInteger(configured) && configured >= 0 && configured <= 30 ? configured : 7;
  const windowMillis = days === 0 ? zeroCatchUpGraceMillis : days * 86_400_000;
  return Math.max(switchedOnAt, now - windowMillis);
};

export const workspaceSubscriptions = <A extends { readonly workspaces: ReadonlyArray<WorkspaceId> }>(
  workspace: WorkspaceId,
  subscriptions: ReadonlyArray<A>,
) => subscriptions.filter(({ workspaces }) => workspaces.includes(workspace));

export const isolateProviderItemRead = <A, R>(
  details: { readonly source: TriggerSourceId; readonly workspace: WorkspaceId; readonly item: string },
  read: Effect.Effect<ReadonlyArray<A>, IssueTrackerError, R>,
) =>
  read.pipe(
    Effect.catchTag("IssueTrackerError", (error) =>
      Effect.logWarning("provider item read failed; skipping item", {
        ...details,
        message: error.message,
      }).pipe(Effect.map(() => [] as ReadonlyArray<A>)),
    ),
  );

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
  `${keyOf(event.key)}:${event.entry}:${event.workspace}:${event.revision}:${JSON.stringify(event.target ?? null)}:${JSON.stringify(event.parameters ?? [])}`;

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
          Stream.repeat(Schedule.spaced(providerPollInterval)),
          Stream.flattenIterable,
        ),
      ),
    ),
  );
