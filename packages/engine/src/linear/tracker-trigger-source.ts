import { linearTeams, WorkflowCatalogKey, type WorkflowOption, WorkItemId } from "@cogwork/contracts";
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
  providerCursorAfterRead,
  providerModifiedSinceGraceMillis,
  providerPollingStream,
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
  const prose = yield* client.readTriggerProse(target, issue.id);
  const labelEvents = yield* Effect.forEach(issueSubscriptions, (subscription) =>
    Effect.gen(function* () {
      if (subscription.entry !== issueHasLabelKey) return [];
      const label = parameterValue(subscription.parameters, "label");
      const appliedAt = label
        ? ((yield* client.labelAppliedAt(target, issue.id, label)) ??
          issue.createdAtMillis ??
          issue.updatedAtMillis)
        : (issue.createdAtMillis ?? issue.updatedAtMillis);
      return [
        {
          key: {
            _tag: "Issue",
            workspace: workspace.config.name,
            id: itemId(issue.identifier),
          },
          revision: `label:${label}:${appliedAt}`,
          cause: { _tag: "Unknown" },
          atMillis: appliedAt,
          entry: issueHasLabelKey,
          workspace: workspace.config.name,
          parameters: [{ id: "label", value: label ?? "" }],
          prose: proseOf(prose.body, prose.comments),
        } satisfies TriggerEvent,
      ];
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
            target: { workflow: subscription.workflow, trigger: subscription.trigger },
            parameters: [{ id: "label", value: label }],
            prose: proseOf(prose.body, prose.comments),
          }) satisfies TriggerEvent,
      );
  });
  return [...labelEvents.flat(), ...commentEvents];
});

const readWorkspace = Effect.fn("LinearTrackerTriggerSource.readWorkspace")(function* (
  client: LinearClientService,
  cursor: number | undefined,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  workspace: RegistryState["workspaces"][number],
  now: number,
) {
  const selected = workspaceSubscriptions(workspace.config.name, subscriptions);
  if (selected.length === 0) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.name };
  const updatedSince =
    cursor === undefined ? undefined : Math.max(0, cursor - providerModifiedSinceGraceMillis);
  const issues = yield* Effect.forEach(targetsFor(workspace), (target) =>
    client.observeIssues(target, null, null, updatedSince, true),
  );
  const events = yield* Effect.forEach(issues.flat(), (issue) =>
    eventsForIssue(client, workspace, selected, issue, now),
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
) {
  const now = yield* Clock.currentTimeMillis;
  const state = yield* registry;
  const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === "linear");
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
        client.observeIssues(target, null, null, undefined, true),
      );
      return [...new Set(issues.flat().flatMap(({ labels }) => labels))].map(
        (label) => ({ value: label, name: label, listedIn: [workspace] }) satisfies WorkflowOption,
      );
    }).pipe(Effect.mapError((error) => sourceFailure("linear", error))),
  observe: (subscriptions) =>
    providerPollingStream("linear", (checkpoint) => read(client, registry, subscriptions, checkpoint)),
});
