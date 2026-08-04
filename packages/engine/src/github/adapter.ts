import { WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { checkState } from "../ci";
import type { RegisteredWorkspace } from "../projector";
import {
  type BaseDivergence,
  type ObservedItem,
  type ObservedPr,
  type PrReview,
  WorkSource,
  WorkSourceError,
  type WorkSourceService,
} from "../WorkSource";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawIssue,
  type RawPull,
  type RawReview,
  type ReviewDecision,
  reviewDecisionOf,
} from "./client";
import {
  attemptStatus,
  claimLabel,
  claimStatus,
  coordinationDetail,
  coordinationMarkers,
  coordinationStatus,
  defaultStatus,
  formatCoordinationBody,
  formatNoteBody,
  hasClaimLabel,
  hasClankerMarker,
  hasLedgerMarker,
  parseAttempts,
  parseClaim,
  parseFollowUp,
  roleLabel,
  rolesFromLabels,
  serializeAttempt,
  serializeClaim,
  serializeFollowUp,
} from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly botLogin: string | null;
}

interface CoordinationUpdate {
  readonly status?: string;
  readonly marker?: string;
  readonly detail?: string | null;
}

const botLedger = (comments: ReadonlyArray<RawComment>, botLogin: string | null) =>
  comments.find((comment) => comment.authorLogin === botLogin && hasLedgerMarker(comment.body));

const nextDetail = (update: CoordinationUpdate, previous: string) => {
  if (!Object.hasOwn(update, "detail")) return coordinationDetail(previous);
  return update.detail ?? null;
};

const targetFor = (workspace: RegisteredWorkspace) => {
  const source = workspace.config.workSource;
  if (source.type !== "github" || !source.repo) return null;
  const [owner, name] = source.repo.split("/");
  if (!owner || !name) return null;
  return {
    owner,
    name,
    tokenEnv: source.tokenEnv ?? "GITHUB_TOKEN",
    botLogin: source.botLogin ?? null,
  } satisfies GitHubTarget;
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

const coordinationLast = (comments: ReadonlyArray<RawComment>) => [
  ...comments.filter((comment) => !hasLedgerMarker(comment.body)),
  ...comments.filter((comment) => hasLedgerMarker(comment.body)),
];

type PrSignals = Omit<ObservedPr, "followUp">;

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (issueNumber: number) => decodeItemId(`#${issueNumber}`).pipe(Effect.orDie);

const issueNumberOf = Effect.fn("github.issueNumberOf")(function* (id: string) {
  const parsed = Number.parseInt(id.replace(/^#/, ""), 10);
  if (Number.isNaN(parsed)) {
    return yield* new WorkSourceError({ reason: "unavailable", message: `unrecognized work item id ${id}` });
  }
  return parsed;
});

const notGitHub = (workspace: RegisteredWorkspace) =>
  new WorkSourceError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a github work source`,
  });

const make = (client: GitHubClientService): WorkSourceService => {
  const resolveIssue = Effect.fn("github.resolveIssue")(function* (
    workspace: RegisteredWorkspace,
    id: string,
  ) {
    const target = targetFor(workspace);
    if (!target) {
      return yield* notGitHub(workspace);
    }
    const number = yield* issueNumberOf(id);
    return { target, number };
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

  const upsertCoordination = Effect.fn("github.upsertCoordination")(function* (
    target: GitHubTarget,
    number: number,
    update: CoordinationUpdate,
  ) {
    const comments = yield* client.listComments(target, number);
    const ledger = botLedger(comments, target.botLogin);
    const previous = ledger?.body ?? "";
    const markers = coordinationMarkers(previous);
    const body = formatCoordinationBody({
      status: update.status ?? coordinationStatus(previous) ?? defaultStatus,
      markers: update.marker === undefined ? markers : [...markers, update.marker],
      detail: nextDetail(update, previous),
    });
    if (ledger) {
      yield* client.editComment(target, ledger.id, body);
      return;
    }
    yield* client.createComment(target, number, body);
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

  const buildItem = (target: GitHubTarget, pulls: Map<number, RawPull>) =>
    Effect.fn("github.buildItem")(function* (issue: RawIssue) {
      const claimLabeled = hasClaimLabel(issue.labels);
      const comments = target.botLogin ? yield* client.listComments(target, issue.number) : [];
      const trusted = coordinationLast(
        comments.filter((comment) => comment.authorLogin === target.botLogin),
      ).map((comment) => comment.body);
      const id = yield* itemId(issue.number);
      const owned = trusted.some(hasClankerMarker);
      const pull = pulls.get(issue.number);
      const signals = owned && pull ? yield* observePr(target, pull) : null;
      return {
        id,
        title: issue.title,
        roles: rolesFromLabels(issue.labels),
        claimLabeled,
        claim: claimLabeled ? parseClaim(trusted) : null,
        attempts: parseAttempts(trusted),
        pr: signals ? { ...signals, followUp: parseFollowUp(trusted) } : null,
        openBlockers: issue.openBlockers,
      } satisfies ObservedItem;
    });

  const observeTarget = Effect.fn("github.observeTarget")(function* (target: GitHubTarget) {
    const [issues, pulls] = yield* Effect.all([client.listIssues(target), client.listPulls(target)]);
    return yield* Effect.forEach(
      issues.filter((issue) => !issue.isPullRequest),
      buildItem(target, pullsByIssue(target, pulls)),
      { concurrency: 10 },
    );
  });

  return {
    rateLimitScope: () => null,
    observe: (workspace) =>
      Effect.gen(function* () {
        const target = targetFor(workspace);
        if (!target) {
          return [] as ReadonlyArray<ObservedItem>;
        }
        return yield* observeTarget(target);
      }),
    claim: (workspace, id, claim) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.addLabel(target, number, claimLabel);
        const status = claim.stage ? claimStatus(claim.stage) : `In progress — claimed by ${claim.by}.`;
        yield* upsertCoordination(target, number, { status, marker: serializeClaim(claim) });
      }),
    release: (workspace, id) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.removeLabel(target, number, claimLabel);
      }),
    recordAttempt: (workspace, id, attempt, reason) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* upsertCoordination(target, number, {
          status: attemptStatus(attempt, reason),
          marker: serializeAttempt(attempt),
        });
      }),
    recordFollowUp: (workspace, id, marker, detail) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* upsertCoordination(target, number, { marker: serializeFollowUp(marker), detail });
      }),
    note: (workspace, id, detail) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        const comments = yield* client.listComments(target, number);
        const ledger = botLedger(comments, target.botLogin);
        if (ledger && coordinationDetail(ledger.body) !== null) {
          yield* upsertCoordination(target, number, { detail: null });
        }
        yield* client.createComment(target, number, formatNoteBody(detail));
      }),
    setRoles: (workspace, id, changes) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* Effect.forEach(changes.remove, (role) => client.removeLabel(target, number, roleLabel(role)));
        yield* Effect.forEach(changes.add, (role) => client.addLabel(target, number, roleLabel(role)));
      }),
  };
};

export const layer = Layer.effect(
  WorkSource,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    return make(client);
  }),
);

export { make as makeAdapter };
