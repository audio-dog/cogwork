import { WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { checkState } from "../ci";
import type { RegisteredWorkspace } from "../projector";
import {
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
  type RawPull,
} from "./client";
import {
  attemptStatus,
  claimLabel,
  claimStatus,
  coordinationMarkers,
  formatCoordinationBody,
  hasClaimLabel,
  hasLedgerMarker,
  parseAttempts,
  parseClaim,
  parseFollowUp,
  roleLabel,
  rolesFromLabels,
  serializeAttempt,
  serializeClaim,
} from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly botLogin: string | null;
}

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

export const prReview = (pull: RawPull): PrReview => {
  if (pull.draft) return "pending";
  if (pull.reviewDecision === "changes-requested") return "changes-requested";
  if (pull.reviewDecision === "approved") return "ready";
  return "pending";
};

const freshPattern = /\/fresh\b/i;

const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const trustedHuman = (comment: RawComment, botLogin: string) =>
  comment.authorLogin !== botLogin && writeAccess.has(comment.authorAssociation);

export const humanCommentSignal = (comments: ReadonlyArray<RawComment>, botLogin: string | null) => {
  const humans = botLogin ? comments.filter((comment) => trustedHuman(comment, botLogin)) : [];
  const newest = humans.reduce<RawComment | null>(
    (max, comment) => (max && max.createdAtMillis >= comment.createdAtMillis ? max : comment),
    null,
  );
  return {
    latestAtMillis: newest?.createdAtMillis ?? null,
    fresh: newest ? freshPattern.test(newest.body) : false,
  };
};

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
    const [checks, comments] = yield* Effect.all([
      client.listCheckRuns(target, pull.headSha),
      client.listComments(target, pull.number),
    ]);
    const human = humanCommentSignal(comments, target.botLogin);
    return {
      review: prReview(pull),
      checks: checkState(checks),
      latestHumanCommentAtMillis: human.latestAtMillis,
      fresh: human.fresh,
    } satisfies PrSignals;
  });

  const upsertMarker = Effect.fn("github.upsertMarker")(function* (
    target: GitHubTarget,
    number: number,
    marker: string,
    status: string,
  ) {
    const comments = yield* client.listComments(target, number);
    const ledger = comments.find(
      (comment) => comment.authorLogin === target.botLogin && hasLedgerMarker(comment.body),
    );
    const markers = [...(ledger ? coordinationMarkers(ledger.body) : []), marker];
    const body = formatCoordinationBody(status, markers);
    if (ledger) {
      yield* client.editComment(target, ledger.id, body);
      return;
    }
    yield* client.createComment(target, number, body);
  });

  const prsByIssue = Effect.fn("github.prsByIssue")(function* (target: GitHubTarget) {
    const pulls = yield* client.listPulls(target);
    const bot = target.botLogin ? pulls.filter((pull) => pull.authorLogin === target.botLogin) : [];
    const entries = yield* Effect.forEach(bot, (pull) =>
      Effect.map(observePr(target, pull), (signals) => {
        const issue = linkedIssue(pull.body);
        return issue ? [[issue, signals] as const] : [];
      }),
    );
    return new Map<number, PrSignals>(entries.flat());
  });

  const buildItem = (target: GitHubTarget, prs: Map<number, PrSignals>) =>
    Effect.fn("github.buildItem")(function* (issue: {
      readonly number: number;
      readonly title: string;
      readonly labels: ReadonlyArray<string>;
    }) {
      const claimLabeled = hasClaimLabel(issue.labels);
      const comments = target.botLogin ? yield* client.listComments(target, issue.number) : [];
      const trusted = target.botLogin
        ? comments.filter((comment) => comment.authorLogin === target.botLogin).map((comment) => comment.body)
        : [];
      const id = yield* itemId(issue.number);
      const signals = prs.get(issue.number);
      return {
        id,
        title: issue.title,
        roles: rolesFromLabels(issue.labels),
        claimLabeled,
        claim: claimLabeled ? parseClaim(trusted) : null,
        attempts: parseAttempts(trusted),
        pr: signals ? { ...signals, followUp: parseFollowUp(trusted) } : null,
      } satisfies ObservedItem;
    });

  const observeTarget = Effect.fn("github.observeTarget")(function* (target: GitHubTarget) {
    const [issues, prs] = yield* Effect.all([client.listIssues(target), prsByIssue(target)]);
    return yield* Effect.forEach(
      issues.filter((issue) => !issue.isPullRequest),
      buildItem(target, prs),
    );
  });

  return {
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
        yield* upsertMarker(target, number, serializeClaim(claim), status);
      }),
    release: (workspace, id) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.removeLabel(target, number, claimLabel);
      }),
    recordAttempt: (workspace, id, attempt) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* upsertMarker(target, number, serializeAttempt(attempt), attemptStatus(attempt));
      }),
    comment: (workspace, id, body) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.createComment(target, number, body);
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
