import { linearTeams, WorkflowCatalogKey, WorkItemId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RegistryState } from "../projector";
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
} from "../provider-trigger-source";
import { Recheck, type TriggerEvent, type TriggerSource, type TriggerSubscription } from "../trigger-source";
import type { WorkflowArtifactStoreService } from "../workflow-artifact-store";
import { credentialAccountFor } from "./account";
import {
  isResolvedState,
  type LinearClientService,
  type LinearTeamRef,
  type RawComment,
  type RawIssue,
} from "./client";
import { hasCogworkMarker } from "./markers";

const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("linear.issue-has-label");
const newIssueCommentKey = Schema.decodeSync(WorkflowCatalogKey)("linear.new-comment-from-person");
const issueNotBlocked = issueNotBlockedFilter("linear");
const issueFilters = [issueNotBlocked];
export const linearTrackerFilters = issueFilters.map(({ entry }) => entry);
export const linearTrackerEntries = [
  triggerEntry("linear.issue-has-label", "Issue has label", "linear", "issue", "condition", [
    liveParameter("label"),
  ]),
  triggerEntry(
    "linear.new-comment-from-person",
    "New comment from a person",
    "linear",
    "issue",
    "occurrence",
    [liveParameter("label"), catchUpParameter],
  ),
];

const itemId = Schema.decodeSync(WorkItemId);
const targetsFor = (workspace: RegistryState["workspaces"][number]) => {
  const account = credentialAccountFor(workspace.config);
  if (workspace.config.issueTracker.type !== "linear" || account === null) return [];
  return linearTeams(workspace.config.issueTracker).map(
    (team) => ({ team, account }) satisfies LinearTeamRef,
  );
};

const targetForIssue = (workspace: RegistryState["workspaces"][number], identifier: string) =>
  targetsFor(workspace).find(({ team }) => identifier.startsWith(`${team}-`));

const proseOf = (body: string, comments: ReadonlyArray<RawComment>) => ({
  body,
  comments: comments.map((comment) => ({
    author: comment.authorId,
    authorAssociation: comment.authorAssociation,
    body: comment.body,
    createdAtMillis: comment.createdAtMillis,
  })),
});

const eventsForIssue = Effect.fn("LinearTrackerTriggerSource.eventsForIssue")(function* (
  client: LinearClientService,
  workspace: RegistryState["workspaces"][number],
  selected: ReadonlyArray<TriggerSubscription>,
  issue: RawIssue,
  now: number,
  artifacts: WorkflowArtifactStoreService | null,
) {
  const issueSubscriptions = selected.filter((subscription) => {
    const label = parameterValue(subscription.parameters, "label");
    return label !== undefined && issue.labels.includes(label);
  });
  const nothingToMatch = isResolvedState(issue.stateType) || issueSubscriptions.length === 0;
  if (nothingToMatch) return [];
  const target = targetForIssue(workspace, issue.identifier);
  if (!target) return [];
  const passes = passedFilters(issueFilters, issue);
  const prose = yield* client.readTriggerProse(target, issue.id);
  const issueId = itemId(issue.identifier);
  const subject = providerSubject(issue.title, issue.url);
  const origin =
    artifacts === null
      ? null
      : yield* artifacts
          .origin(workspace.config.name, issueId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Workflow artifact origin read failed", { error }).pipe(
                Effect.map(() => null),
              ),
            ),
          );
  const issueCause =
    origin === null
      ? ({ _tag: "Unknown" } as const)
      : ({ _tag: "Cogwork", origin: origin.item, lineage: origin.lineage } as const);
  const conditionLabels = new Set(
    issueSubscriptions.flatMap((subscription) =>
      subscription.entry === issueHasLabelKey ? [parameterValue(subscription.parameters, "label")] : [],
    ),
  );
  const labelEvents = yield* Effect.forEach(conditionLabels, (label) =>
    Effect.gen(function* () {
      const appliedAt = label
        ? ((yield* client.labelAppliedAt(target, issue.id, label)) ??
          issue.createdAtMillis ??
          issue.updatedAtMillis)
        : (issue.createdAtMillis ?? issue.updatedAtMillis);
      return {
        key: {
          _tag: "Issue",
          workspace: workspace.config.name,
          id: issueId,
        },
        revision: `label:${label}:${appliedAt}`,
        cause: issueCause,
        atMillis: appliedAt,
        entry: issueHasLabelKey,
        workspace: workspace.config.name,
        priority: issue.priority,
        parameters: [{ id: "label", value: label ?? "" }],
        passes,
        subject,
        workContext: proseOf(prose.body, prose.comments),
      } satisfies TriggerEvent;
    }),
  );
  const commentEvents = issueSubscriptions.flatMap((subscription) => {
    if (subscription.entry !== newIssueCommentKey) return [];
    const label = parameterValue(subscription.parameters, "label") ?? "";
    const cutoff = catchUpSince(subscription.parameters, subscription.catchUp?.since ?? now, now);
    return prose.comments
      .filter(
        (comment) =>
          comment.createdAtMillis > cutoff &&
          comment.authorAssociation !== "NONE" &&
          !hasCogworkMarker(comment.body),
      )
      .map(
        (comment) =>
          ({
            key: {
              _tag: "Issue",
              workspace: workspace.config.name,
              id: itemId(issue.identifier),
            },
            revision: `comment:${comment.id}:label:${label}`,
            cause: { _tag: "Person" },
            atMillis: comment.createdAtMillis,
            entry: newIssueCommentKey,
            workspace: workspace.config.name,
            priority: issue.priority,
            target: { workflow: subscription.workflow, trigger: subscription.trigger },
            parameters: [{ id: "label", value: label }],
            passes,
            subject,
            workContext: proseOf(prose.body, prose.comments),
          }) satisfies TriggerEvent,
      );
  });
  return [...labelEvents, ...commentEvents];
});

const readWorkspace = Effect.fn("LinearTrackerTriggerSource.readWorkspace")(function* (
  client: LinearClientService,
  cursor: number | undefined,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  workspace: RegistryState["workspaces"][number],
  now: number,
  artifacts: WorkflowArtifactStoreService | null,
) {
  const selected = workspaceSubscriptions(workspace.config.name, subscriptions);
  if (selected.length === 0) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.name };
  const updatedSince =
    cursor === undefined ? undefined : Math.max(0, cursor - providerModifiedSinceGraceMillis);
  const issues = yield* Effect.forEach(targetsFor(workspace), (target) =>
    Effect.all([
      client.observeIssues(target, null, null, updatedSince, true),
      Effect.forEach(filteredLabels(selected), (label) => client.observeLabelledIssues(target, label)),
    ]).pipe(Effect.map(([updated, labelled]) => [...updated, ...labelled.flat()])),
  );
  const unique = [...new Map(issues.flat().map((issue) => [issue.id, issue])).values()];
  const events = yield* Effect.forEach(unique, (issue) =>
    isolateProviderItemRead(
      { source: "linear", workspace: workspace.config.name, item: issue.identifier },
      eventsForIssue(client, workspace, selected, issue, now, artifacts),
    ),
  );
  return {
    events: events.flat(),
    cursor: providerCursorAfterRead(cursor, now),
    workspace: workspace.config.name,
  };
});

const read = Effect.fn("LinearTrackerTriggerSource.read")(function* (
  client: LinearClientService,
  registry: Effect.Effect<RegistryState>,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  checkpoint: ProviderPollCheckpoint,
  artifacts: WorkflowArtifactStoreService | null,
) {
  const now = yield* Clock.currentTimeMillis;
  const state = yield* registry;
  const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === "linear");
  const reads = yield* Effect.forEach(workspaces, (workspace) =>
    readWorkspace(
      client,
      checkpoint.cursors.get(workspace.config.name),
      subscriptions,
      workspace,
      now,
      artifacts,
    ),
  );
  return {
    events: reads.flatMap(({ events }) => events),
    cursors: new Map([
      ...checkpoint.cursors,
      ...reads.map(({ workspace, cursor }) => [workspace, cursor] as const),
    ]),
  };
});

const recheck = Effect.fn("LinearTrackerTriggerSource.recheck")(function* (
  client: LinearClientService,
  registry: Effect.Effect<RegistryState>,
  event: TriggerEvent,
  subscription: TriggerSubscription,
) {
  if (event.key._tag !== "Issue") return Recheck.Matches();
  const { id, workspace } = event.key;
  const registered = (yield* registry).workspaces.find(({ config }) => config.name === workspace);
  const target = registered ? targetForIssue(registered, id) : undefined;
  if (!target) return Recheck.Matches();
  const issue = yield* client
    .readTriggerIssue(target, id)
    .pipe(Effect.mapError((error) => sourceFailure("linear", error)));
  if (issue === null) return Recheck.Ended({ reason: `${id} no longer exists` });
  return recheckIssue(issueFilters, subscription, {
    id,
    open: !isResolvedState(issue.stateType),
    labels: issue.labels,
    item: issue,
  });
});

export const makeLinearTrackerTriggerSource = (
  client: LinearClientService,
  registry: Effect.Effect<RegistryState>,
  artifacts: WorkflowArtifactStoreService | null = null,
): TriggerSource => ({
  id: "linear",
  entries: linearTrackerEntries,
  filters: linearTrackerFilters,
  availability: () => Effect.succeed({ _tag: "Available" }),
  options: [
    {
      system: "linear",
      readers: {
        label: workspaceOptionReader("linear", registry, (registered) =>
          Effect.map(Effect.forEach(targetsFor(registered), client.listLabels), (labels) => labels.flat()),
        ),
      },
    },
  ],
  observe: (subscriptions) =>
    providerPollingStream("linear", (checkpoint) =>
      read(client, registry, subscriptions, checkpoint, artifacts),
    ),
  recheck: (event, subscription) => recheck(client, registry, event, subscription),
});
