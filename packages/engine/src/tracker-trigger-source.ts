import { type Cause, WorkflowCatalogKey, type WorkItemId, type WorkspaceId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IssueTrackerService, ListedTrackerItem, TrackerProse } from "./issue-tracker";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import {
  catchUpParameter,
  catchUpSince,
  filteredLabels,
  isolateProviderItemRead,
  issueNotBlockedFilter,
  liveParameter,
  type ProviderPollCheckpoint,
  parameterValue,
  passedFilters,
  providerCursorAfterRead,
  providerModifiedSinceGraceMillis,
  providerPollingStream,
  providerSubject,
  recheckIssue,
  sourceFailure,
  triggerEntry,
  workspaceOptionReader,
  workspaceSubscriptions,
} from "./provider-trigger-source";
import { Recheck, type TriggerEvent, type TriggerSource, type TriggerSubscription } from "./trigger-source";
import type { WorkflowArtifactStoreService } from "./workflow-artifact-store";

type TrackerSystem = "github" | "linear";
type TrackerReads = Pick<
  IssueTrackerService,
  | "itemsChangedSince"
  | "openItemsWithLabel"
  | "readItem"
  | "readTriggerProse"
  | "labelAppliedAt"
  | "listLabels"
>;

const catalogKey = Schema.decodeSync(WorkflowCatalogKey);
const issueHasLabelKeyOf = (system: TrackerSystem) => catalogKey(`${system}.issue-has-label`);
const newCommentKeyOf = (system: TrackerSystem) => catalogKey(`${system}.new-comment-from-person`);

export const trackerTriggerEntries = (system: TrackerSystem) => [
  triggerEntry(issueHasLabelKeyOf(system), "Issue has label", system, "issue", "condition", [
    liveParameter("label"),
  ]),
  triggerEntry(newCommentKeyOf(system), "New comment from a person", system, "issue", "occurrence", [
    liveParameter("label"),
    catchUpParameter,
  ]),
];

export const trackerTriggerFilters = (system: TrackerSystem) => [issueNotBlockedFilter(system).entry];

const unknownCause: Cause = { _tag: "Unknown" };

const workContextOf = (prose: TrackerProse) => ({
  body: prose.body,
  comments: prose.comments.map(({ author, authorAssociation, body, createdAtMillis }) => ({
    author,
    authorAssociation,
    body,
    createdAtMillis,
  })),
});

const uniqueItems = (items: ReadonlyArray<ListedTrackerItem>) => [
  ...new Map(items.map((item) => [item.id, item])).values(),
];

export const makeTrackerTriggerSource = (
  system: TrackerSystem,
  issueTracker: TrackerReads,
  registry: Effect.Effect<RegistryState>,
  artifacts: WorkflowArtifactStoreService | null,
): TriggerSource => {
  const issueHasLabelKey = issueHasLabelKeyOf(system);
  const newCommentKey = newCommentKeyOf(system);
  const issueFilters = [issueNotBlockedFilter(system)];

  const originCause = (workspace: WorkspaceId, id: WorkItemId) =>
    artifacts === null
      ? Effect.succeed(unknownCause)
      : artifacts.origin(workspace, id).pipe(
          Effect.map(
            (origin): Cause =>
              origin === null
                ? unknownCause
                : { _tag: "Cogwork", origin: origin.item, lineage: origin.lineage },
          ),
          Effect.catch((error) =>
            Effect.logWarning("Workflow artifact origin read failed", { error }).pipe(
              Effect.map(() => unknownCause),
            ),
          ),
        );

  const eventsForItem = Effect.fn("TrackerTriggerSource.eventsForItem")(function* (
    workspace: RegisteredWorkspace,
    selected: ReadonlyArray<TriggerSubscription>,
    item: ListedTrackerItem,
    now: number,
  ) {
    const matching = selected.flatMap((subscription) => {
      const label = parameterValue(subscription.parameters, "label");
      return label !== undefined && item.labels.includes(label) ? [{ subscription, label }] : [];
    });
    if (!item.open || matching.length === 0) return [];
    const workspaceId = workspace.config.id;
    const prose = yield* issueTracker.readTriggerProse(workspace, item.id);
    const cause = yield* originCause(workspaceId, item.id);
    const shared = {
      key: { _tag: "Issue", workspace: workspaceId, id: item.id },
      workspace: workspaceId,
      priority: item.priority,
      passes: passedFilters(issueFilters, item),
      subject: providerSubject(item.title, item.url),
      workContext: workContextOf(prose),
    } as const;
    const conditionLabels = new Set(
      matching.flatMap(({ subscription, label }) => (subscription.entry === issueHasLabelKey ? [label] : [])),
    );
    const labelEvents = yield* Effect.forEach(conditionLabels, (label) =>
      Effect.map(issueTracker.labelAppliedAt(workspace, item.id, label), (appliedAt) => {
        const atMillis = appliedAt ?? item.createdAtMillis;
        return {
          ...shared,
          revision: `label:${label}:${atMillis}`,
          cause,
          atMillis,
          entry: issueHasLabelKey,
          parameters: [{ id: "label", value: label }],
        } satisfies TriggerEvent;
      }),
    );
    const commentEvents = matching.flatMap(({ subscription, label }) => {
      if (subscription.entry !== newCommentKey) return [];
      const cutoff = catchUpSince(subscription.parameters, subscription.catchUp?.since ?? now, now);
      return prose.comments
        .filter((comment) => comment.authoredByPerson && comment.createdAtMillis > cutoff)
        .map(
          (comment) =>
            ({
              ...shared,
              revision: `comment:${comment.id}:label:${label}`,
              cause: { _tag: "Person" },
              atMillis: comment.createdAtMillis,
              entry: newCommentKey,
              target: { workflow: subscription.workflow, trigger: subscription.trigger },
              parameters: [{ id: "label", value: label }],
            }) satisfies TriggerEvent,
        );
    });
    return [...labelEvents, ...commentEvents];
  });

  const readWorkspace = Effect.fn("TrackerTriggerSource.readWorkspace")(function* (
    cursor: number | undefined,
    subscriptions: ReadonlyArray<TriggerSubscription>,
    workspace: RegisteredWorkspace,
    now: number,
  ) {
    const workspaceId = workspace.config.id;
    const selected = workspaceSubscriptions(workspaceId, subscriptions);
    if (selected.length === 0) return { events: [], cursor: cursor ?? 0, workspace: workspaceId };
    const since = cursor === undefined ? 0 : Math.max(0, cursor - providerModifiedSinceGraceMillis);
    const [changed, labelled] = yield* Effect.all([
      issueTracker.itemsChangedSince(workspace, since),
      Effect.forEach(filteredLabels(selected), (label) => issueTracker.openItemsWithLabel(workspace, label)),
    ]);
    const events = yield* Effect.forEach(uniqueItems([...changed, ...labelled.flat()]), (item) =>
      isolateProviderItemRead(
        { source: system, workspace: workspaceId, item: item.id },
        eventsForItem(workspace, selected, item, now),
      ),
    );
    return { events: events.flat(), cursor: providerCursorAfterRead(cursor, now), workspace: workspaceId };
  });

  const read = Effect.fn("TrackerTriggerSource.read")(function* (
    subscriptions: ReadonlyArray<TriggerSubscription>,
    checkpoint: ProviderPollCheckpoint,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const state = yield* registry;
    const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === system);
    const reads = yield* Effect.forEach(workspaces, (workspace) =>
      readWorkspace(checkpoint.cursors.get(workspace.config.id), subscriptions, workspace, now),
    );
    return {
      events: reads.flatMap(({ events }) => events),
      cursors: new Map([
        ...checkpoint.cursors,
        ...reads.map(({ workspace, cursor }) => [workspace, cursor] as const),
      ]),
    };
  });

  const recheck = Effect.fn("TrackerTriggerSource.recheck")(function* (
    event: TriggerEvent,
    subscription: TriggerSubscription,
  ) {
    if (event.key._tag !== "Issue") return Recheck.Matches();
    const { id, workspace } = event.key;
    const registered = (yield* registry).workspaces.find(({ config }) => config.id === workspace);
    if (!registered) return Recheck.Matches();
    const item = yield* issueTracker
      .readItem(registered, id)
      .pipe(Effect.mapError((error) => sourceFailure(system, error)));
    if (item === null) return Recheck.Ended({ reason: `${id} no longer exists` });
    return recheckIssue(issueFilters, subscription, { id, open: item.open, labels: item.labels, item });
  });

  return {
    id: system,
    entries: trackerTriggerEntries(system),
    filters: trackerTriggerFilters(system),
    availability: () => Effect.succeed({ _tag: "Available" }),
    options: [
      { system, readers: { label: workspaceOptionReader(system, registry, issueTracker.listLabels) } },
    ],
    observe: (subscriptions) =>
      providerPollingStream(system, (checkpoint) => read(subscriptions, checkpoint)),
    recheck,
  };
};
