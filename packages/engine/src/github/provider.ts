import { WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { checkState } from "../ci";
import type { BaseDivergence, PrReview } from "../follow-up";
import type { RegisteredWorkspace } from "../projector";
import { type PrSignals, SourceControlProvider, type SourceControlProviderService } from "../source-control";
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
  readonly botLogin: string | null;
}

const targetFromRepo = (
  repo: string,
  tokenEnv: string | undefined,
  botLogin: string | undefined,
): GitHubTarget | null => {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  return { owner, name, tokenEnv: tokenEnv ?? "GITHUB_TOKEN", botLogin: botLogin ?? null };
};

// A workspace's source control provider is its own `sourceControl` block when set, and otherwise its
// GitHub tracker's settings. A Linear tracker with no block resolves to nothing, so it observes no PR.
export const sourceControlTargetFor = (workspace: RegisteredWorkspace): GitHubTarget | null => {
  const explicit = workspace.config.sourceControl;
  if (explicit) {
    if (explicit.type !== "github" || !explicit.repo) return null;
    return targetFromRepo(explicit.repo, explicit.tokenEnv, explicit.botLogin);
  }
  const source = workspace.config.workSource;
  if (source.type !== "github" || !source.repo) return null;
  return targetFromRepo(source.repo, source.tokenEnv, source.botLogin);
};

const closingPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i;

export const linkedIssue = (body: string) => {
  const match = body.match(closingPattern);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
};

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

export const humanCommentSignal = (feedback: ReadonlyArray<Feedback>, botLogin: string | null) => {
  if (!botLogin) {
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

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (issueNumber: number) => decodeItemId(`#${issueNumber}`).pipe(Effect.orDie);

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
      target.botLogin,
    );
    return {
      review: prReview(pull, decision),
      checks: checkState(checks),
      latestHumanCommentAtMillis: human.latestAtMillis,
      fresh: human.fresh,
      baseDivergence: baseDivergenceOf(mergeableState),
    } satisfies PrSignals;
  });

  const daemonPull = (target: GitHubTarget, pull: RawPull) =>
    pull.authorLogin === target.botLogin || writeAccess.has(pull.authorAssociation);

  const pullsByIssue = (target: GitHubTarget, pulls: ReadonlyArray<RawPull>) =>
    pulls.reduce((byIssue, pull) => {
      const issue = linkedIssue(pull.body);
      if (issue === null || !daemonPull(target, pull)) return byIssue;
      const existing = byIssue.get(issue);
      if (existing && existing.authorLogin === target.botLogin) return byIssue;
      return new Map(byIssue).set(issue, pull);
    }, new Map<number, RawPull>());

  const observeOwned = Effect.fn("github.observeOwned")(function* (
    target: GitHubTarget,
    owned: ReadonlyArray<WorkItemId>,
  ) {
    const ownedNumbers = new Set(owned.map((id) => Number.parseInt(id.replace(/^#/, ""), 10)));
    const pulls = yield* client.listPulls(target);
    const byIssue = pullsByIssue(target, pulls);
    const entries = yield* Effect.forEach(
      [...byIssue].filter(([issue]) => ownedNumbers.has(issue)),
      ([issue, pull]) =>
        Effect.map(
          Effect.all([itemId(issue), observePr(target, pull)]),
          ([id, signals]) => [id, signals] as const,
        ),
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
