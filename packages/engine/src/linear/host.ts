import { linearTeams, WorkflowActionArtifact, WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type CreateIssueInput,
  convergeTrackerState,
  IssueTrackerError,
  type ListedTrackerItem,
  type TrackerComment,
} from "../issue-tracker";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { credentialAccountFor } from "./account";
import type { LinearClientService } from "./client";
import type { RawIssue } from "./client-issue-mapping";
import { isResolvedState } from "./client-queries";
import type { LinearTeamRef } from "./client-transport";
import { hasCogworkMarker, wireCodec } from "./markers";

interface LinearTarget extends LinearTeamRef {
  readonly account: LinearTeamRef["account"];
}

// One target per configured team, all sharing one credential account so a single token covers the
// whole workspace; only the team key differs, which is what routes a write to its owning team.
const targetsFor = (workspace: WorkspaceIssueTrackerBinding): ReadonlyArray<LinearTarget> => {
  const source = workspace.config.issueTracker;
  const account = credentialAccountFor(workspace.config);
  if (account === null) return [];
  const base = { account };
  return linearTeams(source).map((team) => ({ team, ...base }) satisfies LinearTarget);
};

// A Linear identifier is `<TEAM-KEY>-<number>` (e.g. `BIL-42`), and team keys never contain a dash,
// so the text before the first dash is the team key that owns the issue.
const teamKeyOf = (identifier: string) => {
  const dash = identifier.indexOf("-");
  return dash === -1 ? identifier : identifier.slice(0, dash);
};

const decodeKeySegment = Option.liftThrowable(decodeURIComponent);

const issueOriginOf = (key: string) => {
  const [kind, encodedWorkspace, encodedId, extra] = key.split(":");
  const invalidShape = kind !== "issue" || !encodedWorkspace || !encodedId || extra !== undefined;
  if (invalidShape) return null;
  const workspace = decodeKeySegment(encodedWorkspace);
  const id = decodeKeySegment(encodedId);
  if (Option.isNone(workspace) || Option.isNone(id)) return null;
  return { workspace: workspace.value, id: id.value };
};

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (identifier: string) => decodeItemId(identifier).pipe(Effect.orDie);

const notLinear = (workspace: WorkspaceIssueTrackerBinding) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `workspace ${workspace.config.id} is not a linear work source`,
  });

const completedStateId = Effect.fn("linear.completedStateId")(function* (
  client: LinearClientService,
  target: LinearTarget,
) {
  const states = yield* client.listWorkflowStates(target);
  const completed = states.find((state) => state.type === "completed");
  if (!completed) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: `Linear team ${target.team} has no completed workflow state`,
    });
  }
  return completed.id;
});

const writeMarker = (writeKey: string) =>
  wireCodec.encode({ name: "write", pairs: `key=${encodeURIComponent(writeKey)}` });

const markedBody = (body: string, writeKey: string) => [body.trim(), writeMarker(writeKey)].join("\n\n");

const writeNotConfirmed = (writeKey: string) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `Linear write ${writeKey} was not confirmed by read-back`,
  });

const ambiguousWriteNotConfirmed = (writeKey: string) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    writeMayHaveCommitted: true,
    message: `Linear write ${writeKey} may have committed but was not confirmed by read-back`,
  });

const targetForIssue = Effect.fn("linear.issueTarget")(function* (
  workspace: WorkspaceIssueTrackerBinding,
  id: WorkItemId,
) {
  const targets = targetsFor(workspace);
  if (targets.length === 0) return yield* notLinear(workspace);
  const target = targets.find(({ team }) => team === teamKeyOf(id));
  if (!target) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: `Linear item ${id} does not belong to a configured team`,
    });
  }
  return target;
});

const listedItem = (issue: RawIssue) =>
  Effect.map(
    itemId(issue.identifier),
    (id): ListedTrackerItem => ({
      id,
      title: issue.title,
      url: issue.url,
      assignees: issue.assignees,
      openBlockers: issue.openBlockers,
      priority: issue.priority,
      states: [...issue.labels, issue.stateName],
      open: !isResolvedState(issue.stateType),
      labels: issue.labels,
      createdAtMillis: issue.createdAtMillis ?? issue.updatedAtMillis,
      lastTouchedAtMillis: issue.updatedAtMillis,
    }),
  );

const listItems = Effect.fn("linear.listItems")(function* (
  workspace: WorkspaceIssueTrackerBinding,
  readTeam: (target: LinearTarget) => Effect.Effect<ReadonlyArray<RawIssue>, IssueTrackerError>,
) {
  const perTeam = yield* Effect.forEach(targetsFor(workspace), readTeam);
  return yield* Effect.forEach(perTeam.flat(), listedItem);
});

export const makeIssueReads = (client: LinearClientService) => {
  return {
    observe: (workspace: WorkspaceIssueTrackerBinding) =>
      listItems(workspace, (target) => client.observeIssues(target, null)),
    openItemsChangedSince: (workspace: WorkspaceIssueTrackerBinding, sinceMillis: number) =>
      listItems(workspace, (target) =>
        client.observeOpenIssuesSince(target, sinceMillis, workspace.config.issueTracker.assigneeAllowlist),
      ),
    openItemsWithLabel: (workspace: WorkspaceIssueTrackerBinding, label: string) =>
      listItems(workspace, (target) =>
        client.observeLabelledIssues(target, label, workspace.config.issueTracker.assigneeAllowlist),
      ),
    readItem: Effect.fn("linear.readItem")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const target = yield* targetForIssue(workspace, id);
      const issue = yield* client.readTriggerIssue(target, id);
      if (issue === null) return null;
      return yield* listedItem(issue);
    }),
    readProse: Effect.fn("linear.readProse")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const target = yield* targetForIssue(workspace, id);
      const { body, comments } = yield* client.readProse(target, id);
      return {
        body,
        comments: comments.map((comment) => ({
          author: comment.authorId,
          authorAssociation: comment.authorAssociation,
          body: comment.body,
          createdAtMillis: comment.createdAtMillis,
        })),
      };
    }),
    readTriggerProse: Effect.fn("linear.readTriggerProse")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const target = yield* targetForIssue(workspace, id);
      const { body, comments } = yield* client.readTriggerProse(target, id);
      return {
        body,
        comments: comments.map(
          (comment): TrackerComment => ({
            id: comment.id,
            author: comment.authorId,
            authorAssociation: comment.authorAssociation,
            authoredByPerson: comment.authorAssociation !== "NONE" && !hasCogworkMarker(comment.body),
            body: comment.body,
            createdAtMillis: comment.createdAtMillis,
          }),
        ),
      };
    }),
    labelAppliedAt: Effect.fn("linear.labelAppliedAt")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      label: string,
    ) {
      const target = yield* targetForIssue(workspace, id);
      return yield* client.labelAppliedAt(target, id, label);
    }),
    listLabels: Effect.fn("linear.listLabels")(function* (workspace: WorkspaceIssueTrackerBinding) {
      const perTeam = yield* Effect.forEach(targetsFor(workspace), client.listLabels);
      return perTeam.flat();
    }),
    assignees: Effect.fn("linear.assignees")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const target = yield* targetForIssue(workspace, id);
      return yield* client.issueAssignees(target, id);
    }),
  };
};

export const makeIssueActions = (client: LinearClientService) => {
  const targetForCreate = Effect.fn("linear.workflowCreateTarget")(function* (
    workspace: WorkspaceIssueTrackerBinding,
    input: CreateIssueInput,
  ) {
    const targets = targetsFor(workspace);
    const origin = issueOriginOf(input.origin.item);
    const originMatchesWorkspace = origin?.workspace === workspace.config.id;
    const originTeam = originMatchesWorkspace ? teamKeyOf(origin.id) : null;
    const target = targets.find(({ team }) => team === originTeam) ?? targets.at(0);
    if (!target) return yield* notLinear(workspace);
    return target;
  });
  const commentsCarry = (target: LinearTarget, issue: string, writeKey: string) =>
    client.findMarker(target, issue, writeMarker(writeKey)).pipe(Effect.map(({ comment }) => comment));
  const confirmComment = Effect.fn("linear.confirmWorkflowComment")(function* (
    target: LinearTarget,
    issue: string,
    writeKey: string,
  ) {
    if (yield* commentsCarry(target, issue, writeKey)) return;
    return yield* writeNotConfirmed(writeKey);
  });
  const recoverCreatedIssue = Effect.fn("linear.recoverWorkflowCreatedIssue")(function* (
    target: LinearTarget,
    writeKey: string,
    error: IssueTrackerError,
  ) {
    if (!error.writeMayHaveCommitted) return yield* error;
    const recovered = yield* client.findActionIssue(target, writeMarker(writeKey));
    if (recovered) return recovered;
    return yield* ambiguousWriteNotConfirmed(writeKey);
  });
  const confirmCreatedIssue = Effect.fn("linear.confirmWorkflowCreatedIssue")(function* (
    target: LinearTarget,
    issue: { readonly id: string },
    writeKey: string,
  ) {
    const marker = yield* client.findMarker(target, issue.id, writeMarker(writeKey));
    if (marker.body) return;
    return yield* ambiguousWriteNotConfirmed(writeKey);
  });
  return {
    createIssue: Effect.fn("linear.workflowCreateIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      input: CreateIssueInput,
    ) {
      const target = yield* targetForCreate(workspace, input);
      const existing = yield* client.findActionIssue(target, writeMarker(input.origin.writeKey));
      if (existing) {
        return WorkflowActionArtifact.make({
          kind: "IssueCreated",
          workspace: workspace.config.id,
          issue: yield* itemId(existing.identifier),
          url: existing.url,
          origin: input.origin,
        });
      }
      const created = yield* client
        .createIssue(target, {
          title: input.title,
          body: markedBody(input.body, input.origin.writeKey),
          labels: input.labels,
        })
        .pipe(Effect.catch((error) => recoverCreatedIssue(target, input.origin.writeKey, error)));
      yield* confirmCreatedIssue(target, created, input.origin.writeKey);
      return WorkflowActionArtifact.make({
        kind: "IssueCreated",
        workspace: workspace.config.id,
        issue: yield* itemId(created.identifier),
        url: created.url,
        origin: input.origin,
      });
    }),
    commentIssue: Effect.fn("linear.workflowCommentIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      body: string,
      writeKey: string,
    ) {
      const target = yield* targetForIssue(workspace, id);
      if (yield* commentsCarry(target, id, writeKey)) return;
      yield* client.createComment(target, id, markedBody(body, writeKey));
      yield* confirmComment(target, id, writeKey);
    }),
    addLabels: Effect.fn("linear.workflowAddLabels")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      labels: ReadonlyArray<string>,
    ) {
      const target = yield* targetForIssue(workspace, id);
      yield* convergeTrackerState(
        `Linear add labels ${labels.join(", ")} to ${id}`,
        client
          .readActionIssue(target, id)
          .pipe(Effect.map((issue) => labels.every((label) => issue.labels.includes(label)))),
        Effect.forEach(labels, (label) => client.addLabel(target, id, label), { discard: true }),
      );
    }),
    removeLabel: Effect.fn("linear.workflowRemoveLabel")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      label: string,
    ) {
      const target = yield* targetForIssue(workspace, id);
      yield* convergeTrackerState(
        `Linear remove label ${label} from ${id}`,
        client.readActionIssue(target, id).pipe(Effect.map((issue) => !issue.labels.includes(label))),
        client.removeLabel(target, id, label),
      );
    }),
    closeIssue: Effect.fn("linear.workflowCloseIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const target = yield* targetForIssue(workspace, id);
      yield* convergeTrackerState(
        `Linear close ${id}`,
        client.readActionIssue(target, id).pipe(Effect.map(({ stateType }) => stateType === "completed")),
        completedStateId(client, target).pipe(
          Effect.flatMap((stateId) => client.setState(target, id, stateId)),
        ),
      );
    }),
  };
};
