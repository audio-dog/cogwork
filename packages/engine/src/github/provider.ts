import type { WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { checkState } from "../ci";
import type { BaseDivergence, PrReview } from "../follow-up";
import type { RegisteredWorkspace } from "../projector";
import {
  type OwnedItem,
  type PrSignals,
  SourceControlProvider,
  type SourceControlProviderService,
} from "../source-control";
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
import { hasClankerMarker } from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly actorLogin: string | null;
}

const targetFromRepo = (
  repo: string,
  tokenEnv: string | undefined,
  actorLogin: string | undefined,
): GitHubTarget | null => {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  return { owner, name, tokenEnv: tokenEnv ?? "GITHUB_TOKEN", actorLogin: actorLogin ?? null };
};

// A workspace's source control provider is its own `sourceControl` block when set, and otherwise its
// GitHub tracker's settings. A Linear tracker with no block resolves to nothing, so it observes no PR.
export const sourceControlTargetFor = (workspace: RegisteredWorkspace): GitHubTarget | null => {
  const explicit = workspace.config.sourceControl;
  if (explicit) {
    if (explicit.type !== "github" || !explicit.repo) return null;
    return targetFromRepo(explicit.repo, explicit.tokenEnv, explicit.actorLogin);
  }
  const source = workspace.config.issueTracker;
  if (source.type !== "github" || !source.repo) return null;
  return targetFromRepo(source.repo, source.tokenEnv, source.actorLogin);
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

const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type Feedback = Pick<RawComment, "authorAssociation" | "body" | "createdAtMillis">;

const isHumanFeedback = (feedback: Feedback) =>
  writeAccess.has(feedback.authorAssociation) && !hasClankerMarker(feedback.body);

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

export const humanCommentSignal = (feedback: ReadonlyArray<Feedback>, actorLogin: string | null) => {
  if (!actorLogin) {
    return { latestAtMillis: null, fresh: false };
  }
  const newest = feedback
    .filter(isHumanFeedback)
    .reduce<Feedback | null>(
      (max, item) => (max && max.createdAtMillis >= item.createdAtMillis ? max : item),
      null,
    );
  return {
    latestAtMillis: newest?.createdAtMillis ?? null,
    fresh: newest ? freshPattern.test(newest.body) : false,
  };
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
    const human = humanCommentSignal(
      [...comments, ...reviewComments, ...reviewFeedback(reviews)],
      target.actorLogin,
    );
    return {
      number: pull.number,
      url: pull.url,
      review: prReview(pull, decision),
      checks: checkState(checks),
      latestHumanCommentAtMillis: human.latestAtMillis,
      fresh: human.fresh,
      baseDivergence: baseDivergenceOf(mergeableState),
      waitingSinceMillis: pull.updatedAtMillis,
    } satisfies PrSignals;
  });

  const daemonPull = (target: GitHubTarget, pull: RawPull) =>
    pull.authorLogin === target.actorLogin || writeAccess.has(pull.authorAssociation);

  // The final key is the PR number: the higher number is the newer PR, since GitHub numbers them in
  // creation order.
  const rank = (target: GitHubTarget, branch: string, pull: RawPull) =>
    [pull.headRef === branch ? 1 : 0, pull.authorLogin === target.actorLogin ? 1 : 0, pull.number] as const;

  const outranks = (target: GitHubTarget, branch: string, a: RawPull, b: RawPull) => {
    const [aExact, aBot, aNumber] = rank(target, branch, a);
    const [bExact, bBot, bNumber] = rank(target, branch, b);
    if (aExact !== bExact) return aExact > bExact;
    if (aBot !== bBot) return aBot > bBot;
    return aNumber > bNumber;
  };

  const linkedPull = (target: GitHubTarget, item: OwnedItem, trusted: ReadonlyArray<RawPull>) => {
    const slug = ticketSlug(item.id);
    const branch = branchName(item);
    const better = (best: RawPull | null, pull: RawPull) => {
      if (!branchBelongsToSlug(pull.headRef, slug)) return best;
      if (best === null) return pull;
      return outranks(target, branch, pull, best) ? pull : best;
    };
    return trusted.reduce<RawPull | null>(better, null);
  };

  const observeOwned = Effect.fn("github.observeOwned")(function* (
    target: GitHubTarget,
    owned: ReadonlyArray<OwnedItem>,
  ) {
    const pulls = yield* client.listPulls(target);
    const trusted = pulls.filter((pull) => daemonPull(target, pull));
    const matches = owned.flatMap((item) => {
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

  const empty: ReadonlyMap<WorkItemId, PrSignals> = new Map();

  return {
    observe: (workspace, owned) =>
      Effect.gen(function* () {
        const target = sourceControlTargetFor(workspace);
        if (!target || owned.length === 0) return empty;
        return yield* observeOwned(target, owned);
      }),
  };
};

export const layer = Layer.effect(SourceControlProvider, Effect.map(GitHubClient, make));

export { make as makeProvider };
