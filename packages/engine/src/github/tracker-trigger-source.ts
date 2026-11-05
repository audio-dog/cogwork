import { defaultPriority, type Priority, WorkflowCatalogKey, WorkItemId } from "@cogwork/contracts";
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
import type { GitHubClientService, GitHubRepoRef, RawIssue, RawIssueComment } from "./client";
import { issueNumberOf, issuePriorities, targetFor } from "./host";
import { hasCogworkMarker } from "./markers";
import { sourceControlTargetFor } from "./source-control-target";

export const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-has-label");
export const newIssueCommentKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-comment-from-person");
const issueNotBlocked = issueNotBlockedFilter("github");
const issueFilters = [issueNotBlocked];
export const githubTrackerFilters = issueFilters.map(({ entry }) => entry);
export const githubTrackerEntries = [
  triggerEntry("github.issue-has-label", "Issue has label", "github", "issue", "condition", [
    liveParameter("label"),
  ]),
  triggerEntry(
    "github.new-comment-from-person",
    "New comment from a person",
    "github",
    "issue",
    "occurrence",
    [liveParameter("label"), catchUpParameter],
  ),
];

const itemId = Schema.decodeSync(WorkItemId);
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
  priority: Priority,
  now: number,
  artifacts: WorkflowArtifactStoreService | null,
) {
  const issueSubscriptions = selected.filter((subscription) => {
    const label = parameterValue(subscription.parameters, "label");
    return label !== undefined && issue.labels.includes(label);
  });
  const nothingToMatch = issue.state !== "open" || issueSubscriptions.length === 0;
  if (nothingToMatch) return [];
  const passes = passedFilters(issueFilters, issue);
  const needsLabels = issueSubscriptions.some(({ entry }) => entry === issueHasLabelKey);
  const needsComments = issueSubscriptions.some(({ entry }) => entry === newIssueCommentKey);
  const botAllowlist = sourceControlTargetFor(workspace)?.botAllowlist ?? new Map();
  const [history, comments] = yield* Effect.all([
    needsLabels ? client.listIssueEvents(target, issue.number) : Effect.succeed([]),
    needsComments ? client.listTriggerComments(target, issue.number) : Effect.succeed([]),
  ]);
  const issueId = itemId(`#${issue.number}`);
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
      subscription.entry === issueHasLabelKey ? [parameterValue(subscription.parameters, "label") ?? ""] : [],
    ),
  );
  const labelEvents = [...conditionLabels].map((label) => {
    const applied = history.findLast((event) => event.event === "labeled" && event.labelName === label);
    const atMillis = applied?.createdAtMillis ?? issue.createdAtMillis;
    return {
      key: {
        _tag: "Issue",
        workspace: workspace.config.name,
        id: issueId,
      },
      revision: `label:${label}:${atMillis}`,
      cause: issueCause,
      atMillis,
      entry: issueHasLabelKey,
      workspace: workspace.config.name,
      priority,
      parameters: [{ id: "label", value: label }],
      passes,
      subject,
      workContext: proseOf(issue, comments),
    } satisfies TriggerEvent;
  });
  const commentEvents = issueSubscriptions.flatMap((subscription) => {
    if (subscription.entry !== newIssueCommentKey) return [];
    const label = parameterValue(subscription.parameters, "label") ?? "";
    const switchedOnAt = subscription.catchUp?.since ?? now;
    const cutoff = catchUpSince(subscription.parameters, switchedOnAt, now);
    return comments
      .filter(
        (comment) =>
          comment.createdAtMillis > cutoff &&
          comment.authorLogin !== null &&
          comment.authorType !== "Bot" &&
          !botAllowlist.has(comment.authorLogin) &&
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
            revision: `comment:${comment.id}:label:${label}`,
            cause: { _tag: "Person" },
            atMillis: comment.createdAtMillis,
            entry: newIssueCommentKey,
            workspace: workspace.config.name,
            priority,
            target: { workflow: subscription.workflow, trigger: subscription.trigger },
            parameters: [{ id: "label", value: label }],
            passes,
            subject,
            workContext: proseOf(issue, comments),
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
  artifacts: WorkflowArtifactStoreService | null,
) {
  const selected = workspaceSubscriptions(workspace.config.name, subscriptions);
  if (selected.length === 0) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.name };
  const target = targetFor(workspace);
  if (!target) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.name };
  const since = cursor === undefined ? undefined : Math.max(0, cursor - providerModifiedSinceGraceMillis);
  const [updated, labelled] = yield* Effect.all([
    client.listIssues(target, { state: "all", ...(since === undefined ? {} : { since }) }),
    Effect.forEach(filteredLabels(selected), (label) => client.listIssues(target, { state: "open", label })),
  ]);
  const issues = [
    ...new Map([...updated, ...labelled.flat()].map((issue) => [issue.number, issue])).values(),
  ];
  const trackerIssues = issues.filter(({ isPullRequest }) => !isPullRequest);
  const priorities = yield* issuePriorities(
    client,
    target,
    trackerIssues.filter(({ state }) => state === "open"),
  );
  const events = yield* Effect.forEach(trackerIssues, (issue) =>
    isolateProviderItemRead(
      { source: "github", workspace: workspace.config.name, item: `issue #${issue.number}` },
      eventsForIssue(
        client,
        target,
        workspace,
        selected,
        issue,
        priorities.get(issue.number) ?? defaultPriority,
        now,
        artifacts,
      ),
    ),
  );
  return {
    events: events.flat(),
    cursor: providerCursorAfterRead(cursor, now),
    workspace: workspace.config.name,
  };
});

const read = Effect.fn("GitHubTrackerTriggerSource.read")(function* (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  checkpoint: ProviderPollCheckpoint,
  artifacts: WorkflowArtifactStoreService | null,
) {
  const now = yield* Clock.currentTimeMillis;
  const state = yield* registry;
  const workspaces = state.workspaces.filter(({ config }) => config.issueTracker.type === "github");
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

const recheck = Effect.fn("GitHubTrackerTriggerSource.recheck")(function* (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
  event: TriggerEvent,
  subscription: TriggerSubscription,
) {
  if (event.key._tag !== "Issue") return Recheck.Matches();
  const { id, workspace } = event.key;
  const registered = (yield* registry).workspaces.find(({ config }) => config.name === workspace);
  const target = registered ? targetFor(registered) : undefined;
  if (!target) return Recheck.Matches();
  const issue = yield* issueNumberOf(id).pipe(
    Effect.flatMap((number) => client.readIssue(target, number)),
    Effect.mapError((error) => sourceFailure("github", error)),
  );
  return recheckIssue(issueFilters, subscription, {
    id,
    open: issue.state === "open",
    labels: issue.labels,
    item: issue,
  });
});

export const makeGitHubTrackerTriggerSource = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
  artifacts: WorkflowArtifactStoreService | null = null,
): TriggerSource => {
  const label = workspaceOptionReader("github", registry, (registered) => {
    const target = targetFor(registered);
    return target ? client.listLabels(target) : Effect.succeed([]);
  });

  return {
    id: "github",
    entries: githubTrackerEntries,
    filters: githubTrackerFilters,
    availability: () => Effect.succeed({ _tag: "Available" }),
    options: [{ system: "github", readers: { label } }],
    observe: (subscriptions) =>
      providerPollingStream("github", (checkpoint) =>
        read(client, registry, subscriptions, checkpoint, artifacts),
      ),
    recheck: (event, subscription) => recheck(client, registry, event, subscription),
  };
};
