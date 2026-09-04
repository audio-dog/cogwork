import type { ConnectionBindingId, ConnectionId, WorkItem, WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { checkState } from "../ci";
import type { BaseDivergence, PrReview } from "../follow-up";
import { IssueTrackerError } from "../issue-tracker";
import type { RegisteredWorkspace } from "../projector";
import { type PrSignals, SourceControlProvider, type SourceControlProviderService } from "../source-control";
import { branchName, ticketSlug } from "../worktree";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawPull,
  type RawReview,
  type ReviewDecision,
  reviewDecisionOf,
} from "./client";
import { agentNoteMarker, hasCogworkMarker } from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly actorLogin: string | null;
  readonly botAllowlist: ReadonlySet<string>;
}

const targetFromRepo = (
  repo: string,
  connectionId: ConnectionBindingId,
  actorLogin: string | undefined,
  botAllowlist: ReadonlyArray<string> | undefined,
): GitHubTarget | null => {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  const boundConnectionId: ConnectionId | undefined = connectionId === "unbound" ? undefined : connectionId;
  return {
    owner,
    name,
    tokenEnv: "GITHUB_TOKEN",
    ...(boundConnectionId ? { connectionId: boundConnectionId } : {}),
    actorLogin: actorLogin ?? null,
    botAllowlist: new Set(botAllowlist ?? []),
  };
};

export const sourceControlTargetFor = (workspace: RegisteredWorkspace): GitHubTarget | null => {
  const explicit = workspace.config.sourceControl;
  if (explicit) {
    if (explicit.type !== "github" || !explicit.repo) return null;
    return targetFromRepo(explicit.repo, explicit.connectionId, explicit.actorLogin, explicit.botAllowlist);
  }
  const source = workspace.config.issueTracker;
  if (source.type !== "github" || !source.repo) return null;
  return targetFromRepo(source.repo, source.connectionId, source.actorLogin, source.botAllowlist);
};

const missingSourceControlTarget = () =>
  new IssueTrackerError({
    reason: "unavailable",
    message: "GitHub source control target is not configured",
  });

const sourceControlTarget = (workspace: RegisteredWorkspace) => {
  const target = sourceControlTargetFor(workspace);
  return target ? Effect.succeed(target) : Effect.fail(missingSourceControlTarget());
};

// The engine cuts an item's branch as `branchName(item)`, whose stable prefix is `ticketSlug(item.id)`.
// A PR belongs to the item when its head branch is that slug or a `slug-…` extension of it — the `-`
// keeps `12` from swallowing `120`, mirroring the worktree reaper's ownership check.
export const branchBelongsToSlug = (headRef: string, slug: string) =>
  headRef === slug || headRef.startsWith(`${slug}-`);

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

type Feedback = Pick<RawComment, "authorLogin" | "authorAssociation" | "body" | "createdAtMillis">;

// An allowlisted login is always the trusted-bot path, never the human one, even if it reports write
// access — that keeps a bot from ever setting `/fresh` or resetting the no-progress counter.
const isHumanFeedback = (feedback: Feedback, botAllowlist: ReadonlySet<string>) =>
  writeAccess.has(feedback.authorAssociation) &&
  !botAllowlist.has(feedback.authorLogin) &&
  !hasCogworkMarker(feedback.body);

const isTrustedBotFeedback = (feedback: Feedback, botAllowlist: ReadonlySet<string>) =>
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

export const humanCommentSignal = (
  feedback: ReadonlyArray<Feedback>,
  actorLogin: string | null,
  botAllowlist: ReadonlySet<string>,
) => {
  if (!actorLogin) {
    return { latestAtMillis: null, fresh: false };
  }
  const newest = newestOf(feedback.filter((item) => isHumanFeedback(item, botAllowlist)));
  return {
    latestAtMillis: newest?.createdAtMillis ?? null,
    fresh: newest ? freshPattern.test(newest.body) : false,
  };
};

// Returns no `fresh` flag: `/fresh` restarts stay human-only, so a bot can never trigger one.
export const botTriggerSignal = (feedback: ReadonlyArray<Feedback>, botAllowlist: ReadonlySet<string>) => {
  const newest = newestOf(feedback.filter((item) => isTrustedBotFeedback(item, botAllowlist)));
  return { latestAtMillis: newest?.createdAtMillis ?? null };
};

const make = (client: GitHubClientService): SourceControlProviderService => {
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
    const feedback = [...comments, ...reviewComments, ...reviewFeedback(reviews)];
    const human = humanCommentSignal(feedback, target.actorLogin, target.botAllowlist);
    const bot = botTriggerSignal(feedback, target.botAllowlist);
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

  const sameRepositoryHead = (target: GitHubTarget, pull: RawPull) =>
    pull.headRepository?.toLowerCase() === `${target.owner}/${target.name}`.toLowerCase();

  const exactHeadPull = (target: GitHubTarget, headBranch: string, pulls: ReadonlyArray<RawPull>) =>
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
        const target = sourceControlTargetFor(workspace);
        if (!target || workItems.length === 0) return empty;
        return yield* observeItems(target, workItems);
      }),
    comment: (workspace, item, body) =>
      Effect.gen(function* () {
        const target = sourceControlTargetFor(workspace);
        if (!target) return;
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
