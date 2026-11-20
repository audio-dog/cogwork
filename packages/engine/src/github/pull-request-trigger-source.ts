import { WorkflowCatalogKey, type WorkItemRef } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type CheckRun, isFailing } from "../ci";
import type { RegisteredWorkspace, RegistryState } from "../projector";
import {
  catchUpParameter,
  catchUpSince,
  conditionEntryKeys,
  isolateProviderItemRead,
  liveParameter,
  type ProviderPollCheckpoint,
  parameterValue,
  providerCursorAfterRead,
  providerModifiedSinceGraceMillis,
  providerPollingStream,
  providerSubject,
  triggerEntry,
  workspaceOptionReader,
  workspaceSubscriptions,
} from "../provider-trigger-source";
import type { TriggerEvent, TriggerSource, TriggerSubscription } from "../trigger-source";
import {
  type GitHubClientService,
  type RawIssueComment,
  type RawPull,
  type RawPullDetail,
  type RawPullFile,
  type RawReview,
  type RawReviewComment,
  writeAccessReviewDecision,
} from "./client";
import { trustedBotFeedback } from "./feedback";
import { hasCogworkMarker } from "./markers";
import {
  baseDivergenceOf,
  botAllowlistFrom,
  type GitHubTargetConfig,
  sourceControlTargetFor,
} from "./source-control-target";

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
    "condition",
    [],
  ),
  triggerEntry(
    "github.pull-request-conflicts-with-base",
    "Pull request conflicts with its base",
    "github",
    "pull-request",
    "condition",
    [],
  ),
  triggerEntry(
    "github.new-review-comment-from-person",
    "New review comment from a person",
    "github",
    "pull-request",
    "occurrence",
    [catchUpParameter],
  ),
  triggerEntry(
    "github.new-finding-from-bot",
    "New finding from a bot",
    "github",
    "pull-request",
    "occurrence",
    [liveParameter("bot"), catchUpParameter],
  ),
];

const personAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const conditionEntries = conditionEntryKeys(githubPullRequestEntries);

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
  ...reviews.flatMap((review) =>
    review.body.length === 0
      ? []
      : [
          {
            id: `review-${review.id}`,
            authorLogin: review.authorLogin,
            authorAssociation: review.authorAssociation,
            ...(review.authorType ? { authorType: review.authorType } : {}),
            body: review.body,
            atMillis: review.submittedAtMillis,
          },
        ],
  ),
];

const itemRef = (workspace: RegistryState["workspaces"][number], pull: RawPull): WorkItemRef => ({
  _tag: "PullRequest",
  workspace: workspace.config.id,
  number: pull.number,
});

const indented = (text: string) =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

const singleLine = (text: string) => text.replaceAll(/\s*[\r\n]+\s*/g, " ");

const checkLines = (check: CheckRun) => [
  `- ${singleLine(check.name)}: ${check.status}, ${check.conclusion ?? "no conclusion"}, ${singleLine(check.detailsUrl ?? "no details URL")}`,
  ...(isFailing(check)
    ? [
        `  - Title: ${singleLine(check.outputTitle ?? "none")}`,
        "  - Summary:",
        indented(check.outputSummary ?? "none"),
      ]
    : []),
];

const fileLine = (file: RawPullFile) =>
  `- ${singleLine(file.path)} (${file.status}, +${file.additions} -${file.deletions})`;

const listOrNone = (lines: ReadonlyArray<string>) => (lines.length === 0 ? "none" : lines.join("\n"));

const mergeabilityOf = (mergeableState: string | null) =>
  baseDivergenceOf(mergeableState) === "conflict"
    ? `${mergeableState}, conflicts with base`
    : (mergeableState ?? "unknown");

const changedFilesSection = (files: ReadonlyArray<RawPullFile> | null) =>
  files === null ? "unavailable" : listOrNone(files.map(fileLine));

interface PullRequestFacts {
  readonly detail: RawPullDetail;
  readonly checks: ReadonlyArray<CheckRun>;
  readonly reviews: ReadonlyArray<RawReview>;
  readonly files: ReadonlyArray<RawPullFile> | null;
}

const pullRequestBody = ({ detail, checks, reviews, files }: PullRequestFacts) =>
  [
    `# ${singleLine(detail.title)}`,
    "",
    detail.url,
    "",
    "## Description",
    detail.body ? indented(detail.body) : "none",
    "",
    "## Head and base",
    `- Head: ${detail.headRef}@${detail.headSha}`,
    `- Base: ${detail.baseRef ?? "unknown"}@${detail.baseSha ?? "unknown"}`,
    "",
    "## Mergeability",
    mergeabilityOf(detail.mergeableState),
    "",
    "## Review state",
    writeAccessReviewDecision(reviews),
    "",
    "## Checks",
    listOrNone(checks.flatMap(checkLines)),
    "",
    "## Changed files",
    changedFilesSection(files),
  ].join("\n");

const proseOf = (facts: PullRequestFacts, feedback: ReadonlyArray<Feedback>) => ({
  body: pullRequestBody(facts),
  comments: feedback.map((comment) => ({
    author: comment.authorLogin,
    authorAssociation: comment.authorAssociation,
    body: comment.body,
    createdAtMillis: comment.atMillis,
  })),
});

const changedFilesOf = (client: GitHubClientService, target: GitHubTargetConfig, pull: RawPull) =>
  pull.baseSha === undefined
    ? Effect.succeed(null)
    : client.listPullFiles(target, pull.baseSha, pull.headSha).pipe(Effect.orElseSucceed(() => null));

const eventsForPull = Effect.fn("GitHubPullRequestTriggerSource.eventsForPull")(function* (
  client: GitHubClientService,
  target: GitHubTargetConfig,
  workspace: RegistryState["workspaces"][number],
  selected: ReadonlyArray<TriggerSubscription>,
  pull: RawPull,
  now: number,
) {
  const [checks, detail, issueComments, reviewComments, reviews] = yield* Effect.all([
    client.listCheckRuns(target, pull.headSha),
    client.getPull(target, pull.number),
    client.listTriggerComments(target, pull.number),
    client.listReviewComments(target, pull.number),
    client.listReviews(target, pull.number),
  ]);
  const feedback = feedbackOf(issueComments, reviewComments, reviews);
  const ref = itemRef(workspace, pull);
  const subject = providerSubject(pull.title, pull.url);
  const failed = checks
    .filter(isFailing)
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
            workspace: workspace.config.id,
            subject,
          },
        ]
      : []),
    ...(selected.some(({ entry }) => entry === conflictsKey) &&
    baseDivergenceOf(detail.mergeableState) === "conflict"
      ? [
          {
            key: ref,
            revision: `conflict:${pull.headSha}:${pull.baseSha ?? "unknown"}`,
            cause: { _tag: "Unknown" } as const,
            atMillis: pull.updatedAtMillis,
            entry: conflictsKey,
            workspace: workspace.config.id,
            subject,
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
            !target.botAllowlist.has(comment.authorLogin) &&
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
              workspace: workspace.config.id,
              target: { workflow: subscription.workflow, trigger: subscription.trigger },
              subject,
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
            workspace: workspace.config.id,
            target: { workflow: subscription.workflow, trigger: subscription.trigger },
            parameters: [{ id: "bot", value: bot ?? "" }],
            subject,
          }) satisfies TriggerEvent,
      );
  });
  const events = [...conditionEvents, ...occurrenceEvents];
  if (events.length === 0) return events;
  const files = yield* changedFilesOf(client, target, pull);
  const workContext = proseOf({ detail, checks, reviews, files }, feedback);
  const pullRequest = {
    author: pull.authorLogin,
    headRef: pull.headRef,
    closingIssueNumbers: pull.closingIssueNumbers,
  };
  return events.map((event) => ({ ...event, workContext, pullRequest }));
});

const readWorkspace = Effect.fn("GitHubPullRequestTriggerSource.readWorkspace")(function* (
  client: GitHubClientService,
  cursor: number | undefined,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  workspace: RegistryState["workspaces"][number],
  now: number,
) {
  const selected = workspaceSubscriptions(workspace.config.id, subscriptions);
  const target = selected.length > 0 ? sourceControlTargetFor(workspace) : null;
  if (!target) return { events: [], cursor: cursor ?? 0, workspace: workspace.config.id };
  const actorLogin = yield* client.authenticatedLogin(target);
  const since = cursor === undefined ? 0 : Math.max(0, cursor - providerModifiedSinceGraceMillis);
  const isTrustedPull = ({ authorAssociation, authorLogin }: RawPull) =>
    authorLogin === actorLogin || personAssociations.has(authorAssociation);
  const trustedPulls = (yield* client.listPulls(target)).filter(isTrustedPull);
  const observesCondition = selected.some(({ entry }) => conditionEntries.has(entry));
  const pulls =
    cursor === undefined || observesCondition
      ? trustedPulls
      : trustedPulls.filter(({ updatedAtMillis }) => updatedAtMillis >= since);
  const events = yield* Effect.forEach(pulls, (pull) =>
    isolateProviderItemRead(
      { source: "github", workspace: workspace.config.id, item: `pull request #${pull.number}` },
      eventsForPull(client, target, workspace, selected, pull, now),
    ),
  );
  return {
    events: events.flat(),
    cursor: providerCursorAfterRead(cursor, now),
    workspace: workspace.config.id,
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
    readWorkspace(client, checkpoint.cursors.get(workspace.config.id), subscriptions, workspace, now),
  );
  return {
    events: reads.flatMap(({ events }) => events),
    cursors: new Map([
      ...checkpoint.cursors,
      ...reads.map(({ workspace, cursor }) => [workspace, cursor] as const),
    ]),
  };
});

const configuredBots = ({ config }: RegisteredWorkspace) =>
  config.sourceControl?.botAllowlist ??
  (config.issueTracker.type === "github" ? config.issueTracker.botAllowlist : undefined) ??
  [];

export const makeGitHubPullRequestTriggerSource = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
): TriggerSource => ({
  id: "github",
  entries: githubPullRequestEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  options: [
    {
      system: "github",
      readers: {
        bot: workspaceOptionReader("github", registry, (workspace) =>
          Effect.succeed(configuredBots(workspace)),
        ),
      },
    },
  ],
  observe: (subscriptions) =>
    providerPollingStream("github", (checkpoint) => read(client, registry, subscriptions, checkpoint)),
});
