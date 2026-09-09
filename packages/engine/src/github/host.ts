import {
  defaultPriority,
  type GitHubPrioritySource,
  type Priority,
  type TriageRole,
  WorkItemId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CommentHost, CoordinationComment } from "../coordination";
import * as Coordination from "../coordination";
import type { CoordinationHost, ListedItem } from "../coordination-tracker";
import { IssueTrackerError } from "../issue-tracker";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import {
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawIssue,
  repoRefFromRepository,
} from "./client";
import { claimLabel, hasClaimLabel, roleLabel, rolesFromLabels, wireCodec } from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly priority: GitHubPrioritySource | null;
}

interface AuthenticatedGitHubTarget extends GitHubTarget {
  readonly actorLogin: string;
}

interface GitHubRef {
  readonly target: AuthenticatedGitHubTarget;
  readonly number: number;
}

const claimIdentity = (target: AuthenticatedGitHubTarget) => target.actorLogin;

const toCoordinationComment =
  (actorLogin: string) =>
  (comment: RawComment): CoordinationComment<number> => ({
    id: comment.id,
    body: comment.body,
    isBot: comment.authorLogin === actorLogin,
    createdAtMillis: comment.createdAtMillis,
  });

const targetFor = (workspace: WorkspaceIssueTrackerBinding) => {
  const source = workspace.config.issueTracker;
  if (source.type !== "github" || !workspace.repository) return null;
  const repo = repoRefFromRepository(workspace.repository);
  if (!repo) return null;
  const connectionId = source.connectionId === "unbound" ? undefined : source.connectionId;
  return {
    ...repo,
    ...(connectionId ? { connectionId } : {}),
    priority: source.priority ?? null,
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

const notGitHub = (workspace: WorkspaceIssueTrackerBinding) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a github work source`,
  });

export const makeHost = (client: GitHubClientService): CoordinationHost<GitHubRef, number> => {
  const authenticatedTarget = Effect.fn("github.authenticatedTarget")(function* (target: GitHubTarget) {
    const actorLogin = yield* client.authenticatedLogin(target);
    return { ...target, actorLogin } satisfies AuthenticatedGitHubTarget;
  });

  const commentsFor = (target: AuthenticatedGitHubTarget, number: number): CommentHost<number> => ({
    comments: client
      .listComments(target, number)
      .pipe(Effect.map((comments) => comments.map(toCoordinationComment(target.actorLogin)))),
    edit: (id, body) => client.editComment(target, id, body),
    create: (body) => client.createComment(target, number, body),
  });

  const listItem = (target: AuthenticatedGitHubTarget, priorityFor: (issueNumber: number) => Priority) =>
    Effect.fn("github.listItem")(function* (issue: RawIssue) {
      const rawComments = yield* client.listComments(target, issue.number);
      const comments = rawComments.map(toCoordinationComment(target.actorLogin));
      const id = yield* itemId(issue.number);
      return {
        id,
        title: issue.title,
        url: issue.url,
        roles: rolesFromLabels(issue.labels),
        assignees: issue.assignees,
        claimLabeled: hasClaimLabel(issue.labels),
        openBlockers: issue.openBlockers,
        acceptedClaimants: [target.actorLogin, Coordination.defaultClaimant],
        priority: priorityFor(issue.number),
        comments,
      } satisfies ListedItem<number>;
    });

  const priorityLookup = Effect.fn("github.priorityLookup")(function* (target: GitHubTarget) {
    const fallback = () => defaultPriority;
    const source = target.priority;
    if (!source) return fallback;
    return yield* client.projectPriorities(target, source).pipe(
      Effect.map((byNumber) => (issueNumber: number) => byNumber.get(issueNumber) ?? defaultPriority),
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("priority board read failed; defaulting every item to medium", {
          owner: target.owner,
          name: target.name,
          project: source.project,
          message: error.message,
        }).pipe(Effect.map(() => fallback)),
      ),
    );
  });

  return {
    codec: wireCodec,
    rateLimitScope: () => null,
    list: Effect.fn("github.list")(function* (workspace: WorkspaceIssueTrackerBinding) {
      const configuredTarget = targetFor(workspace);
      if (!configuredTarget) return [];
      const target = yield* authenticatedTarget(configuredTarget);
      const [issues, priorityFor] = yield* Effect.all([client.listIssues(target), priorityLookup(target)]);
      return yield* Effect.forEach(
        issues.filter((issue) => !issue.isPullRequest),
        listItem(target, priorityFor),
        { concurrency: 10 },
      );
    }),
    createIssue: Effect.fn("github.createIssue")(function* (workspace, input) {
      const target = targetFor(workspace);
      if (!target) return yield* notGitHub(workspace);
      yield* client.createIssue(target, input);
    }),
    resolve: Effect.fn("github.resolve")(function* (workspace: WorkspaceIssueTrackerBinding, id: WorkItemId) {
      const configuredTarget = targetFor(workspace);
      if (!configuredTarget) return yield* notGitHub(workspace);
      const target = yield* authenticatedTarget(configuredTarget);
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
