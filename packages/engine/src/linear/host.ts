import { type OAuthAppConfig, type TriageRole, WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { triageProposalAttribution } from "../comments";
import type { CommentHost, CoordinationComment } from "../coordination";
import * as Coordination from "../coordination";
import type { CoordinationHost, ListedItem } from "../coordination-tracker";
import { IssueTrackerError } from "../issue-tracker";
import type { RegisteredWorkspace } from "../projector";
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
  readonly actorUserId: string | null;
  readonly roleLabels: ReturnType<typeof roleLabelsFor>;
}

interface LinearRef {
  readonly target: LinearTarget;
  readonly issueId: string;
}

const toCoordinationComment =
  (actorUserId: string | null) =>
  (comment: RawComment): CoordinationComment<string> => ({
    id: comment.id,
    body: comment.body,
    isBot: actorUserId !== null && comment.authorId === actorUserId,
    createdAtMillis: comment.createdAtMillis,
  });

// With no configured bot user the daemon cannot tell its own comments apart, so the scope stays null
// and observe reads no coordination state rather than trusting an unattributable comment.
const coordinationScope = ({ actorUserId }: LinearTarget) =>
  actorUserId === null ? null : { actorUserId, ledgerMarker, proposalMarker: triageProposalAttribution };

const clientCredentialsFor = (oauth: OAuthAppConfig | undefined) =>
  oauth?.clientSecretEnv ? { clientId: oauth.clientId, secretEnv: oauth.clientSecretEnv } : null;

const targetFor = (workspace: RegisteredWorkspace) => {
  const source = workspace.config.issueTracker;
  if (source.type !== "linear" || !source.team) return null;
  return {
    team: source.team,
    tokenEnv: source.tokenEnv ?? "LINEAR_API_KEY",
    organization: source.organization ?? null,
    clientCredentials: clientCredentialsFor(source.oauth),
    oauthClientId: source.oauth?.clientId ?? null,
    actorUserId: source.actorUserId ?? null,
    roleLabels: roleLabelsFor(source.roleLabels),
  } satisfies LinearTarget;
};

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (identifier: string) => decodeItemId(identifier).pipe(Effect.orDie);

const notLinear = (workspace: RegisteredWorkspace) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a linear work source`,
  });

export const makeHost = (client: LinearClientService): CoordinationHost<LinearRef, string> => {
  const commentsFor = (target: LinearTarget, issueId: string): CommentHost<string> => ({
    comments: client
      .listComments(target, issueId)
      .pipe(Effect.map((comments) => comments.map(toCoordinationComment(target.actorUserId)))),
    edit: (id, body) => client.editComment(target, id, body),
    create: (body) => client.createComment(target, issueId, body),
  });

  const listItem = (target: LinearTarget) =>
    Effect.fn("linear.listItem")(function* (issue: ObservedRawIssue) {
      const id = yield* itemId(issue.identifier);
      return {
        id,
        title: issue.title,
        roles: rolesFrom(issue.labels, { name: issue.stateName, type: issue.stateType }, target.roleLabels),
        assignees: issue.assignees,
        claimLabeled: hasClaimLabel(issue.labels),
        openBlockers: issue.openBlockers,
        claimIdentity: Coordination.defaultClaimant,
        comments: issue.coordinationComments.map(toCoordinationComment(target.actorUserId)),
      } satisfies ListedItem<string>;
    });

  const canceledStateId = Effect.fn("linear.canceledStateId")(function* (target: LinearTarget) {
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

  return {
    codec: wireCodec,
    rateLimitScope: (workspace: RegisteredWorkspace) => {
      const target = targetFor(workspace);
      return target === null ? null : rateLimitScopeOf(target.tokenEnv);
    },
    list: Effect.fn("linear.list")(function* (workspace: RegisteredWorkspace) {
      const target = targetFor(workspace);
      if (!target) {
        return [];
      }
      const issues = yield* client.observeIssues(target, coordinationScope(target));
      return yield* Effect.forEach(issues, listItem(target));
    }),
    resolve: Effect.fn("linear.resolve")(function* (workspace: RegisteredWorkspace, id: WorkItemId) {
      const target = targetFor(workspace);
      if (!target) {
        return yield* notLinear(workspace);
      }
      return { target, issueId: id } satisfies LinearRef;
    }),
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
        ? Effect.flatMap(canceledStateId(ref.target), (stateId) =>
            client.setState(ref.target, ref.issueId, stateId),
          )
        : Effect.void,
  };
};
