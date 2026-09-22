import type { ConnectionBindingId, ConnectionId, WorkItem, WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { checkState } from "../ci";
import type { BaseDivergence, PrReview } from "../follow-up";
import { IssueTrackerError } from "../issue-tracker";
import type { RegisteredWorkspace } from "../projector";
import { type PrSignals, SourceControlProvider, type SourceControlProviderService } from "../source-control";
import { branchBelongsToTicketSlug, branchName, ticketSlug } from "../worktree";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawPull,
  type RawReview,
  type ReviewDecision,
  repoRefFromRepository,
  reviewDecisionOf,
} from "./client";
import { agentNoteMarker, hasCogworkMarker } from "./markers";

interface BotWakeMode {
  readonly acceptsAnyComment: boolean;
}

type BotAllowlist = ReadonlyMap<string, BotWakeMode>;

interface GitHubTargetConfig extends GitHubRepoRef {
  readonly botAllowlist: BotAllowlist;
}

interface GitHubTarget extends GitHubTargetConfig {
  readonly actorLogin: string;
}

const botAllowlistEntry = (entry: string): readonly [string, BotWakeMode] => {
  const acceptsAnyComment = entry.endsWith(":any");
  const login = acceptsAnyComment ? entry.slice(0, -4) : entry;
  return [login, { acceptsAnyComment }];
};

const targetFromRepo = (
  repo: string,
  connectionId: ConnectionBindingId,
  botAllowlist: ReadonlyArray<string> | undefined,
): GitHubTargetConfig | null => {
  const repository = repoRefFromRepository(repo);
  if (!repository) return null;
  const boundConnectionId: ConnectionId | undefined = connectionId === "unbound" ? undefined : connectionId;
  return {
    ...repository,
    ...(boundConnectionId ? { connectionId: boundConnectionId } : {}),
    botAllowlist: new Map((botAllowlist ?? []).map(botAllowlistEntry)),
  };
};

export const sourceControlTargetFor = (workspace: RegisteredWorkspace): GitHubTargetConfig | null => {
  const explicit = workspace.config.sourceControl;
  if (explicit) {
    if (explicit.type !== "github" || !workspace.repository) return null;
    return targetFromRepo(workspace.repository, explicit.connectionId, explicit.botAllowlist);
  }
  const source = workspace.config.issueTracker;
  if (source.type !== "github" || !workspace.repository) return null;
  return targetFromRepo(workspace.repository, source.connectionId, source.botAllowlist);
};

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

export const baseDivergenceOf = (mergeableState: string | null): BaseDivergence => {
  if (mergeableState === "dirty") return "conflict";
  if (mergeableState === "behind") return "clean";
  return "none";
};

export const prReview = (pull: RawPull, decision: ReviewDecision): PrReview => {
  if (pull.draft) return "pending";
  if (decision === "changes-requested") return "changes-requested";
  if (decision === "approved") return "ready";
  return "pending";
};

const freshPattern = /\/fresh\b/i;
const numericIssue = /^#(\d+)$/;

const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type Feedback = Pick<
  RawComment,
  "authorLogin" | "authorAssociation" | "body" | "createdAtMillis" | "inReplyToId" | "subjectType"
>;

// An allowlisted login is always the trusted-bot path, never the human one, even if it reports write
// access — that keeps a bot from ever setting `/fresh` or resetting the no-progress counter.
const isHumanFeedback = (feedback: Feedback, botAllowlist: BotAllowlist) =>
  writeAccess.has(feedback.authorAssociation) &&
  !botAllowlist.has(feedback.authorLogin) &&
  !hasCogworkMarker(feedback.body);

const isTrustedBotFeedback = (feedback: Feedback, botAllowlist: BotAllowlist) =>
  botAllowlist.has(feedback.authorLogin) && !hasCogworkMarker(feedback.body);

export const reviewFeedback = (reviews: ReadonlyArray<RawReview>) => {
  const latestApprovalMillis = reviews.reduce(
    (latest, review) => (review.state === "APPROVED" ? Math.max(latest, review.submittedAtMillis) : latest),
    Number.NEGATIVE_INFINITY,
  );
  return reviews.flatMap((review) =>
    review.body && review.state !== "APPROVED" && review.submittedAtMillis > latestApprovalMillis
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
};

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
  reviewComments: ReadonlyArray<RawComment>,
  pullRequestFeedback: ReadonlyArray<Feedback>,
  botAllowlist: BotAllowlist,
) => {
  // Bot-specific HTML markers are private strings; GitHub's comment and thread shape is the stable boundary.
  const isTrustedDiffFinding = (item: RawComment) =>
    botAllowlist.get(item.authorLogin)?.acceptsAnyComment === false &&
    item.inReplyToId === null &&
    item.subjectType === "line" &&
    isTrustedBotFeedback(item, botAllowlist);
  const isTrustedAnyComment = (item: Feedback) =>
    botAllowlist.get(item.authorLogin)?.acceptsAnyComment === true &&
    isTrustedBotFeedback(item, botAllowlist);
  const findings = reviewComments.filter(isTrustedDiffFinding);
  const unrestricted = [...reviewComments, ...pullRequestFeedback].filter(isTrustedAnyComment);
  const newest = newestOf([...findings, ...unrestricted]);
  return { latestAtMillis: newest?.createdAtMillis ?? null };
};

const make = (client: GitHubClientService): SourceControlProviderService => {
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
    const pullRequestFeedback = [...comments, ...reviewFeedback(reviews)];
    const feedback = [...pullRequestFeedback, ...reviewComments];
    const human = humanCommentSignal(feedback, target.botAllowlist);
    const bot = botTriggerSignal(reviewComments, pullRequestFeedback, target.botAllowlist);
    return {
      number: pull.number,
      url: pull.url,
      review: prReview(pull, decision),
      checks: checkState(checks),
      latestHumanCommentAtMillis: human.latestAtMillis,
      latestBotTriggerAtMillis: bot.latestAtMillis,
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

  const empty: ReadonlyMap<WorkItemId, PrSignals> = new Map();

  return {
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
  };
};

export const layer = Layer.effect(SourceControlProvider, Effect.map(GitHubClient, make));

export { make as makeProvider };
