import { WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "../projector";
import {
  type ObservedItem,
  type ObservedPr,
  type PrReview,
  WorkSource,
  WorkSourceError,
  type WorkSourceService,
} from "../WorkSource";
import { GitHubClient, type GitHubClientService, type GitHubRepoRef, type RawPull } from "./client";
import {
  claimLabel,
  hasClaimLabel,
  parseAttempts,
  parseClaim,
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

const prEntry = (pull: RawPull) => {
  const issue = linkedIssue(pull.body);
  return issue ? [[issue, { review: prReview(pull) }] as const] : [];
};

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

  const prsByIssue = Effect.fn("github.prsByIssue")(function* (target: GitHubTarget) {
    const pulls = yield* client.listPulls(target);
    const bot = target.botLogin ? pulls.filter((pull) => pull.authorLogin === target.botLogin) : [];
    return new Map<number, ObservedPr>(bot.flatMap(prEntry));
  });

  const buildItem = (target: GitHubTarget, prs: Map<number, ObservedPr>) =>
    Effect.fn("github.buildItem")(function* (issue: {
      readonly number: number;
      readonly title: string;
      readonly labels: ReadonlyArray<string>;
    }) {
      const claimLabeled = hasClaimLabel(issue.labels);
      const comments = yield* claimLabeled ? client.listComments(target, issue.number) : Effect.succeed([]);
      const trusted = target.botLogin
        ? comments.filter((comment) => comment.authorLogin === target.botLogin).map((comment) => comment.body)
        : [];
      const id = yield* itemId(issue.number);
      return {
        id,
        title: issue.title,
        roles: rolesFromLabels(issue.labels),
        claimLabeled,
        claim: claimLabeled ? parseClaim(trusted) : null,
        attempts: parseAttempts(trusted),
        pr: prs.get(issue.number) ?? null,
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
        yield* client.createComment(target, number, serializeClaim(claim));
      }),
    release: (workspace, id) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.removeLabel(target, number, claimLabel);
      }),
    recordAttempt: (workspace, id, attempt) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.createComment(target, number, serializeAttempt(attempt));
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
