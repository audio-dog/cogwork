import { WorkflowCatalogKey, type WorkflowOption, WorkItemId } from "@cogwork/contracts";
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
import type { GitHubClientService, GitHubRepoRef, RawIssue, RawIssueComment } from "./client";
import { targetFor } from "./host";
import { hasCogworkMarker } from "./markers";

export const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-has-label");
export const newIssueCommentKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-comment-from-person");

export const githubTrackerEntries = [
  triggerEntry("github.issue-has-label", "Issue has label", "github", "issue", [liveParameter("label")]),
  triggerEntry("github.new-comment-from-person", "New comment from a person", "github", "issue", [
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

const proseOf = (issue: RawIssue, comments: ReadonlyArray<RawIssueComment>) => ({
  body: issue.body,
  comments: comments.map((comment) => ({
    author: comment.authorLogin,
    authorAssociation: comment.authorAssociation,
    body: comment.body,
    createdAtMillis: comment.createdAtMillis,
  })),
});

const uniqueEvents = (events: ReadonlyArray<TriggerEvent>) => [
  ...new Map(
    events.map((event) => [
      `${event.entry}:${event.workspace}:${event.revision}:${JSON.stringify("parameters" in event ? (event.parameters ?? []) : [])}`,
      event,
    ]),
  ).values(),
];

const eventsForIssue = Effect.fn("GitHubTrackerTriggerSource.eventsForIssue")(function* (
  client: GitHubClientService,
  target: GitHubRepoRef,
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
  const needsLabels = issueSubscriptions.some(({ entry }) => entry === issueHasLabelKey);
  const needsComments = issueSubscriptions.some(({ entry }) => entry === newIssueCommentKey);
  const [history, comments] = yield* Effect.all([
    needsLabels ? client.listIssueEvents(target, issue.number) : Effect.succeed([]),
    needsComments ? client.listAllComments(target, issue.number) : Effect.succeed([]),
  ]);
  const labelEvents = issueSubscriptions.flatMap((subscription) => {
    if (subscription.entry !== issueHasLabelKey) return [];
    const label = parameterValue(subscription.parameters, "label");
    const applied = history.findLast((event) => event.event === "labeled" && event.labelName === label);
    const atMillis = applied?.createdAtMillis ?? issue.createdAtMillis;
    return [
      {
        key: {
          _tag: "Issue",
          workspace: workspace.config.name,
          id: itemId(`#${issue.number}`),
        },
        revision: `label:${label}:${atMillis}`,
        cause: { _tag: "Unknown" },
        atMillis,
        entry: issueHasLabelKey,
        workspace: workspace.config.name,
        parameters: [{ id: "label", value: label ?? "" }],
        prose: proseOf(issue, comments),
      } satisfies TriggerEvent,
    ];
  });
  const commentEvents = issueSubscriptions.flatMap((subscription) => {
    if (subscription.entry !== newIssueCommentKey) return [];
    const label = parameterValue(subscription.parameters, "label");
    const switchedOnAt = subscription.catchUp?.since ?? now;
    const cutoff = catchUpSince(subscription.parameters, switchedOnAt, now);
    return comments
      .filter(
        (comment) =>
          comment.createdAtMillis > cutoff &&
          comment.authorLogin !== null &&
          comment.authorType !== "Bot" &&
          !hasCogworkMarker(comment.body),
      )
      .map(
        (comment) =>
          ({
            key: {
              _tag: "Issue",
              workspace: workspace.config.name,
              id: itemId(`#${issue.number}`),
            },
            revision: `comment:${comment.id}`,
            cause: { _tag: "Person" },
            atMillis: comment.createdAtMillis,
            entry: newIssueCommentKey,
            workspace: workspace.config.name,
            parameters: [{ id: "label", value: label ?? "" }],
            prose: proseOf(issue, comments),
          }) satisfies TriggerEvent,
      );
  });
  return [...labelEvents, ...commentEvents];
});

const readWorkspace = Effect.fn("GitHubTrackerTriggerSource.readWorkspace")(function* (
  client: GitHubClientService,
  current: PollState,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  workspace: RegistryState["workspaces"][number],
  now: number,
) {
  const selected = workspaceSubscriptions(workspace.config.name, subscriptions);
  if (selected.length === 0) return { events: [], cursor: current.cursor };
  const target = targetFor(workspace);
  if (!target) return { events: [], cursor: current.cursor };
  const since = current.first ? undefined : Math.max(0, current.cursor - graceMillis);
  const issues = yield* client.listIssues(target, {
    state: "all",
    ...(since === undefined ? {} : { since }),
  });
  const allowed = workspace.config.issueTracker.assigneeAllowlist;
  const observed = allowed
    ? issues.filter(({ assignees }) => assignees.some((assignee) => allowed.includes(assignee)))
    : issues;
  const events = yield* Effect.forEach(observed, (issue) =>
    eventsForIssue(client, target, workspace, selected, issue, now),
  );
  return {
    events: events.flat(),
    cursor: Math.max(current.cursor, ...issues.map((issue) => issue.updatedAtMillis ?? 0)),
  };
});

const poll = Effect.fn("GitHubTrackerTriggerSource.poll")(function* (
  client: GitHubClientService,
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
  const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === "github");
  const reads = yield* Effect.forEach(workspaces, (workspace) =>
    readWorkspace(client, current, subscriptions, workspace, now),
  );
  const events = uniqueEvents(reads.flatMap(({ events }) => events)).sort(
    (left, right) => left.atMillis - right.atMillis,
  );
  const emitted = events.slice(0, batchSize);
  yield* Ref.set(pollState, {
    first: false,
    cursor: Math.max(current.cursor, ...reads.map(({ cursor }) => cursor)),
    pending: events.slice(batchSize),
  });
  return emitted;
});

export const makeGitHubTrackerTriggerSource = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
): TriggerSource => {
  const listOptions: TriggerSource["listOptions"] = (_entry, parameter, workspace) =>
    Effect.gen(function* () {
      if (parameter !== "label" || workspace === undefined) return [];
      const state = yield* registry;
      const registered = state.workspaces.find(({ config }) => config.name === workspace);
      const target = registered ? targetFor(registered) : null;
      if (!target) return [];
      const issues = yield* client.listIssues(target);
      return [...new Set(issues.flatMap(({ labels }) => labels))].map(
        (label) => ({ value: label, name: label, listedIn: [workspace] }) satisfies WorkflowOption,
      );
    }).pipe(Effect.mapError((error) => sourceFailure("github", error)));

  return {
    id: "github",
    entries: githubTrackerEntries,
    availability: () => Effect.succeed({ _tag: "Available" }),
    listOptions,
    observe: (subscriptions) =>
      Stream.unwrap(
        Ref.make<PollState>({ first: true, cursor: 0, pending: [] }).pipe(
          Effect.map((pollState) =>
            pollingStream(
              poll(client, registry, subscriptions, pollState).pipe(
                Effect.mapError((error) => sourceFailure("github", error)),
              ),
            ),
          ),
        ),
      ),
  };
};
