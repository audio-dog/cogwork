import {
  type ConnectionBindingId,
  defaultPriority,
  type GitHubPrioritySource,
  type Priority,
  resolvePriority,
  WorkflowActionArtifact,
  type WorkflowActionOrigin,
  WorkItemId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type CreateIssueInput,
  convergeTrackerState,
  IssueTrackerError,
  type TrackerItem,
} from "../issue-tracker";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { type GitHubClientService, type GitHubRepoRef, type RawIssue, repoRefFromRepository } from "./client";
import { wireCodec } from "./markers";

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

export const issueNumberOf = Effect.fn("github.issueNumberOf")(function* (id: string) {
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

export const issuePriorities = Effect.fn("github.issuePriorities")(function* (
  client: GitHubClientService,
  target: GitHubTarget,
  issues: ReadonlyArray<RawIssue>,
) {
  const fallback = new Map<number, Priority>();
  const source = target.priority;
  if (!source) return fallback;
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
        issues.map((issue) => issue.nodeId),
      ),
    ),
    Effect.map(
      (valuesByIssue) =>
        new Map(
          issues.map((issue): readonly [number, Priority] => [
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

export const makeIssueReads = (client: GitHubClientService) => {
  const issueRef = Effect.fn("github.issueRef")(function* (
    workspace: WorkspaceIssueTrackerBinding,
    id: WorkItemId,
  ) {
    const target = targetFor(workspace);
    if (!target) return yield* notGitHub(workspace);
    return { target, number: yield* issueNumberOf(id) };
  });
  return {
    observe: Effect.fn("github.observe")(function* (workspace: WorkspaceIssueTrackerBinding) {
      const target = targetFor(workspace);
      if (!target) return [];
      const issues = (yield* client.listIssues(target)).filter((issue) => !issue.isPullRequest);
      const priorities = yield* issuePriorities(client, target, issues);
      return yield* Effect.forEach(issues, (issue) =>
        Effect.map(
          itemId(issue.number),
          (id): TrackerItem => ({
            id,
            title: issue.title,
            url: issue.url,
            assignees: issue.assignees,
            openBlockers: issue.openBlockers,
            priority: priorities.get(issue.number) ?? defaultPriority,
            states: issue.labels,
            lastTouchedAtMillis: issue.updatedAtMillis ?? issue.createdAtMillis,
          }),
        ),
      );
    }),
    readProse: Effect.fn("github.readProse")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const { target, number } = yield* issueRef(workspace, id);
      const [issue, comments] = yield* Effect.all([
        client.readIssue(target, number),
        client.listAllComments(target, number),
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
    }),
    assignees: Effect.fn("github.assignees")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const { target, number } = yield* issueRef(workspace, id);
      const issue = yield* client.readIssue(target, number);
      return issue.assignees;
    }),
  };
};

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
      kind: "IssueCreated",
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
  const repairCreatedIssueLabels = Effect.fn("github.repairWorkflowCreatedIssueLabels")(function* (
    repo: GitHubTarget,
    issue: RawIssue,
    labels: ReadonlyArray<string>,
  ) {
    const applied = new Set(issue.labels);
    yield* Effect.forEach(
      labels.filter((label) => !applied.has(label)),
      (label) => client.addLabel(repo, issue.number, label),
      { discard: true },
    );
    return issue;
  });
  const recoverCreatedIssue = Effect.fn("github.recoverWorkflowCreatedIssue")(function* (
    repo: GitHubTarget,
    writeKey: string,
    labels: ReadonlyArray<string>,
    error: IssueTrackerError,
  ) {
    if (!error.writeMayHaveCommitted) return yield* error;
    const recovered = yield* client
      .findIssueWithMarker(repo, writeMarker(writeKey))
      .pipe(Effect.catchTag("IssueTrackerError", () => Effect.fail(ambiguousWriteNotConfirmed(writeKey))));
    if (recovered) return yield* repairCreatedIssueLabels(repo, recovered, labels);
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
      if (existing) {
        const repaired = yield* repairCreatedIssueLabels(repo, existing, input.labels);
        return yield* artifact(workspace, repaired, input.origin);
      }
      const created = yield* client
        .createIssue(repo, {
          title: input.title,
          body: markedBody(input.body, input.origin.writeKey),
          labels: input.labels,
        })
        .pipe(Effect.catch((error) => recoverCreatedIssue(repo, input.origin.writeKey, input.labels, error)));
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
    ) {
      const repo = yield* target(workspace);
      const number = yield* issueNumberOf(id);
      yield* convergeTrackerState(
        `GitHub add labels ${labels.join(", ")} to #${number}`,
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
    ) {
      const repo = yield* target(workspace);
      const number = yield* issueNumberOf(id);
      yield* convergeTrackerState(
        `GitHub remove label ${label} from #${number}`,
        client.readIssue(repo, number).pipe(Effect.map((issue) => !issue.labels.includes(label))),
        client.removeLabel(repo, number, label),
      );
    }),
    closeIssue: Effect.fn("github.workflowCloseIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const repo = yield* target(workspace);
      const number = yield* issueNumberOf(id);
      yield* convergeTrackerState(
        `GitHub close #${number}`,
        client.readIssue(repo, number).pipe(Effect.map(({ state }) => state === "closed")),
        client.closeIssue(repo, number),
      );
    }),
  };
};
