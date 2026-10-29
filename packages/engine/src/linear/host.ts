import { linearTeams, type TriageRole, WorkflowActionArtifact, WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { triageProposalAttribution } from "../comments";
import type { CommentHost, CoordinationComment } from "../coordination";
import * as Coordination from "../coordination";
import type { CoordinationHost, ListedItem } from "../coordination-tracker";
import { type CreateIssueInput, IssueTrackerError } from "../issue-tracker";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { credentialAccountFor } from "./account";
import {
  type LinearClientService,
  type LinearTeamRef,
  type ObservedRawIssue,
  type RawComment,
  rateLimitScopeOf,
} from "./client";
import {
  canceledStateName,
  claimLabel,
  hasClaimLabel,
  ledgerMarker,
  roleLabel,
  roleLabelsFor,
  rolesFrom,
  wireCodec,
} from "./markers";

interface LinearTarget extends LinearTeamRef {
  readonly roleLabels: ReturnType<typeof roleLabelsFor>;
  readonly assigneeAllowlist: ReadonlyArray<string> | null;
}

interface AuthenticatedLinearTarget extends LinearTarget {
  readonly actorUserId: string;
}

interface LinearRef {
  readonly target: AuthenticatedLinearTarget;
  readonly issueId: string;
}

const toCoordinationComment =
  (actorUserId: string) =>
  (comment: RawComment): CoordinationComment<string> => ({
    id: comment.id,
    body: comment.body,
    isBot: comment.authorId === actorUserId,
    createdAtMillis: comment.createdAtMillis,
  });

const coordinationScope = ({ actorUserId }: AuthenticatedLinearTarget) => ({
  actorUserId,
  ledgerMarker,
  proposalMarker: triageProposalAttribution,
});

// One target per configured team, all sharing one credential account so a single token covers the
// whole workspace; only the team key differs, which is what routes a write to its owning team.
const targetsFor = (workspace: WorkspaceIssueTrackerBinding): ReadonlyArray<LinearTarget> => {
  const source = workspace.config.issueTracker;
  const account = credentialAccountFor(workspace.config);
  if (account === null) return [];
  const base = {
    account,
    roleLabels: roleLabelsFor(source.roleLabels),
    assigneeAllowlist: source.assigneeAllowlist ?? null,
  };
  return linearTeams(source).map((team) => ({ team, ...base }) satisfies LinearTarget);
};

// A Linear identifier is `<TEAM-KEY>-<number>` (e.g. `BIL-42`), and team keys never contain a dash,
// so the text before the first dash is the team key that owns the issue.
const teamKeyOf = (identifier: string) => {
  const dash = identifier.indexOf("-");
  return dash === -1 ? identifier : identifier.slice(0, dash);
};

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (identifier: string) => decodeItemId(identifier).pipe(Effect.orDie);

const notLinear = (workspace: WorkspaceIssueTrackerBinding) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a linear work source`,
  });

const canceledStateId = Effect.fn("linear.canceledStateId")(function* (
  client: LinearClientService,
  target: LinearTarget,
) {
  const states = yield* client.listWorkflowStates(target);
  const canceled =
    states.find((state) => state.name === canceledStateName) ??
    states.find((state) => state.type === "canceled");
  if (!canceled) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: `Linear team ${target.team} has no Canceled workflow state`,
    });
  }
  return canceled.id;
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

export const makeIssueActions = (client: LinearClientService) => {
  const targetForCreate = Effect.fn("linear.workflowCreateTarget")(function* (
    workspace: WorkspaceIssueTrackerBinding,
  ) {
    const target = targetsFor(workspace).at(0);
    if (!target) return yield* notLinear(workspace);
    return target;
  });
  const targetForIssue = Effect.fn("linear.workflowIssueTarget")(function* (
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
  const writeOnce = Effect.fn("linear.workflowWriteOnce")(function* (
    target: LinearTarget,
    issue: string,
    writeKey: string,
    applied: (issue: { readonly labels: ReadonlyArray<string>; readonly stateType: string }) => boolean,
    write: Effect.Effect<unknown, IssueTrackerError>,
  ) {
    if (yield* commentsCarry(target, issue, writeKey)) return;
    const current = yield* client.readActionIssue(target, issue);
    if (!applied(current)) yield* write;
    yield* client.createComment(target, issue, writeMarker(writeKey));
    yield* confirmComment(target, issue, writeKey);
  });
  return {
    createIssue: Effect.fn("linear.workflowCreateIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      input: CreateIssueInput,
    ) {
      const target = yield* targetForCreate(workspace);
      const existing = yield* client.findActionIssue(target, writeMarker(input.origin.writeKey));
      if (existing) {
        return WorkflowActionArtifact.make({
          workspace: workspace.config.name,
          issue: yield* itemId(existing.identifier),
          url: existing.url,
          origin: input.origin,
        });
      }
      const created = yield* client.createIssue(target, {
        title: input.title,
        body: markedBody(input.body, input.origin.writeKey),
        labels: input.labels,
      });
      const marker = yield* client.findMarker(target, created.id, writeMarker(input.origin.writeKey));
      if (!marker.body) {
        return yield* writeNotConfirmed(input.origin.writeKey);
      }
      return WorkflowActionArtifact.make({
        workspace: workspace.config.name,
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
      writeKey: string,
    ) {
      const target = yield* targetForIssue(workspace, id);
      yield* writeOnce(
        target,
        id,
        writeKey,
        (issue) => labels.every((label) => issue.labels.includes(label)),
        Effect.forEach(labels, (label) => client.addLabel(target, id, label), { discard: true }),
      );
    }),
    removeLabel: Effect.fn("linear.workflowRemoveLabel")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      label: string,
      writeKey: string,
    ) {
      const target = yield* targetForIssue(workspace, id);
      yield* writeOnce(
        target,
        id,
        writeKey,
        (issue) => !issue.labels.includes(label),
        client.removeLabel(target, id, label),
      );
    }),
    closeIssue: Effect.fn("linear.workflowCloseIssue")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      writeKey: string,
    ) {
      const target = yield* targetForIssue(workspace, id);
      const stateId = yield* completedStateId(client, target);
      yield* writeOnce(
        target,
        id,
        writeKey,
        ({ stateType }) => stateType === "completed",
        client.setState(target, id, stateId),
      );
    }),
  };
};

export const makeHost = (client: LinearClientService): CoordinationHost<LinearRef, string> => {
  const authenticatedTargetsFor = Effect.fn("linear.authenticatedTargetsFor")(function* (
    workspace: WorkspaceIssueTrackerBinding,
  ) {
    const targets = targetsFor(workspace);
    const first = targets.at(0);
    if (!first) return [];
    const actorUserId = yield* client.authenticatedUserId(first);
    return targets.map((target) => ({ ...target, actorUserId }) satisfies AuthenticatedLinearTarget);
  });

  const commentsFor = (target: AuthenticatedLinearTarget, issueId: string): CommentHost<string> => ({
    comments: client
      .listComments(target, issueId, coordinationScope(target))
      .pipe(Effect.map((comments) => comments.map(toCoordinationComment(target.actorUserId)))),
    edit: (id, body) => client.editComment(target, id, body),
    create: (body) => client.createComment(target, issueId, body),
  });

  const listItem = (target: AuthenticatedLinearTarget) =>
    Effect.fn("linear.listItem")(function* (issue: ObservedRawIssue) {
      const id = yield* itemId(issue.identifier);
      return {
        id,
        title: issue.title,
        url: issue.url,
        roles: rolesFrom(issue.labels, { name: issue.stateName, type: issue.stateType }, target.roleLabels),
        assignees: issue.assignees,
        claimLabeled: hasClaimLabel(issue.labels),
        openBlockers: issue.openBlockers,
        acceptedClaimants: [Coordination.defaultClaimant],
        priority: issue.priority,
        comments: issue.coordinationComments.map(toCoordinationComment(target.actorUserId)),
      } satisfies ListedItem<string>;
    });

  return {
    codec: wireCodec,
    rateLimitScope: (workspace: WorkspaceIssueTrackerBinding) => {
      // Every team shares one token, so the whole workspace backs off on one scope.
      const [target] = targetsFor(workspace);
      return target === undefined ? null : rateLimitScopeOf(target.account.tokenEnv);
    },
    list: Effect.fn("linear.list")(function* (workspace: WorkspaceIssueTrackerBinding) {
      const targets = yield* authenticatedTargetsFor(workspace);
      const perTeam = yield* Effect.forEach(targets, (target) =>
        Effect.flatMap(
          client.observeIssues(target, coordinationScope(target), target.assigneeAllowlist),
          (issues) => Effect.forEach(issues, listItem(target)),
        ),
      );
      return perTeam.flat();
    }),
    resolve: Effect.fn("linear.resolve")(function* (workspace: WorkspaceIssueTrackerBinding, id: WorkItemId) {
      const targets = yield* authenticatedTargetsFor(workspace);
      const [first, ...rest] = targets;
      if (first === undefined) {
        return yield* notLinear(workspace);
      }
      // Single-team skips prefix routing, so a UUID-keyed or off-prefix identifier still resolves.
      if (rest.length === 0) {
        return { target: first, issueId: id } satisfies LinearRef;
      }
      const key = teamKeyOf(id);
      const target = targets.find((candidate) => candidate.team === key);
      if (target === undefined) {
        return yield* new IssueTrackerError({
          reason: "unavailable",
          message: `Linear item ${id} does not belong to any configured team (${targets
            .map((candidate) => candidate.team)
            .join(", ")})`,
        });
      }
      return { target, issueId: id } satisfies LinearRef;
    }),
    readProse: (ref) =>
      client.readProse(ref.target, ref.issueId).pipe(
        Effect.map(({ body, comments }) => ({
          body,
          comments: comments.map((comment) => ({
            author: comment.authorId,
            authorAssociation: comment.authorAssociation,
            body: comment.body,
            createdAtMillis: comment.createdAtMillis,
          })),
        })),
      ),
    comments: (ref) => commentsFor(ref.target, ref.issueId),
    claimIdentity: () => Coordination.defaultClaimant,
    addClaim: (ref) => client.addLabel(ref.target, ref.issueId, claimLabel),
    removeClaim: (ref) => client.removeLabel(ref.target, ref.issueId, claimLabel),
    addRole: (ref, role: TriageRole) =>
      client.addLabel(ref.target, ref.issueId, roleLabel(role, ref.target.roleLabels)),
    removeRole: (ref, role: TriageRole) =>
      client.removeLabel(ref.target, ref.issueId, roleLabel(role, ref.target.roleLabels)),
    // Linear closes a wontfix ticket by moving it to the Canceled workflow state; GitHub has no such write.
    afterRoleChange: (ref, changes) =>
      changes.add.includes("wontfix")
        ? Effect.flatMap(canceledStateId(client, ref.target), (stateId) =>
            client.setState(ref.target, ref.issueId, stateId),
          )
        : Effect.void,
  };
};
