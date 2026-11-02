import {
  WorkflowActionArtifact,
  type WorkflowActionOrigin,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowOptionList,
  WorkflowTemplate,
  type WorkItem,
  WorkItemId,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { checkState, latestFailingCheckAtMillis } from "../ci";
import type { PrReview } from "../follow-up";
import { IssueTrackerError } from "../issue-tracker";
import type { RegisteredWorkspace, RegistryState } from "../projector";
import { WorkspaceRegistry } from "../registry";
import {
  type PrSignals,
  type PullRequestContext,
  type PullRequestReviewEvent,
  type PullRequestReviewInput,
  type ResolvedPullRequest,
  SourceControlProvider,
  type SourceControlProviderService,
} from "../source-control";
import type { WorkflowCatalogContribution } from "../workflow-catalog";
import { branchBelongsToTicketSlug, branchName, ticketSlug } from "../worktree";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawIssueComment,
  type RawPull,
  type RawReview,
  type RawReviewComment,
  type ReviewDecision,
  reviewDecisionOf,
} from "./client";
import { trustedBotFeedback } from "./feedback";
import { agentNoteMarker, hasCogworkMarker, wireCodec } from "./markers";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";
import {
  type BotAllowlist,
  baseDivergenceOf,
  type GitHubTargetConfig,
  sourceControlTargetFor,
} from "./source-control-target";

export { baseDivergenceOf } from "./source-control-target";

const catalogKey = Schema.decodeSync(WorkflowCatalogKey);
const decodeTemplate = Schema.decodeUnknownSync(WorkflowTemplate);

const reviewerParameter = {
  id: "reviewer",
  required: true,
  source: "live",
  values: [],
} satisfies WorkflowCatalogEntry["parameters"][number];

const reviewEventParameter = {
  id: "event",
  required: true,
  source: "fixed",
  values: ["approve", "comment", "request-changes"],
} satisfies WorkflowCatalogEntry["parameters"][number];

const sourceControlAction = (
  id: string,
  name: string,
  permissionProfile: WorkflowCatalogEntry["permissionProfile"],
  agentInputs: ReadonlyArray<string>,
  parameters: WorkflowCatalogEntry["parameters"] = [],
  actsOn: ReadonlyArray<string> = ["issue", "pull-request"],
) =>
  ({
    key: catalogKey(`github.${id}`),
    name,
    kind: "action",
    system: "github",
    connection: "github",
    requires: [],
    parameters,
    itemKind: null,
    actsOn,
    requiresWorkspace: true,
    permissionProfile,
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

export const githubSourceControlActionEntries = [
  sourceControlAction(
    "open-pull-request",
    "Open a pull request",
    "full",
    ["pr_title", "pr_body"],
    [],
    ["issue"],
  ),
  sourceControlAction("push-to-this-pull-request", "Push to this pull request", "full", []),
  sourceControlAction("comment-on-this-pull-request", "Comment on this pull request", "read-only", [
    "comment",
  ]),
  sourceControlAction("request-review", "Request a review", "read-only", [], [reviewerParameter]),
  sourceControlAction(
    "comment-on-named-pull-request",
    "Comment on a named pull request",
    "read-only",
    ["pull_request", "comment_body"],
    [],
    ["*"],
  ),
  sourceControlAction(
    "post-review",
    "Post a review",
    "read-only",
    ["pull_request", "review_body", "review_comments"],
    [reviewEventParameter],
    ["*"],
  ),
  sourceControlAction(
    "draft-review",
    "Draft a review",
    "read-only",
    ["pull_request", "review_body", "review_comments"],
    [],
    ["*"],
  ),
] as const;

export const slackReviewTemplate = decodeTemplate({
  id: "slack-to-github-review",
  name: "Slack → Review",
  description: "Review a GitHub pull request when someone asks in Slack.",
  document: {
    name: "Slack → Review",
    workspaces: { _tag: "Every" },
    triggers: [
      {
        id: "slack-mention",
        entry: "slack.i-am-mentioned",
        parameters: [],
        start: "classify",
      },
    ],
    operations: [
      {
        id: "classify",
        name: "Classify",
        instructionPackage: null,
        instruction:
          "Decide whether the Slack message asks for a pull request review, asks a question, or needs no action.",
        permissionProfile: "read-only",
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [
          {
            id: "ask",
            text: "What does the Slack message ask for?",
            choices: [
              { id: "review-request", name: "Review request" },
              { id: "question", name: "Question" },
              { id: "not-actionable", name: "Not actionable" },
            ],
          },
        ],
        transitions: [
          {
            when: [{ question: "ask", choice: "review-request" }],
            actions: [
              { entry: "slack.add-reaction", parameters: [{ id: "emoji", value: "eyes" }] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: "review",
          },
          {
            when: [{ question: "ask", choice: "question" }],
            actions: [{ entry: "slack.draft-reply-in-slack", parameters: [] }],
            handOff: null,
          },
          {
            when: [{ question: "ask", choice: "not-actionable" }],
            actions: [{ entry: "cogwork.stop", parameters: [] }],
            handOff: null,
          },
        ],
        hints: [{ field: "reply", text: "Say that you are reviewing the pull request." }],
      },
      {
        id: "review",
        name: "Review",
        instructionPackage: null,
        instruction:
          "Read the pull request named in the Slack thread. Review the frozen commit and choose a verdict.",
        permissionProfile: "read-only",
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [
          {
            id: "verdict",
            text: "What is the review verdict?",
            choices: [
              { id: "approve", name: "Approve" },
              { id: "comment", name: "Comment" },
              { id: "request-changes", name: "Request changes" },
              { id: "cannot-review", name: "Cannot review" },
            ],
          },
        ],
        transitions: [
          {
            when: [{ question: "verdict", choice: "approve" }],
            actions: [
              { entry: "github.post-review", parameters: [{ id: "event", value: "approve" }] },
              { entry: "cogwork.wait-for-approval", parameters: [] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: null,
          },
          {
            when: [{ question: "verdict", choice: "comment" }],
            actions: [
              { entry: "github.post-review", parameters: [{ id: "event", value: "comment" }] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: null,
          },
          {
            when: [{ question: "verdict", choice: "request-changes" }],
            actions: [
              {
                entry: "github.post-review",
                parameters: [{ id: "event", value: "request-changes" }],
              },
              { entry: "cogwork.wait-for-approval", parameters: [] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: null,
          },
          {
            when: [{ question: "verdict", choice: "cannot-review" }],
            actions: [{ entry: "cogwork.hand-to-me", parameters: [] }],
            handOff: null,
          },
        ],
        hints: [
          { field: "pull_request", text: "Name the pull request from the Slack thread." },
          { field: "reply", text: "Say that you reviewed the pull request." },
        ],
      },
    ],
  },
});

interface GitHubTarget extends GitHubTargetConfig {
  readonly actorLogin: string;
}

const missingSourceControlTarget = () =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message: "GitHub source control target is not configured",
  });

const sourceControlTarget = (workspace: RegisteredWorkspace) => {
  const target = sourceControlTargetFor(workspace);
  return target ? Effect.succeed(target) : Effect.fail(missingSourceControlTarget());
};

export const branchBelongsToSlug = branchBelongsToTicketSlug;

export const prReview = (pull: RawPull, decision: ReviewDecision): PrReview => {
  if (pull.draft) return "pending";
  if (decision === "changes-requested") return "changes-requested";
  if (decision === "approved") return "ready";
  return "pending";
};

const freshPattern = /\/fresh\b/i;
const numericIssue = /^#(\d+)$/;

const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type Feedback = Pick<RawReviewComment, "authorLogin" | "authorAssociation" | "body" | "createdAtMillis">;

// An allowlisted login is always the trusted-bot path, never the human one, even if it reports write
// access — that keeps a bot from ever setting `/fresh` or resetting the no-progress counter.
const isHumanFeedback = (feedback: Feedback, botAllowlist: BotAllowlist) =>
  writeAccess.has(feedback.authorAssociation) &&
  !botAllowlist.has(feedback.authorLogin) &&
  !hasCogworkMarker(feedback.body);

const isPullRequestFeedback = (
  comment: RawIssueComment,
): comment is RawIssueComment & { readonly authorLogin: string } =>
  comment.authorLogin !== null && comment.body.length > 0;

export const reviewFeedback = (reviews: ReadonlyArray<RawReview>) =>
  reviews.flatMap((review) =>
    review.body
      ? [
          {
            authorLogin: review.authorLogin,
            authorAssociation: review.authorAssociation,
            body: review.body,
            createdAtMillis: review.submittedAtMillis,
          },
        ]
      : [],
  );

const newestOf = (feedback: ReadonlyArray<Feedback>) =>
  feedback.reduce<Feedback | null>(
    (max, item) => (max && max.createdAtMillis >= item.createdAtMillis ? max : item),
    null,
  );

export const humanCommentSignal = (feedback: ReadonlyArray<Feedback>, botAllowlist: BotAllowlist) => {
  const newest = newestOf(feedback.filter((item) => isHumanFeedback(item, botAllowlist)));
  return {
    latestAtMillis: newest?.createdAtMillis ?? null,
    fresh: newest ? freshPattern.test(newest.body) : false,
  };
};

// Returns no `fresh` flag: `/fresh` restarts stay human-only, so a bot can never trigger one.
export const botTriggerSignal = (
  reviewComments: ReadonlyArray<RawReviewComment>,
  pullRequestFeedback: ReadonlyArray<Feedback>,
  botAllowlist: BotAllowlist,
) => {
  // Bot-specific HTML markers are private strings; GitHub's comment and thread shape is the stable boundary.
  const newest = newestOf(trustedBotFeedback([...reviewComments, ...pullRequestFeedback], botAllowlist));
  return { latestAtMillis: newest?.createdAtMillis ?? null };
};

const make = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
): SourceControlProviderService => {
  const authenticatedTarget = Effect.fn("github.authenticatedSourceControlTarget")(function* (
    target: GitHubTargetConfig,
  ) {
    const actorLogin = yield* client.authenticatedLogin(target);
    return { ...target, actorLogin } satisfies GitHubTarget;
  });

  const observePr = Effect.fn("github.observePr")(function* (target: GitHubTarget, pull: RawPull) {
    const [checks, comments, reviewComments, reviews, mergeableState] = yield* Effect.all([
      client.listCheckRuns(target, pull.headSha),
      client.listComments(target, pull.number),
      client.listReviewComments(target, pull.number),
      client.listReviews(target, pull.number),
      client.pullMergeableState(target, pull.number),
    ]);
    const decision = reviewDecisionOf(
      reviews
        .filter((review) => writeAccess.has(review.authorAssociation))
        .map((review) => ({ login: review.authorLogin, state: review.state })),
    );
    const pullRequestFeedback = [...comments.filter(isPullRequestFeedback), ...reviewFeedback(reviews)];
    const feedback = [...pullRequestFeedback, ...reviewComments];
    const human = humanCommentSignal(feedback, target.botAllowlist);
    const bot = botTriggerSignal(reviewComments, pullRequestFeedback, target.botAllowlist);
    const observedAtMillis = yield* Clock.currentTimeMillis;
    return {
      number: pull.number,
      url: pull.url,
      review: prReview(pull, decision),
      checks: checkState(checks),
      latestHumanCommentAtMillis: human.latestAtMillis,
      latestBotTriggerAtMillis: bot.latestAtMillis,
      latestFailingCheckAtMillis: latestFailingCheckAtMillis(checks),
      observedAtMillis,
      fresh: human.fresh,
      baseDivergence: baseDivergenceOf(mergeableState),
      waitingSinceMillis: pull.updatedAtMillis,
      headRef: pull.headRef,
      followable: pull.headRepository?.toLowerCase() === `${target.owner}/${target.name}`.toLowerCase(),
      draft: pull.draft,
    } satisfies PrSignals;
  });

  const daemonPull = (target: GitHubTarget, pull: RawPull) =>
    pull.authorLogin === target.actorLogin || writeAccess.has(pull.authorAssociation);

  // The final key is the PR number: the higher number is the newer PR, since GitHub numbers them in
  // creation order.
  const closesItem = (item: WorkItem, pull: RawPull) => {
    const match = numericIssue.exec(item.id);
    return match ? pull.closingIssueNumbers.includes(Number(match[1])) : false;
  };

  const sameRepositoryHead = (target: GitHubRepoRef, pull: RawPull) =>
    pull.headRepository?.toLowerCase() === `${target.owner}/${target.name}`.toLowerCase();

  const exactHeadPull = (target: GitHubRepoRef, headBranch: string, pulls: ReadonlyArray<RawPull>) =>
    pulls.find((pull) => pull.headRef === headBranch && sameRepositoryHead(target, pull)) ?? null;

  const rank = (target: GitHubTarget, item: WorkItem, branch: string, pull: RawPull) =>
    [
      sameRepositoryHead(target, pull) ? 1 : 0,
      pull.draft ? 0 : 1,
      closesItem(item, pull) ? 1 : 0,
      pull.headRef === branch ? 1 : 0,
      pull.authorLogin === target.actorLogin ? 1 : 0,
      pull.number,
    ] as const;

  const outranks = (target: GitHubTarget, item: WorkItem, branch: string, a: RawPull, b: RawPull) => {
    const [aSameRepository, aNonDraft, aClosing, aExact, aBot, aNumber] = rank(target, item, branch, a);
    const [bSameRepository, bNonDraft, bClosing, bExact, bBot, bNumber] = rank(target, item, branch, b);
    if (aSameRepository !== bSameRepository) return aSameRepository > bSameRepository;
    if (aNonDraft !== bNonDraft) return aNonDraft > bNonDraft;
    if (aClosing !== bClosing) return aClosing > bClosing;
    if (aExact !== bExact) return aExact > bExact;
    if (aBot !== bBot) return aBot > bBot;
    return aNumber > bNumber;
  };

  const linkedPull = (target: GitHubTarget, item: WorkItem, trusted: ReadonlyArray<RawPull>) => {
    const slug = ticketSlug(item.id);
    const branch = branchName(item);
    const better = (best: RawPull | null, pull: RawPull) => {
      if (!closesItem(item, pull) && !branchBelongsToSlug(pull.headRef, slug)) return best;
      if (best === null) return pull;
      return outranks(target, item, branch, pull, best) ? pull : best;
    };
    return trusted.reduce<RawPull | null>(better, null);
  };

  // The pulls the daemon trusts to act on: those it authored or that a write-access account opened.
  const trustedPulls = Effect.fn("github.trustedPulls")(function* (target: GitHubTarget) {
    const pulls = yield* client.listPulls(target);
    return pulls.filter((pull) => daemonPull(target, pull));
  });

  const observeItems = Effect.fn("github.observeItems")(function* (
    target: GitHubTarget,
    workItems: ReadonlyArray<WorkItem>,
  ) {
    const trusted = yield* trustedPulls(target);
    const matches = workItems.flatMap((item) => {
      const pull = linkedPull(target, item, trusted);
      return pull ? [[item.id, pull] as const] : [];
    });
    const entries = yield* Effect.forEach(
      matches,
      ([id, pull]) => Effect.map(observePr(target, pull), (signals) => [id, signals] as const),
      { concurrency: 10 },
    );
    return new Map<WorkItemId, PrSignals>(entries);
  });

  // The marker rides on every comment the provider posts, so it is structurally impossible to write
  // an unmarked daemon comment here — the engine owns the marker, and the agent never touches it.
  const markedBody = (body: string) => `${body}\n\n${agentNoteMarker}`;

  const commentOnPull = Effect.fn("github.commentOnPull")(function* (
    target: GitHubTarget,
    item: WorkItem,
    body: string,
  ) {
    const trusted = yield* trustedPulls(target);
    const pull = linkedPull(target, item, trusted);
    if (!pull) {
      return yield* Effect.logWarning("no linked pull request to comment on", {
        owner: target.owner,
        name: target.name,
        item: item.id,
      });
    }
    yield* client.createComment(target, pull.number, markedBody(body));
  });

  const writeMarker = (writeKey: string) =>
    wireCodec.encode({ name: "write", pairs: `key=${encodeURIComponent(writeKey)}` });

  const carriesWriteKey = (body: string, writeKey: string) =>
    wireCodec
      .scan(body)
      .some(({ name, pairs }) => name === "write" && pairs === `key=${encodeURIComponent(writeKey)}`);

  const workflowMarkedBody = (body: string, writeKey: string) =>
    [body.trim(), writeMarker(writeKey)].filter((part) => part.length > 0).join("\n\n");

  const workflowArtifact = (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    origin: WorkflowActionOrigin,
  ) =>
    WorkflowActionArtifact.make({
      workspace: workspace.config.name,
      issue: WorkItemId.make(`#${pullRequest.number}`),
      url: pullRequest.url,
      origin,
    });

  const resolvedPull = (workspace: RegisteredWorkspace, pull: RawPull): ResolvedPullRequest => ({
    number: pull.number,
    url: pull.url,
    headBranch: pull.headRef,
    baseBranch: pull.baseRef ?? workspace.config.worktrees?.baseBranch ?? "main",
  });

  const pullNumberFromReference = (
    workspace: RegisteredWorkspace,
    target: GitHubRepoRef,
    reference: string,
  ) => {
    const prefix = `${workspace.config.name}:`;
    const raw = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
    const numeric = /^#?(\d+)$/.exec(raw)?.[1];
    if (numeric) return Number(numeric);
    if (!URL.canParse(raw)) return null;
    const url = new URL(raw);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    const sameRepository =
      url.origin === "https://github.com" &&
      match?.[1]?.toLowerCase() === target.owner.toLowerCase() &&
      match?.[2]?.toLowerCase() === target.name.toLowerCase();
    return sameRepository && match?.[3] ? Number(match[3]) : null;
  };

  const readPullRequest = Effect.fn("github.readPullRequest")(function* (
    workspace: RegisteredWorkspace,
    reference: string,
  ) {
    const target = yield* sourceControlTarget(workspace);
    const number = pullNumberFromReference(workspace, target, reference.trim());
    if (number === null) return null;
    const pull = yield* client.getPull(target, number);
    if (!pull.baseSha) {
      return yield* new IssueTrackerError({
        reason: "unavailable",
        retryable: true,
        message: `Pull request #${number} has no base commit`,
      });
    }
    const [diff, changedFiles, issueComments, reviewComments, reviews] = yield* Effect.all([
      client.getPullDiff(target, pull.baseSha, pull.headSha),
      client.listPullFiles(target, pull.baseSha, pull.headSha),
      client.listAllComments(target, number),
      client.listReviewComments(target, number),
      client.listReviews(target, number),
    ]);
    const comments = [
      ...issueComments.map(({ authorLogin, body }) => ({
        author: authorLogin ?? "unknown",
        body,
        path: null,
        line: null,
      })),
      ...reviews.flatMap(({ authorLogin, body }) =>
        body ? [{ author: authorLogin, body, path: null, line: null }] : [],
      ),
      ...reviewComments.map(({ authorLogin, body, path, line }) => ({
        author: authorLogin,
        body,
        path: path ?? null,
        line: line ?? null,
      })),
    ];
    return {
      ...resolvedPull(workspace, pull),
      headSha: pull.headSha,
      title: pull.title,
      description: pull.body,
      diff,
      changedFiles,
      comments,
    } satisfies PullRequestContext;
  });

  const pullForItem = (target: GitHubTarget, item: WorkItemRef, pulls: ReadonlyArray<RawPull>) =>
    WorkItemRef.match(item, {
      Issue: ({ id }) =>
        linkedPull(
          target,
          { id, title: "" },
          pulls.filter(({ authorLogin }) => authorLogin === target.actorLogin),
        ),
      PullRequest: ({ number }) => pulls.find((pull) => pull.number === number) ?? null,
      GranolaNote: () => null,
      SlackMessage: () => null,
      SlackConversation: () => null,
      ScheduleInstant: () => null,
      FanOutChild: () => null,
    });

  const resolvePullRequest = Effect.fn("github.resolvePullRequest")(function* (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
  ) {
    const configuredTarget = yield* sourceControlTarget(workspace);
    const target = yield* authenticatedTarget(configuredTarget);
    const pulls = (yield* trustedPulls(target)).filter((pull) => sameRepositoryHead(target, pull));
    const pull = pullForItem(target, item, pulls);
    return pull ? resolvedPull(workspace, pull) : null;
  });

  const commentsCarry = (target: GitHubTarget, pullNumber: number, writeKey: string) =>
    client
      .listAllComments(target, pullNumber)
      .pipe(
        Effect.map((comments) =>
          comments.some(
            ({ authorLogin, body }) => authorLogin === target.actorLogin && carriesWriteKey(body, writeKey),
          ),
        ),
      );

  const markPullRequest = Effect.fn("github.markWorkflowPullRequest")(function* (
    target: GitHubTarget,
    pullNumber: number,
    writeKey: string,
  ) {
    if (yield* commentsCarry(target, pullNumber, writeKey)) return;
    yield* client.createComment(target, pullNumber, writeMarker(writeKey));
  });

  const reviewsCarry = (target: GitHubTarget, pullNumber: number, writeKey: string) =>
    client
      .listReviews(target, pullNumber)
      .pipe(
        Effect.map((reviews) =>
          reviews.some(
            ({ authorLogin, body }) => authorLogin === target.actorLogin && carriesWriteKey(body, writeKey),
          ),
        ),
      );

  const reviewEvents = {
    approve: "APPROVE",
    comment: "COMMENT",
    "request-changes": "REQUEST_CHANGES",
  } as const satisfies Record<PullRequestReviewEvent, "APPROVE" | "COMMENT" | "REQUEST_CHANGES">;

  const writeReview = Effect.fn("github.writeReview")(function* (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    event: PullRequestReviewEvent | null,
    input: PullRequestReviewInput,
    origin: WorkflowActionOrigin,
  ) {
    const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
    if (!(yield* reviewsCarry(target, pullRequest.number, origin.writeKey))) {
      yield* client.createReview(target, pullRequest.number, {
        commitId: input.commitId,
        body: workflowMarkedBody(input.body, origin.writeKey),
        comments: input.comments,
        event: event === null ? null : reviewEvents[event],
      });
    }
    return workflowArtifact(workspace, pullRequest, origin);
  });

  const writePullRequestComment = Effect.fn("github.writePullRequestComment")(function* (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    body: string,
    origin: WorkflowActionOrigin,
  ) {
    const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
    if (!(yield* commentsCarry(target, pullRequest.number, origin.writeKey))) {
      yield* client.createComment(target, pullRequest.number, workflowMarkedBody(body, origin.writeKey));
    }
    return workflowArtifact(workspace, pullRequest, origin);
  });

  const contribution: WorkflowCatalogContribution = {
    entries: githubSourceControlActionEntries,
    templates: [slackReviewTemplate],
    listOptions: (entry, parameter, workspaces) => {
      const listsReviewers = entry === catalogKey("github.request-review") && parameter === "reviewer";
      if (!listsReviewers) return Effect.succeed([]);
      return registry.pipe(
        Effect.flatMap((state) =>
          Effect.forEach(workspaces, (workspaceId) => {
            const workspace = state.workspaces.find(({ config }) => config.name === workspaceId);
            const target = workspace ? sourceControlTargetFor(workspace) : null;
            if (!target) return Effect.succeed([]);
            return client.listCollaborators(target).pipe(
              Effect.map((reviewers) =>
                reviewers.map((reviewer) => ({
                  value: reviewer,
                  name: reviewer,
                  listedIn: [workspaceId],
                })),
              ),
              Effect.catchTag("IssueTrackerError", () => Effect.succeed([])),
            );
          }),
        ),
        Effect.map((listed) => {
          const byReviewer = listed.flat().reduce((options, option) => {
            const current = options.get(option.value);
            return options.set(option.value, {
              ...option,
              listedIn: [...new Set([...(current?.listedIn ?? []), ...option.listedIn])],
            });
          }, new Map<string, WorkflowOptionList[number]>());
          return [...byReviewer.values()];
        }),
      );
    },
  };

  const empty: ReadonlyMap<WorkItemId, PrSignals> = new Map();

  return {
    triggerSources: [makeGitHubPullRequestTriggerSource(client, registry)],
    workflowCatalogContribution: contribution,
    observe: (workspace, workItems) =>
      Effect.gen(function* () {
        const configuredTarget = sourceControlTargetFor(workspace);
        if (!configuredTarget || workItems.length === 0) return empty;
        const target = yield* authenticatedTarget(configuredTarget);
        return yield* observeItems(target, workItems);
      }),
    comment: (workspace, item, body) =>
      Effect.gen(function* () {
        const configuredTarget = sourceControlTargetFor(workspace);
        if (!configuredTarget) return;
        const target = yield* authenticatedTarget(configuredTarget);
        yield* commentOnPull(target, item, body);
      }),
    findOpenPullRequest: Effect.fn("github.findOpenPullRequest")(function* (workspace, headBranch) {
      const target = yield* sourceControlTarget(workspace);
      const pulls = yield* client.listPulls(target, headBranch);
      const pull = exactHeadPull(target, headBranch, pulls);
      return pull ? { number: pull.number, url: pull.url } : null;
    }),
    openPullRequest: (workspace, input) =>
      Effect.gen(function* () {
        const target = yield* sourceControlTarget(workspace);
        return yield* client.createPull(target, input);
      }),
    resolvePullRequest,
    readPullRequest,
    openWorkflowPullRequest: (workspace, input) =>
      Effect.gen(function* () {
        const configuredTarget = yield* sourceControlTarget(workspace);
        const target = yield* authenticatedTarget(configuredTarget);
        const existing = yield* client
          .listPulls(target, input.headBranch)
          .pipe(
            Effect.map(
              (pulls) =>
                pulls.find(
                  (pull) =>
                    pull.headRef === input.headBranch &&
                    pull.baseRef === input.baseBranch &&
                    pull.authorLogin === target.actorLogin &&
                    sameRepositoryHead(target, pull),
                ) ?? null,
            ),
          );
        const opened = existing
          ? resolvedPull(workspace, existing)
          : {
              ...(yield* client.createPull(target, {
                ...input,
                body: workflowMarkedBody(input.body, input.origin.writeKey),
              })),
              headBranch: input.headBranch,
              baseBranch: input.baseBranch,
            };
        return workflowArtifact(workspace, opened, input.origin);
      }),
    recordPullRequestPush: (workspace, pullRequest, origin) =>
      Effect.gen(function* () {
        const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
        yield* markPullRequest(target, pullRequest.number, origin.writeKey);
        return workflowArtifact(workspace, pullRequest, origin);
      }),
    commentPullRequest: writePullRequestComment,
    requestReview: (workspace, pullRequest, reviewer, origin) =>
      Effect.gen(function* () {
        const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
        const requested = yield* client.listRequestedReviewers(target, pullRequest.number);
        if (!requested.includes(reviewer)) {
          yield* client.requestReview(target, pullRequest.number, reviewer);
        }
        yield* markPullRequest(target, pullRequest.number, origin.writeKey);
        return workflowArtifact(workspace, pullRequest, origin);
      }),
    commentNamedPullRequest: writePullRequestComment,
    postReview: (workspace, pullRequest, event, input, origin) =>
      writeReview(workspace, pullRequest, event, input, origin),
    draftReview: (workspace, pullRequest, input, origin) =>
      writeReview(workspace, pullRequest, null, input, origin),
  };
};

export const layer = Layer.effect(
  SourceControlProvider,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    const registry = yield* WorkspaceRegistry;
    return make(client, registry.state);
  }),
);

export { make as makeProvider };
