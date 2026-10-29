import { WorkflowCatalogKey, type WorkflowOption, WorkItemId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RegistryState } from "../projector";
import {
  catchUpParameter,
  catchUpSince,
  liveParameter,
  type ProviderPollCheckpoint,
  parameterValue,
  providerPollingStream,
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
const personAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const proseOf = (issue: RawIssue, comments: ReadonlyArray<RawIssueComment>) => ({
  body: issue.body,
  comments: comments.map((comment) => ({
    author: comment.authorLogin,
    authorAssociation: comment.authorAssociation,
    body: comment.body,
    createdAtMillis: comment.createdAtMillis,
  })),
});

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
    needsComments ? client.listTriggerComments(target, issue.number) : Effect.succeed([]),
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
          personAssociations.has(comment.authorAssociation) &&
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
  cursor: number | undefined,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  workspace: RegistryState["workspaces"][number],
  now: number,
) {
  const selected = workspaceSubscriptions(workspace.config.name, subscriptions);
  if (selected.length === 0) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.name };
  const target = targetFor(workspace);
  if (!target) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.name };
  const since = cursor === undefined ? undefined : Math.max(0, cursor - graceMillis);
  const issues = yield* client.listIssues(target, {
    state: "all",
    ...(since === undefined ? {} : { since }),
  });
  const trackerIssues = issues.filter(({ isPullRequest }) => !isPullRequest);
  const events = yield* Effect.forEach(trackerIssues, (issue) =>
    eventsForIssue(client, target, workspace, selected, issue, now),
  );
  return {
    events: events.flat(),
    cursor: Math.max(cursor ?? 0, ...issues.map((issue) => issue.updatedAtMillis ?? 0)),
    workspace: workspace.config.name,
  };
});

const read = Effect.fn("GitHubTrackerTriggerSource.read")(function* (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  checkpoint: ProviderPollCheckpoint,
) {
  const now = yield* Clock.currentTimeMillis;
  const state = yield* registry;
  const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === "github");
  const reads = yield* Effect.forEach(workspaces, (workspace) =>
    readWorkspace(client, checkpoint.cursors.get(workspace.config.name), subscriptions, workspace, now),
  );
  return {
    events: reads.flatMap(({ events }) => events),
    cursors: new Map([
      ...checkpoint.cursors,
      ...reads.map(({ workspace, cursor }) => [workspace, cursor] as const),
    ]),
  };
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
      providerPollingStream("github", (checkpoint) => read(client, registry, subscriptions, checkpoint)),
  };
};
