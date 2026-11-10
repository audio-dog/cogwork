import { type Cause, WorkflowCatalogKey, type WorkItemId, type WorkspaceId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  IssueTrackerError,
  IssueTrackerService,
  ListedTrackerItem,
  TrackerProse,
} from "./issue-tracker";
import type { RegisteredWorkspace, RegistryState, WorkspaceIssueTrackerBinding } from "./projector";
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
  triggerEntry,
  workspaceOptionReader,
  workspaceSubscriptions,
} from "./provider-trigger-source";
import type { TriggerEvent, TriggerSource, TriggerSubscription } from "./trigger-source";
import type { WorkflowArtifactStoreService } from "./workflow-artifact-store";

type TrackerSystem = "github" | "linear";
type TrackerReads = Pick<
  IssueTrackerService,
  "itemsChangedSince" | "readTriggerProse" | "labelAppliedAt" | "listLabels"
> & {
  readonly observe: (
    workspace: WorkspaceIssueTrackerBinding,
  ) => Effect.Effect<ReadonlyArray<ListedTrackerItem>, IssueTrackerError>;
};

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
  artifacts: WorkflowArtifactStoreService | null = null,
): TriggerSource => {
  const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)(`${system}.issue-has-label`);
  const newCommentKey = Schema.decodeSync(WorkflowCatalogKey)(`${system}.new-comment-from-person`);
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
    const matching = selected.filter((subscription) => {
      const label = parameterValue(subscription.parameters, "label");
      return label !== undefined && item.labels.includes(label);
    });
    if (!item.open || matching.length === 0) return [];
    const name = workspace.config.name;
    const prose = yield* issueTracker.readTriggerProse(workspace, item.id);
    const cause = yield* originCause(name, item.id);
    const shared = {
      key: { _tag: "Issue", workspace: name, id: item.id },
      workspace: name,
      priority: item.priority,
      passes: passedFilters(issueFilters, item),
      subject: providerSubject(item.title, item.url),
      workContext: workContextOf(prose),
    } as const;
    const conditionLabels = new Set(
      matching.flatMap((subscription) =>
        subscription.entry === issueHasLabelKey
          ? [parameterValue(subscription.parameters, "label") ?? ""]
          : [],
      ),
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
    const commentEvents = matching.flatMap((subscription) => {
      if (subscription.entry !== newCommentKey) return [];
      const label = parameterValue(subscription.parameters, "label") ?? "";
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
    const name = workspace.config.name;
    const selected = workspaceSubscriptions(name, subscriptions);
    if (selected.length === 0) return { events: [], cursor: cursor ?? 0, workspace: name };
    const since = cursor === undefined ? 0 : Math.max(0, cursor - providerModifiedSinceGraceMillis);
    const readsOpenItems = filteredLabels(selected).length > 0;
    const [changed, open] = yield* Effect.all([
      issueTracker.itemsChangedSince(workspace, since),
      readsOpenItems ? issueTracker.observe(workspace) : Effect.succeed([]),
    ]);
    const events = yield* Effect.forEach(uniqueItems([...changed, ...open]), (item) =>
      isolateProviderItemRead(
        { source: system, workspace: name, item: item.id },
        eventsForItem(workspace, selected, item, now),
      ),
    );
    return { events: events.flat(), cursor: providerCursorAfterRead(cursor, now), workspace: name };
  });

  const read = Effect.fn("TrackerTriggerSource.read")(function* (
    subscriptions: ReadonlyArray<TriggerSubscription>,
    checkpoint: ProviderPollCheckpoint,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const state = yield* registry;
    const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === system);
    const reads = yield* Effect.forEach(workspaces, (workspace) =>
      readWorkspace(checkpoint.cursors.get(workspace.config.name), subscriptions, workspace, now),
    );
    return {
      events: reads.flatMap(({ events }) => events),
      cursors: new Map([
        ...checkpoint.cursors,
        ...reads.map(({ workspace, cursor }) => [workspace, cursor] as const),
      ]),
    };
  });

  return {
    id: system,
    entries: [
      triggerEntry(issueHasLabelKey, "Issue has label", system, "issue", "condition", [
        liveParameter("label"),
      ]),
      triggerEntry(newCommentKey, "New comment from a person", system, "issue", "occurrence", [
        liveParameter("label"),
        catchUpParameter,
      ]),
    ],
    filters: issueFilters.map(({ entry }) => entry),
    availability: () => Effect.succeed({ _tag: "Available" }),
    options: [
      { system, readers: { label: workspaceOptionReader(system, registry, issueTracker.listLabels) } },
    ],
    observe: (subscriptions) =>
      providerPollingStream(system, (checkpoint) => read(subscriptions, checkpoint)),
  };
};
