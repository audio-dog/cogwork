import { type TriageRole, WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CommentHost, CoordinationComment } from "../coordination";
import * as Coordination from "../coordination";
import type { CoordinationHost, ListedItem } from "../coordination-tracker";
import { IssueTrackerError } from "../issue-tracker";
import type { RegisteredWorkspace } from "../projector";
import type { GitHubClientService, GitHubRepoRef, RawComment, RawIssue } from "./client";
import { claimLabel, hasClaimLabel, roleLabel, rolesFromLabels, wireCodec } from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly actorLogin: string | null;
}

interface GitHubRef {
  readonly target: GitHubTarget;
  readonly number: number;
}

const claimIdentity = (target: GitHubTarget) => target.actorLogin ?? Coordination.defaultClaimant;

const toCoordinationComment =
  (actorLogin: string | null) =>
  (comment: RawComment): CoordinationComment<number> => ({
    id: comment.id,
    body: comment.body,
    isBot: comment.authorLogin === actorLogin,
    createdAtMillis: comment.createdAtMillis,
  });

const targetFor = (workspace: RegisteredWorkspace) => {
  const source = workspace.config.issueTracker;
  if (source.type !== "github" || !source.repo) return null;
  const [owner, name] = source.repo.split("/");
  if (!owner || !name) return null;
  return {
    owner,
    name,
    tokenEnv: source.tokenEnv ?? "GITHUB_TOKEN",
    actorLogin: source.actorLogin ?? null,
  } satisfies GitHubTarget;
};

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (issueNumber: number) => decodeItemId(`#${issueNumber}`).pipe(Effect.orDie);

const issueNumberOf = Effect.fn("github.issueNumberOf")(function* (id: string) {
  const parsed = Number.parseInt(id.replace(/^#/, ""), 10);
  if (Number.isNaN(parsed)) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: `unrecognized work item id ${id}`,
    });
  }
  return parsed;
});

const notGitHub = (workspace: RegisteredWorkspace) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a github work source`,
  });

export const makeHost = (client: GitHubClientService): CoordinationHost<GitHubRef, number> => {
  const commentsFor = (target: GitHubTarget, number: number): CommentHost<number> => ({
    comments: client
      .listComments(target, number)
      .pipe(Effect.map((comments) => comments.map(toCoordinationComment(target.actorLogin)))),
    edit: (id, body) => client.editComment(target, id, body),
    create: (body) => client.createComment(target, number, body),
  });

  const listItem = (target: GitHubTarget) =>
    Effect.fn("github.listItem")(function* (issue: RawIssue) {
      // With no configured bot login the daemon cannot tell its own comments apart, so it reads no
      // coordination state at all rather than trusting an unattributable comment.
      const rawComments = target.actorLogin ? yield* client.listComments(target, issue.number) : [];
      const id = yield* itemId(issue.number);
      return {
        id,
        title: issue.title,
        roles: rolesFromLabels(issue.labels),
        assignees: issue.assignees,
        claimLabeled: hasClaimLabel(issue.labels),
        openBlockers: issue.openBlockers,
        claimIdentity: claimIdentity(target),
        comments: rawComments.map(toCoordinationComment(target.actorLogin)),
      } satisfies ListedItem<number>;
    });

  return {
    codec: wireCodec,
    rateLimitScope: () => null,
    list: Effect.fn("github.list")(function* (workspace: RegisteredWorkspace) {
      const target = targetFor(workspace);
      if (!target) {
        return [];
      }
      const issues = yield* client.listIssues(target);
      return yield* Effect.forEach(
        issues.filter((issue) => !issue.isPullRequest),
        listItem(target),
        { concurrency: 10 },
      );
    }),
    resolve: Effect.fn("github.resolve")(function* (workspace: RegisteredWorkspace, id: WorkItemId) {
      const target = targetFor(workspace);
      if (!target) {
        return yield* notGitHub(workspace);
      }
      const number = yield* issueNumberOf(id);
      return { target, number } satisfies GitHubRef;
    }),
    comments: (ref) => commentsFor(ref.target, ref.number),
    claimIdentity: (ref) => claimIdentity(ref.target),
    addClaim: (ref) => client.addLabel(ref.target, ref.number, claimLabel),
    removeClaim: (ref) => client.removeLabel(ref.target, ref.number, claimLabel),
    addRole: (ref, role: TriageRole) => client.addLabel(ref.target, ref.number, roleLabel(role)),
    removeRole: (ref, role: TriageRole) => client.removeLabel(ref.target, ref.number, roleLabel(role)),
    // GitHub has no state to sync after a role change; Linear's Canceled write is the counterexample.
    afterRoleChange: () => Effect.void,
  };
};
