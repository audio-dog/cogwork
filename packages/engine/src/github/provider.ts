import {
  type PrReviewStatus,
  WorkflowActionArtifact,
  type WorkflowActionOrigin,
  WorkflowTemplate,
  type WorkItem,
  WorkItemId,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { checkState } from "../ci";
import { IssueTrackerError } from "../issue-tracker";
import type { RegisteredWorkspace, RegistryState } from "../projector";
import { workspaceOptionReader } from "../provider-trigger-source";
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
import { sourceControlActionEntries } from "../workflow-actions-source-control";
import type { WorkflowCatalogContribution } from "../workflow-catalog";
import { branchBelongsToTicketSlug, branchName, ticketSlug } from "../worktree";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawPull,
  type ReviewDecision,
  reviewDecisionOf,
} from "./client";
import { wireCodec } from "./markers";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";
import { baseDivergenceOf, type GitHubTargetConfig, sourceControlTargetFor } from "./source-control-target";

export { baseDivergenceOf } from "./source-control-target";

const decodeTemplate = Schema.decodeUnknownSync(WorkflowTemplate);

export const githubSourceControlActionEntries = sourceControlActionEntries.map(({ row }) => row);

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

export const prReview = (pull: RawPull, decision: ReviewDecision): PrReviewStatus => {
  if (pull.draft) return "pending";
  if (decision === "changes-requested") return "changes-requested";
  if (decision === "approved") return "ready";
  return "pending";
};

const pullNumberFromUrl = (url: string) => {
  const value = url.match(/\/pull\/(\d+)(?:$|[?#])/i)?.[1];
  return value === undefined ? null : Number.parseInt(value, 10);
};

export const readyToMergeArtifact = (pull: RawPull, artifacts: ReadonlyArray<WorkflowActionArtifact>) =>
  artifacts.find(
    (artifact) => artifact.kind === "PullRequestOpened" && pullNumberFromUrl(artifact.url) === pull.number,
  ) ?? null;

export const isReadyToMerge = (signals: PrSignals) =>
  !signals.draft &&
  signals.checks === "passing" &&
  signals.baseDivergence !== "conflict" &&
  signals.review === "ready";

const numericIssue = /^#(\d+)$/;

const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

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
    const [checks, reviews, mergeableState] = yield* Effect.all([
      client.listCheckRuns(target, pull.headSha),
      client.listReviews(target, pull.number),
      client.pullMergeableState(target, pull.number),
    ]);
    const decision = reviewDecisionOf(
      reviews
        .filter((review) => writeAccess.has(review.authorAssociation))
        .map((review) => ({ login: review.authorLogin, state: review.state })),
    );
    return {
      number: pull.number,
      url: pull.url,
      review: prReview(pull, decision),
      checks: checkState(checks),
      baseDivergence: baseDivergenceOf(mergeableState),
      waitingSinceMillis: pull.updatedAtMillis,
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

  const writeMarker = (writeKey: string) =>
    wireCodec.encode({ name: "write", pairs: `key=${encodeURIComponent(writeKey)}` });

  const carriesWriteKey = (body: string, writeKey: string) =>
    wireCodec
      .scan(body)
      .some(({ name, pairs }) => name === "write" && pairs === `key=${encodeURIComponent(writeKey)}`);

  const workflowMarkedBody = (body: string, writeKey: string) =>
    [body.trim(), writeMarker(writeKey)].filter((part) => part.length > 0).join("\n\n");

  const workflowArtifact = (
    kind: WorkflowActionArtifact["kind"],
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    origin: WorkflowActionOrigin,
  ) =>
    WorkflowActionArtifact.make({
      kind,
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
    return workflowArtifact("PullRequestUpdated", workspace, pullRequest, origin);
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
    return workflowArtifact("PullRequestUpdated", workspace, pullRequest, origin);
  });

  const reviewer = workspaceOptionReader("github", registry, (workspace) => {
    const target = sourceControlTargetFor(workspace);
    return target ? client.listCollaborators(target) : Effect.succeed([]);
  });

  const contribution: WorkflowCatalogContribution = {
    entries: [],
    templates: [slackReviewTemplate],
    options: [{ system: "github", readers: { reviewer } }],
  };

  const readyToMerge = Effect.fn("github.readyToMerge")(function* (
    workspace: RegisteredWorkspace,
    artifacts: ReadonlyArray<WorkflowActionArtifact>,
  ) {
    const configuredTarget = sourceControlTargetFor(workspace);
    if (!configuredTarget) return [];
    const target = yield* authenticatedTarget(configuredTarget);
    const opened = (yield* client.listPulls(target)).flatMap((pull) => {
      const artifact = readyToMergeArtifact(pull, artifacts);
      return artifact === null ? [] : [{ pull, artifact }];
    });
    const observed = yield* Effect.forEach(opened, ({ pull, artifact }) =>
      observePr(target, pull).pipe(Effect.map((signals) => ({ pull, artifact, signals }))),
    );
    return observed.flatMap(({ pull, artifact, signals }) => {
      if (!isReadyToMerge(signals)) return [];
      return [
        {
          id: artifact.issue,
          title: pull.title ?? `Pull request #${pull.number}`,
          url: pull.url,
          pr: {
            number: signals.number,
            url: signals.url,
            checks: signals.checks,
            review: signals.review,
            baseDivergence: signals.baseDivergence,
            waitingSinceMillis: signals.waitingSinceMillis,
          },
        },
      ];
    });
  });

  const openPullRequestBranches = Effect.fn("github.openPullRequestBranches")(function* (
    workspace: RegisteredWorkspace,
  ) {
    const target = sourceControlTargetFor(workspace);
    if (!target) return [];
    const pulls = yield* client.listPulls(target);
    return pulls.map(({ headRef }) => headRef);
  });

  return {
    triggerSources: [makeGitHubPullRequestTriggerSource(client, registry)],
    workflowCatalogContribution: contribution,
    readyToMerge,
    openPullRequestBranches,
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
        return workflowArtifact("PullRequestOpened", workspace, opened, input.origin);
      }),
    recordPullRequestPush: (workspace, pullRequest, origin) =>
      Effect.succeed(workflowArtifact("PullRequestUpdated", workspace, pullRequest, origin)),
    commentPullRequest: writePullRequestComment,
    requestReview: (workspace, pullRequest, reviewer, origin) =>
      Effect.gen(function* () {
        const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
        const requested = yield* client.listRequestedReviewers(target, pullRequest.number);
        if (!requested.includes(reviewer)) {
          yield* client.requestReview(target, pullRequest.number, reviewer);
        }
        return workflowArtifact("PullRequestUpdated", workspace, pullRequest, origin);
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
