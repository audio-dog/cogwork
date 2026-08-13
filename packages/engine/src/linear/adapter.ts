import { type Claim, type OAuthAppConfig, type TriageRole, WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { triageProposalAttribution } from "../comments";
import type { CommentHost, CoordinationComment } from "../coordination";
import * as Coordination from "../coordination";
import {
  type ClaimRequest,
  IssueTracker,
  IssueTrackerError,
  type IssueTrackerService,
  type TrackerItem,
} from "../issue-tracker";
import type { RegisteredWorkspace } from "../projector";
import {
  LinearClient,
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

const toCoordinationComment =
  (actorUserId: string | null) =>
  (comment: RawComment): CoordinationComment<string> => ({
    id: comment.id,
    body: comment.body,
    isBot: actorUserId !== null && comment.authorId === actorUserId,
    createdAtMillis: comment.createdAtMillis,
  });

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

const make = (client: LinearClientService): IssueTrackerService => {
  const requireTarget = Effect.fn("linear.requireTarget")(function* (workspace: RegisteredWorkspace) {
    const target = targetFor(workspace);
    if (!target) {
      return yield* notLinear(workspace);
    }
    return target;
  });

  const coordinationHost = (target: LinearTarget, issueId: string): CommentHost<string> => ({
    comments: client
      .listComments(target, issueId)
      .pipe(Effect.map((comments) => comments.map(toCoordinationComment(target.actorUserId)))),
    edit: (id, body) => client.editComment(target, id, body),
    create: (body) => client.createComment(target, issueId, body),
  });

  const buildItem = (target: LinearTarget) =>
    Effect.fn("linear.buildItem")(function* (issue: ObservedRawIssue) {
      const claimLabeled = hasClaimLabel(issue.labels);
      const comments = issue.coordinationComments.map(toCoordinationComment(target.actorUserId));
      const ledger = Coordination.selectLedger(wireCodec, comments);
      const body = ledger?.body ?? "";
      const id = yield* itemId(issue.identifier);
      const claim = claimLabeled ? Coordination.parseClaim(wireCodec, body) : null;
      return {
        id,
        title: issue.title,
        roles: rolesFrom(issue.labels, { name: issue.stateName, type: issue.stateType }, target.roleLabels),
        assignees: issue.assignees,
        claimLabeled,
        claim,
        claimedByUs: claim?.by === Coordination.defaultClaimant,
        attempts: Coordination.parseAttempts(wireCodec, body),
        owned: ledger !== undefined,
        followUp: Coordination.parseFollowUp(wireCodec, body),
        openBlockers: issue.openBlockers,
        proposal: Coordination.selectTriageProposal(comments),
      } satisfies TrackerItem;
    });

  const observeTarget = Effect.fn("linear.observeTarget")(function* (target: LinearTarget) {
    const issues = yield* client.observeIssues(target, coordinationScope(target));
    return yield* Effect.forEach(issues, buildItem(target));
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
    rateLimitScope: (workspace) => {
      const target = targetFor(workspace);
      return target === null ? null : rateLimitScopeOf(target.tokenEnv);
    },
    observe: (workspace) =>
      Effect.gen(function* () {
        const target = targetFor(workspace);
        if (!target) {
          return [];
        }
        return yield* observeTarget(target);
      }),
    claim: (workspace, id, request: ClaimRequest) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        const claim: Claim = { ...request, by: Coordination.defaultClaimant };
        yield* client.addLabel(target, id, claimLabel);
        yield* Coordination.upsertCoordination(wireCodec, coordinationHost(target, id), {
          status: Coordination.claimStatusFor(claim),
          marker: Coordination.serializeClaim(wireCodec, claim),
        });
      }),
    release: (workspace, id) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* client.removeLabel(target, id, claimLabel);
      }),
    recordAttempt: (workspace, id, attempt, reason) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* Coordination.upsertCoordination(wireCodec, coordinationHost(target, id), {
          status: Coordination.attemptStatus(attempt, reason),
          marker: Coordination.serializeAttempt(wireCodec, attempt),
        });
      }),
    recordFollowUp: (workspace, id, marker, detail) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* Coordination.upsertCoordination(wireCodec, coordinationHost(target, id), {
          marker: Coordination.serializeFollowUp(wireCodec, marker),
          detail,
        });
      }),
    note: (workspace, id, detail) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* Coordination.postNote(wireCodec, coordinationHost(target, id), detail);
      }),
    setRoles: (workspace, id, changes) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        const label = (role: TriageRole) => roleLabel(role, target.roleLabels);
        yield* Effect.forEach(changes.remove, (role) => client.removeLabel(target, id, label(role)));
        yield* Effect.forEach(changes.add, (role) => client.addLabel(target, id, label(role)));
        if (!changes.add.includes("wontfix")) return;
        const stateId = yield* canceledStateId(target);
        yield* client.setState(target, id, stateId);
      }),
  };
};

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* LinearClient;
    return make(client);
  }),
);

export { make as makeAdapter };
