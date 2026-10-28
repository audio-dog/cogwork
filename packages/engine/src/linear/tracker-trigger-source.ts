import { linearTeams, WorkflowCatalogKey, type WorkflowOption, WorkItemId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { RegistryState } from "../projector";
import {
  catchUpParameter,
  catchUpSince,
  liveParameter,
  parameterValue,
  pollingStream,
  sourceFailure,
  triggerEntry,
  workspaceSubscriptions,
} from "../provider-trigger-source";
import type { TriggerEvent, TriggerSource, TriggerSubscription } from "../trigger-source";
import { credentialAccountFor } from "./account";
import type { LinearClientService, LinearTeamRef, RawComment, RawIssue } from "./client";
import { hasCogworkMarker } from "./markers";

const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("linear.issue-has-label");
const newIssueCommentKey = Schema.decodeSync(WorkflowCatalogKey)("linear.new-comment-from-person");

export const linearTrackerEntries = [
  triggerEntry("linear.issue-has-label", "Issue has label", "linear", "issue", [liveParameter("label")]),
  triggerEntry("linear.new-comment-from-person", "New comment from a person", "linear", "issue", [
    liveParameter("label"),
    catchUpParameter,
  ]),
];

const itemId = Schema.decodeSync(WorkItemId);
const graceMillis = 30_000;
const batchSize = 50;

interface PollState {
  readonly first: boolean;
  readonly cursor: number;
  readonly pending: ReadonlyArray<TriggerEvent>;
}

const targetsFor = (workspace: RegistryState["workspaces"][number]) => {
  const account = credentialAccountFor(workspace.config);
  if (workspace.config.issueTracker.type !== "linear" || account === null) return [];
  return linearTeams(workspace.config.issueTracker).map(
    (team) => ({ team, account }) satisfies LinearTeamRef,
  );
};

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
) {
  const issueSubscriptions = selected.filter((subscription) => {
    const label = parameterValue(subscription.parameters, "label");
    return label !== undefined && issue.labels.includes(label);
  });
  if (issueSubscriptions.length === 0) return [];
  const target = targetsFor(workspace).find(({ team }) => issue.identifier.startsWith(`${team}-`));
  if (!target) return [];
  const prose = yield* client.readProse(target, issue.id);
  const labelEvents = issueSubscriptions.flatMap((subscription) => {
    if (subscription.entry !== issueHasLabelKey) return [];
    const label = parameterValue(subscription.parameters, "label");
    return [
      {
        key: {
          _tag: "Issue",
          workspace: workspace.config.name,
          id: itemId(issue.identifier),
        },
        revision: `label:${label}:${issue.updatedAtMillis}`,
        cause: { _tag: "Unknown" },
        atMillis: issue.updatedAtMillis,
        entry: issueHasLabelKey,
        workspace: workspace.config.name,
        parameters: [{ id: "label", value: label ?? "" }],
        prose: proseOf(prose.body, prose.comments),
      } satisfies TriggerEvent,
    ];
  });
  const commentEvents = issueSubscriptions.flatMap((subscription) => {
    if (subscription.entry !== newIssueCommentKey) return [];
    const label = parameterValue(subscription.parameters, "label");
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
            revision: `comment:${comment.id}`,
            cause: { _tag: "Person" },
            atMillis: comment.createdAtMillis,
            entry: newIssueCommentKey,
            workspace: workspace.config.name,
            parameters: [{ id: "label", value: label ?? "" }],
            prose: proseOf(prose.body, prose.comments),
          }) satisfies TriggerEvent,
      );
  });
  return [...labelEvents, ...commentEvents];
});

const readWorkspace = Effect.fn("LinearTrackerTriggerSource.readWorkspace")(function* (
  client: LinearClientService,
  current: PollState,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  workspace: RegistryState["workspaces"][number],
  now: number,
) {
  const selected = workspaceSubscriptions(workspace.config.name, subscriptions);
  if (selected.length === 0) return { events: [], cursor: current.cursor };
  const updatedSince = current.first ? undefined : Math.max(0, current.cursor - graceMillis);
  const issues = yield* Effect.forEach(targetsFor(workspace), (target) =>
    client.observeIssues(target, null, workspace.config.issueTracker.assigneeAllowlist ?? null, updatedSince),
  );
  const events = yield* Effect.forEach(issues.flat(), (issue) =>
    eventsForIssue(client, workspace, selected, issue, now),
  );
  return {
    events: events.flat(),
    cursor: Math.max(current.cursor, ...issues.flat().map(({ updatedAtMillis }) => updatedAtMillis)),
  };
});

const poll = Effect.fn("LinearTrackerTriggerSource.poll")(function* (
  client: LinearClientService,
  registry: Effect.Effect<RegistryState>,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  pollState: Ref.Ref<PollState>,
) {
  const current = yield* Ref.get(pollState);
  if (current.pending.length > 0) {
    const emitted = current.pending.slice(0, batchSize);
    yield* Ref.set(pollState, { ...current, pending: current.pending.slice(batchSize) });
    return emitted;
  }
  const now = yield* Clock.currentTimeMillis;
  const state = yield* registry;
  const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === "linear");
  const reads = yield* Effect.forEach(workspaces, (workspace) =>
    readWorkspace(client, current, subscriptions, workspace, now),
  );
  const events = [
    ...new Map(
      reads
        .flatMap(({ events }) => events)
        .map((event) => [
          `${event.entry}:${event.workspace}:${event.revision}:${JSON.stringify("parameters" in event ? (event.parameters ?? []) : [])}`,
          event,
        ]),
    ).values(),
  ].sort((left, right) => left.atMillis - right.atMillis);
  const emitted = events.slice(0, batchSize);
  yield* Ref.set(pollState, {
    first: false,
    cursor: Math.max(current.cursor, ...reads.map(({ cursor }) => cursor)),
    pending: events.slice(batchSize),
  });
  return emitted;
});

export const makeLinearTrackerTriggerSource = (
  client: LinearClientService,
  registry: Effect.Effect<RegistryState>,
): TriggerSource => ({
  id: "linear",
  entries: linearTrackerEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  listOptions: (_entry, parameter, workspace) =>
    Effect.gen(function* () {
      if (parameter !== "label" || workspace === undefined) return [];
      const state = yield* registry;
      const registered = state.workspaces.find(({ config }) => config.name === workspace);
      if (!registered) return [];
      const issues = yield* Effect.forEach(targetsFor(registered), (target) =>
        client.observeIssues(target, null),
      );
      return [...new Set(issues.flat().flatMap(({ labels }) => labels))].map(
        (label) => ({ value: label, name: label, listedIn: [workspace] }) satisfies WorkflowOption,
      );
    }).pipe(Effect.mapError((error) => sourceFailure("linear", error))),
  observe: (subscriptions) =>
    Stream.unwrap(
      Ref.make<PollState>({ first: true, cursor: 0, pending: [] }).pipe(
        Effect.map((pollState) =>
          pollingStream(
            poll(client, registry, subscriptions, pollState).pipe(
              Effect.mapError((error) => sourceFailure("linear", error)),
            ),
          ),
        ),
      ),
    ),
});
