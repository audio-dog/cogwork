import { WorkflowCatalogKey, type WorkflowOption, WorkItemId, type WorkItemRef } from "@cogwork/contracts";
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
  triggerEntry,
  workspaceSubscriptions,
} from "../provider-trigger-source";
import type { TriggerEvent, TriggerSource, TriggerSubscription } from "../trigger-source";
import type {
  GitHubClientService,
  GitHubRepoRef,
  RawIssueComment,
  RawPull,
  RawReview,
  RawReviewComment,
} from "./client";
import { trustedBotFeedback } from "./feedback";
import { hasCogworkMarker } from "./markers";
import { baseDivergenceOf, botAllowlistFrom, sourceControlTargetFor } from "./source-control-target";

const checksFailedKey = Schema.decodeSync(WorkflowCatalogKey)("github.pull-request-checks-failed");
const conflictsKey = Schema.decodeSync(WorkflowCatalogKey)("github.pull-request-conflicts-with-base");
const reviewCommentKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-review-comment-from-person");
const botFindingKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-finding-from-bot");

export const githubPullRequestEntries = [
  triggerEntry(
    "github.pull-request-checks-failed",
    "Pull request checks failed",
    "github",
    "pull-request",
    [],
  ),
  triggerEntry(
    "github.pull-request-conflicts-with-base",
    "Pull request conflicts with its base",
    "github",
    "pull-request",
    [],
  ),
  triggerEntry(
    "github.new-review-comment-from-person",
    "New review comment from a person",
    "github",
    "pull-request",
    [catchUpParameter],
  ),
  triggerEntry("github.new-finding-from-bot", "New finding from a bot", "github", "pull-request", [
    liveParameter("bot"),
    catchUpParameter,
  ]),
];

const failingConclusions = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);
const personAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const workItemId = Schema.decodeSync(WorkItemId);
const graceMillis = 30_000;

interface Feedback {
  readonly id: string;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly authorType?: string;
  readonly body: string;
  readonly atMillis: number;
  readonly inReplyToId?: number | null;
  readonly subjectType?: "line" | "file";
}

const feedbackOf = (
  comments: ReadonlyArray<RawIssueComment>,
  reviewComments: ReadonlyArray<RawReviewComment>,
  reviews: ReadonlyArray<RawReview>,
): ReadonlyArray<Feedback> => [
  ...comments.flatMap((comment) =>
    comment.authorLogin === null
      ? []
      : [
          {
            id: `issue-${comment.id}`,
            authorLogin: comment.authorLogin,
            authorAssociation: comment.authorAssociation,
            ...(comment.authorType ? { authorType: comment.authorType } : {}),
            body: comment.body,
            atMillis: comment.createdAtMillis,
          },
        ],
  ),
  ...reviewComments.map((comment) => ({
    id: `review-comment-${comment.id}`,
    authorLogin: comment.authorLogin,
    authorAssociation: comment.authorAssociation,
    ...(comment.authorType ? { authorType: comment.authorType } : {}),
    body: comment.body,
    atMillis: comment.createdAtMillis,
    inReplyToId: comment.inReplyToId,
    subjectType: comment.subjectType,
  })),
  ...reviews.flatMap((review, index) =>
    review.body.length === 0
      ? []
      : [
          {
            id: `review-${review.submittedAtMillis}-${index}`,
            authorLogin: review.authorLogin,
            authorAssociation: review.authorAssociation,
            ...(review.authorType ? { authorType: review.authorType } : {}),
            body: review.body,
            atMillis: review.submittedAtMillis,
          },
        ],
  ),
];

const itemRef = (workspace: RegistryState["workspaces"][number], pull: RawPull): WorkItemRef => {
  const closing = pull.closingIssueNumbers.at(0);
  if (closing !== undefined) {
    return { _tag: "Issue", workspace: workspace.config.name, id: workItemId(`#${closing}`) };
  }
  const linear = /^([A-Z][A-Z0-9]+-\d+)(?:-|$)/.exec(pull.headRef)?.[1];
  if (linear) return { _tag: "Issue", workspace: workspace.config.name, id: workItemId(linear) };
  const numeric = /^(\d+)(?:-|$)/.exec(pull.headRef)?.[1];
  return numeric
    ? { _tag: "Issue", workspace: workspace.config.name, id: workItemId(`#${numeric}`) }
    : { _tag: "PullRequest", workspace: workspace.config.name, number: pull.number };
};

const proseOf = (pull: RawPull, feedback: ReadonlyArray<Feedback>) => ({
  body: `Pull request #${pull.number}`,
  comments: feedback.map((comment) => ({
    author: comment.authorLogin,
    authorAssociation: comment.authorAssociation,
    body: comment.body,
    createdAtMillis: comment.atMillis,
  })),
});

const eventsForPull = Effect.fn("GitHubPullRequestTriggerSource.eventsForPull")(function* (
  client: GitHubClientService,
  target: GitHubRepoRef,
  workspace: RegistryState["workspaces"][number],
  selected: ReadonlyArray<TriggerSubscription>,
  pull: RawPull,
  now: number,
) {
  const [checks, mergeable, issueComments, reviewComments, reviews] = yield* Effect.all([
    client.listCheckRuns(target, pull.headSha),
    client.pullMergeableState(target, pull.number),
    client.listTriggerComments(target, pull.number),
    client.listReviewComments(target, pull.number),
    client.listReviews(target, pull.number),
  ]);
  const feedback = feedbackOf(issueComments, reviewComments, reviews);
  const ref = itemRef(workspace, pull);
  const prose = proseOf(pull, feedback);
  const failed = checks
    .filter(({ conclusion }) => conclusion !== null && failingConclusions.has(conclusion))
    .map(({ name, conclusion }) => `${name}:${conclusion}`)
    .toSorted();
  const conditionEvents: ReadonlyArray<TriggerEvent> = [
    ...(selected.some(({ entry }) => entry === checksFailedKey) && failed.length > 0
      ? [
          {
            key: ref,
            revision: `checks:${pull.headSha}:${failed.join(",")}`,
            cause: { _tag: "Unknown" } as const,
            atMillis: pull.updatedAtMillis,
            entry: checksFailedKey,
            workspace: workspace.config.name,
            prose,
          },
        ]
      : []),
    ...(selected.some(({ entry }) => entry === conflictsKey) && baseDivergenceOf(mergeable) === "conflict"
      ? [
          {
            key: ref,
            revision: `conflict:${pull.headSha}:${pull.baseSha ?? "unknown"}`,
            cause: { _tag: "Unknown" } as const,
            atMillis: pull.updatedAtMillis,
            entry: conflictsKey,
            workspace: workspace.config.name,
            prose,
          },
        ]
      : []),
  ];
  const occurrenceEvents = selected.flatMap((subscription): ReadonlyArray<TriggerEvent> => {
    const cutoff = catchUpSince(subscription.parameters, subscription.catchUp?.since ?? now, now);
    if (subscription.entry === reviewCommentKey) {
      return feedback
        .filter(
          (comment) =>
            comment.atMillis > cutoff &&
            comment.authorType !== "Bot" &&
            personAssociations.has(comment.authorAssociation) &&
            !hasCogworkMarker(comment.body),
        )
        .map(
          (comment) =>
            ({
              key: ref,
              revision: comment.id,
              cause: { _tag: "Person" },
              atMillis: comment.atMillis,
              entry: reviewCommentKey,
              workspace: workspace.config.name,
              prose,
            }) satisfies TriggerEvent,
        );
    }
    if (subscription.entry !== botFindingKey) return [];
    const bot = parameterValue(subscription.parameters, "bot");
    const allowlist = bot ? botAllowlistFrom([bot]) : new Map();
    return trustedBotFeedback(feedback, allowlist)
      .filter((comment) => comment.atMillis > cutoff)
      .map(
        (comment) =>
          ({
            key: ref,
            revision: comment.id,
            cause: { _tag: "Unknown" },
            atMillis: comment.atMillis,
            entry: botFindingKey,
            workspace: workspace.config.name,
            parameters: [{ id: "bot", value: bot ?? "" }],
            prose,
          }) satisfies TriggerEvent,
      );
  });
  return [...conditionEvents, ...occurrenceEvents];
});

const readWorkspace = Effect.fn("GitHubPullRequestTriggerSource.readWorkspace")(function* (
  client: GitHubClientService,
  cursor: number | undefined,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  workspace: RegistryState["workspaces"][number],
  now: number,
) {
  const selected = workspaceSubscriptions(workspace.config.name, subscriptions);
  const target = selected.length > 0 ? sourceControlTargetFor(workspace) : null;
  if (!target) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.name };
  const actorLogin = yield* client.authenticatedLogin(target);
  const since = cursor === undefined ? 0 : Math.max(0, cursor - graceMillis);
  const pulls = (yield* client.listPulls(target)).filter(
    ({ authorAssociation, authorLogin, updatedAtMillis }) =>
      (authorLogin === actorLogin || personAssociations.has(authorAssociation)) &&
      (cursor === undefined || updatedAtMillis >= since),
  );
  const events = yield* Effect.forEach(pulls, (pull) =>
    eventsForPull(client, target, workspace, selected, pull, now),
  );
  return {
    events: events.flat(),
    cursor: Math.max(cursor ?? 0, ...pulls.map(({ updatedAtMillis }) => updatedAtMillis)),
    workspace: workspace.config.name,
  };
});

const read = Effect.fn("GitHubPullRequestTriggerSource.read")(function* (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  checkpoint: ProviderPollCheckpoint,
) {
  const now = yield* Clock.currentTimeMillis;
  const state = yield* registry;
  const reads = yield* Effect.forEach(state.workspaces, (workspace) =>
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

export const makeGitHubPullRequestTriggerSource = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
): TriggerSource => ({
  id: "github",
  entries: githubPullRequestEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  listOptions: (_entry, parameter, workspace) =>
    Effect.map(registry, (state) => {
      if (parameter !== "bot" || workspace === undefined) return [];
      const registered = state.workspaces.find(({ config }) => config.name === workspace);
      const configured =
        registered?.config.sourceControl?.botAllowlist ??
        (registered?.config.issueTracker.type === "github"
          ? registered.config.issueTracker.botAllowlist
          : undefined) ??
        [];
      return configured.map(
        (bot) => ({ value: bot, name: bot, listedIn: [workspace] }) satisfies WorkflowOption,
      );
    }),
  observe: (subscriptions) =>
    providerPollingStream("github", (checkpoint) => read(client, registry, subscriptions, checkpoint)),
});
