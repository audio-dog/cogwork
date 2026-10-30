import {
  type ConnectionBindingId,
  defaultPriority,
  type GitHubPrioritySource,
  type Priority,
  resolvePriority,
  type TriageRole,
  WorkflowActionArtifact,
  type WorkflowActionOrigin,
  WorkItemId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CommentHost, CoordinationComment } from "../coordination";
import * as Coordination from "../coordination";
import type { CoordinationHost, ListedItem } from "../coordination-tracker";
import { type CreateIssueInput, IssueTrackerError } from "../issue-tracker";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import {
  type GitHubClientService,
  type GitHubRepoRef,
  type RawIssue,
  type RawIssueComment,
  repoRefFromRepository,
} from "./client";
import { claimLabel, hasClaimLabel, roleLabel, rolesFromLabels, wireCodec } from "./markers";

export interface GitHubTarget extends GitHubRepoRef {
  readonly priority: GitHubPrioritySource | null;
}

export const repoTargetFor = (workspace: WorkspaceIssueTrackerBinding, connection: ConnectionBindingId) => {
  if (!workspace.repository) return null;
  const repo = repoRefFromRepository(workspace.repository);
  if (!repo) return null;
  const target: GitHubRepoRef = connection === "unbound" ? repo : { ...repo, connectionId: connection };
  return target;
};

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
  (comment: RawIssueComment): CoordinationComment<number> => ({
    id: comment.id,
    body: comment.body,
    isBot: comment.authorLogin === actorLogin,
    createdAtMillis: comment.createdAtMillis,
  });

export const targetFor = (workspace: WorkspaceIssueTrackerBinding) => {
  const source = workspace.config.issueTracker;
  if (source.type !== "github") return null;
  const repo = repoTargetFor(workspace, source.connectionId);
  if (!repo) return null;
  return {
    ...repo,
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
    message: `workspace ${workspace.config.name} does not use GitHub Issues`,
  });

const writeMarker = (writeKey: string) =>
  wireCodec.encode({ name: "write", pairs: `key=${encodeURIComponent(writeKey)}` });

const carriesWriteKey = (body: string, writeKey: string) =>
  wireCodec
    .scan(body)
    .some(({ name, pairs }) => name === "write" && pairs === `key=${encodeURIComponent(writeKey)}`);

const markedBody = (body: string, writeKey: string) => [body.trim(), writeMarker(writeKey)].join("\n\n");

const writeNotConfirmed = (writeKey: string) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `GitHub write ${writeKey} was not confirmed by read-back`,
  });

const ambiguousWriteNotConfirmed = (writeKey: string) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    writeMayHaveCommitted: true,
    message: `GitHub write ${writeKey} may have committed but was not confirmed by read-back`,
  });

export const makeIssueActions = (client: GitHubClientService) => {
  const target = Effect.fn("github.workflowActionTarget")(function* (
    workspace: WorkspaceIssueTrackerBinding,
  ) {
    const resolved = targetFor(workspace);
    if (!resolved) return yield* notGitHub(workspace);
    return resolved;
  });
  const artifact = Effect.fn("github.workflowActionArtifact")(function* (
    workspace: WorkspaceIssueTrackerBinding,
    issue: RawIssue,
    origin: WorkflowActionOrigin,
  ) {
    return WorkflowActionArtifact.make({
      workspace: workspace.config.name,
      issue: yield* itemId(issue.number),
      url: issue.url,
      origin,
    });
  });
  const commentsCarry = (repo: GitHubTarget, number: number, writeKey: string) =>
    client
      .listAllComments(repo, number)
      .pipe(Effect.map((comments) => comments.some(({ body }) => carriesWriteKey(body, writeKey))));
  const confirmComment = Effect.fn("github.confirmWorkflowComment")(function* (
    repo: GitHubTarget,
    number: number,
    writeKey: string,
  ) {
    if (yield* commentsCarry(repo, number, writeKey)) return;
    return yield* writeNotConfirmed(writeKey);
  });
  const writeOnce = Effect.fn("github.workflowWriteOnce")(function* (
    repo: GitHubTarget,
    number: number,
    writeKey: string,
    applied: Effect.Effect<boolean, IssueTrackerError>,
    write: Effect.Effect<unknown, IssueTrackerError>,
  ) {
    if (yield* commentsCarry(repo, number, writeKey)) return;
    if (!(yield* applied)) yield* write;
    yield* client.createComment(repo, number, writeMarker(writeKey));
    yield* confirmComment(repo, number, writeKey);
  });
  const recoverCreatedIssue = Effect.fn("github.recoverWorkflowCreatedIssue")(function* (
    repo: GitHubTarget,
    writeKey: string,
    error: IssueTrackerError,
  ) {
    if (!error.writeMayHaveCommitted) return yield* error;
    const recovered = yield* client
      .findIssueWithMarker(repo, writeMarker(writeKey))
      .pipe(Effect.catchTag("IssueTrackerError", () => Effect.fail(ambiguousWriteNotConfirmed(writeKey))));
    if (recovered) return recovered;
    return yield* ambiguousWriteNotConfirmed(writeKey);
  });
  const confirmCreatedIssue = Effect.fn("github.confirmWorkflowCreatedIssue")(function* (
    repo: GitHubTarget,
    issue: RawIssue,
    writeKey: string,
  ) {
    if (carriesWriteKey(issue.body, writeKey)) return issue;
    const confirmed = yield* client.readIssue(repo, issue.number);
    if (carriesWriteKey(confirmed.body, writeKey)) return confirmed;
    return yield* ambiguousWriteNotConfirmed(writeKey);
  });
  return {
    createIssue: Effect.fn("github.workflowCreateIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      input: CreateIssueInput,
    ) {
      const repo = yield* target(workspace);
      const existing = yield* client.findIssueWithMarker(repo, writeMarker(input.origin.writeKey));
      if (existing) return yield* artifact(workspace, existing, input.origin);
      const created = yield* client
        .createIssue(repo, {
          title: input.title,
          body: markedBody(input.body, input.origin.writeKey),
          labels: input.labels,
        })
        .pipe(Effect.catch((error) => recoverCreatedIssue(repo, input.origin.writeKey, error)));
      const confirmed = yield* confirmCreatedIssue(repo, created, input.origin.writeKey);
      return yield* artifact(workspace, confirmed, input.origin);
    }),
    commentIssue: Effect.fn("github.workflowCommentIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      body: string,
      writeKey: string,
    ) {
      const repo = yield* target(workspace);
      const number = yield* issueNumberOf(id);
      if (yield* commentsCarry(repo, number, writeKey)) return;
      yield* client.createComment(repo, number, markedBody(body, writeKey));
      yield* confirmComment(repo, number, writeKey);
    }),
    addLabels: Effect.fn("github.workflowAddLabels")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      labels: ReadonlyArray<string>,
      writeKey: string,
    ) {
      const repo = yield* target(workspace);
      const number = yield* issueNumberOf(id);
      yield* writeOnce(
        repo,
        number,
        writeKey,
        client
          .readIssue(repo, number)
          .pipe(Effect.map((issue) => labels.every((label) => issue.labels.includes(label)))),
        Effect.forEach(labels, (label) => client.addLabel(repo, number, label), { discard: true }),
      );
    }),
    removeLabel: Effect.fn("github.workflowRemoveLabel")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      label: string,
      writeKey: string,
    ) {
      const repo = yield* target(workspace);
      const number = yield* issueNumberOf(id);
      yield* writeOnce(
        repo,
        number,
        writeKey,
        client.readIssue(repo, number).pipe(Effect.map((issue) => !issue.labels.includes(label))),
        client.removeLabel(repo, number, label),
      );
    }),
    closeIssue: Effect.fn("github.workflowCloseIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      writeKey: string,
    ) {
      const repo = yield* target(workspace);
      const number = yield* issueNumberOf(id);
      yield* writeOnce(
        repo,
        number,
        writeKey,
        client.readIssue(repo, number).pipe(Effect.map(({ state }) => state === "closed")),
        client.closeIssue(repo, number),
      );
    }),
  };
};

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

  const readProse = Effect.fn("github.readProse")(function* (ref: GitHubRef) {
    const [issue, comments] = yield* Effect.all([
      client.readIssue(ref.target, ref.number),
      client.listAllComments(ref.target, ref.number),
    ]);
    return {
      body: issue.body,
      comments: comments.map((comment) => ({
        author: comment.authorLogin,
        authorAssociation: comment.authorAssociation,
        body: comment.body,
        createdAtMillis: comment.createdAtMillis,
      })),
    };
  });

  const listItem = (target: AuthenticatedGitHubTarget, priorities: ReadonlyMap<number, Priority>) =>
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
        priority: priorities.get(issue.number) ?? defaultPriority,
        comments,
      } satisfies ListedItem<number>;
    });

  const priorityLookup = Effect.fn("github.priorityLookup")(function* (
    target: GitHubTarget,
    issues: ReadonlyArray<RawIssue>,
  ) {
    const fallback = new Map<number, Priority>();
    const source = target.priority;
    if (!source) return fallback;
    const openIssues = issues.filter((issue) => !issue.isPullRequest);
    return yield* client.listPriorityFields(target).pipe(
      Effect.filterOrFail(
        (fields) => fields.some((field) => field.id === source.field),
        () =>
          new IssueTrackerError({
            reason: "unavailable",
            message: `GitHub issue field ${source.field} is not an available single-select field`,
          }),
      ),
      Effect.flatMap(() =>
        client.listIssueFieldValues(
          target,
          openIssues.map((issue) => issue.nodeId),
        ),
      ),
      Effect.map(
        (valuesByIssue) =>
          new Map(
            openIssues.map((issue): readonly [number, Priority] => [
              issue.number,
              resolvePriority(valuesByIssue.get(issue.number)?.get(source.field)),
            ]),
          ),
      ),
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("priority issue field read failed; defaulting every item to medium", {
          owner: target.owner,
          name: target.name,
          field: source.field,
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
      const issues = yield* client.listIssues(target);
      const priorities = yield* priorityLookup(target, issues);
      return yield* Effect.forEach(
        issues.filter((issue) => !issue.isPullRequest),
        listItem(target, priorities),
        { concurrency: 10 },
      );
    }),
    resolve: Effect.fn("github.resolve")(function* (workspace: WorkspaceIssueTrackerBinding, id: WorkItemId) {
      const configuredTarget = targetFor(workspace);
      if (!configuredTarget) return yield* notGitHub(workspace);
      const target = yield* authenticatedTarget(configuredTarget);
      const number = yield* issueNumberOf(id);
      return { target, number } satisfies GitHubRef;
    }),
    readProse,
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
