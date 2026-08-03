import { type TriageRole, WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "../projector";
import { WorkSource, WorkSourceError, type WorkSourceService } from "../WorkSource";
import { LinearClient, type LinearClientService, type LinearTeamRef, type RawComment } from "./client";
import {
  attemptStatus,
  canceledStateName,
  claimLabel,
  claimStatus,
  coordinationDetail,
  coordinationMarkers,
  coordinationStatus,
  defaultStatus,
  formatCoordinationBody,
  formatNoteBody,
  hasClaimLabel,
  hasLedgerMarker,
  parseAttempts,
  parseClaim,
  roleLabel,
  roleLabelsFor,
  rolesFrom,
  serializeAttempt,
  serializeClaim,
  serializeFollowUp,
} from "./markers";

interface LinearTarget extends LinearTeamRef {
  readonly botUserId: string | null;
  readonly roleLabels: ReturnType<typeof roleLabelsFor>;
}

interface CoordinationUpdate {
  readonly status?: string;
  readonly marker?: string;
  readonly detail?: string | null;
}

const isBotComment = (comment: RawComment, { botUserId }: LinearTarget) =>
  Boolean(botUserId) && comment.authorId === botUserId;

const botLedger = (comments: ReadonlyArray<RawComment>, target: LinearTarget) =>
  comments
    .filter((comment) => isBotComment(comment, target) && hasLedgerMarker(comment.body))
    .toSorted((left, right) => left.createdAtMillis - right.createdAtMillis)
    .at(0);

const nextDetail = (update: CoordinationUpdate, previous: string) => {
  if (!Object.hasOwn(update, "detail")) return coordinationDetail(previous);
  return update.detail ?? null;
};

const targetFor = (workspace: RegisteredWorkspace) => {
  const source = workspace.config.workSource;
  if (source.type !== "linear" || !source.team) return null;
  return {
    team: source.team,
    tokenEnv: source.tokenEnv ?? "LINEAR_API_KEY",
    botUserId: source.botUserId ?? null,
    roleLabels: roleLabelsFor(source.roleLabels),
  } satisfies LinearTarget;
};

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (identifier: string) => decodeItemId(identifier).pipe(Effect.orDie);

const notLinear = (workspace: RegisteredWorkspace) =>
  new WorkSourceError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a linear work source`,
  });

const make = (client: LinearClientService): WorkSourceService => {
  const requireTarget = Effect.fn("linear.requireTarget")(function* (workspace: RegisteredWorkspace) {
    const target = targetFor(workspace);
    if (!target) {
      return yield* notLinear(workspace);
    }
    return target;
  });

  const upsertCoordination = Effect.fn("linear.upsertCoordination")(function* (
    target: LinearTarget,
    issueId: string,
    update: CoordinationUpdate,
  ) {
    const comments = yield* client.listComments(target, issueId);
    const ledger = botLedger(comments, target);
    const previous = ledger?.body ?? "";
    const markers = coordinationMarkers(previous);
    const body = formatCoordinationBody({
      status: update.status ?? coordinationStatus(previous) ?? defaultStatus,
      markers: update.marker === undefined ? markers : [...markers, update.marker],
      detail: nextDetail(update, previous),
    });
    if (ledger) {
      yield* client.editComment(target, ledger.id, body);
      return;
    }
    yield* client.createComment(target, issueId, body);
  });

  const buildItem = (target: LinearTarget) =>
    Effect.fn("linear.buildItem")(function* (issue: {
      readonly id: string;
      readonly identifier: string;
      readonly title: string;
      readonly labels: ReadonlyArray<string>;
      readonly stateName: string;
      readonly stateType: string;
    }) {
      const claimLabeled = hasClaimLabel(issue.labels);
      const comments = target.botUserId ? yield* client.listComments(target, issue.identifier) : [];
      const coordination = botLedger(comments, target)?.body ?? "";
      const id = yield* itemId(issue.identifier);
      return {
        id,
        title: issue.title,
        roles: rolesFrom(issue.labels, { name: issue.stateName, type: issue.stateType }, target.roleLabels),
        claimLabeled,
        claim: claimLabeled ? parseClaim(coordination) : null,
        attempts: parseAttempts(coordination),
        pr: null,
        openBlockers: 0,
      };
    });

  const observeTarget = Effect.fn("linear.observeTarget")(function* (target: LinearTarget) {
    const issues = yield* client.listIssues(target);
    return yield* Effect.forEach(issues, buildItem(target));
  });

  const canceledStateId = Effect.fn("linear.canceledStateId")(function* (target: LinearTarget) {
    const states = yield* client.listWorkflowStates(target);
    const canceled =
      states.find((state) => state.name === canceledStateName) ??
      states.find((state) => state.type === "canceled");
    if (!canceled) {
      return yield* new WorkSourceError({
        reason: "unavailable",
        message: `Linear team ${target.team} has no Canceled workflow state`,
      });
    }
    return canceled.id;
  });

  return {
    observe: (workspace) =>
      Effect.gen(function* () {
        const target = targetFor(workspace);
        if (!target) {
          return [];
        }
        return yield* observeTarget(target);
      }),
    claim: (workspace, id, claim) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* client.addLabel(target, id, claimLabel);
        const status = claim.stage ? claimStatus(claim.stage) : `In progress — claimed by ${claim.by}.`;
        yield* upsertCoordination(target, id, { status, marker: serializeClaim(claim) });
      }),
    release: (workspace, id) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* client.removeLabel(target, id, claimLabel);
      }),
    recordAttempt: (workspace, id, attempt, reason) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* upsertCoordination(target, id, {
          status: attemptStatus(attempt, reason),
          marker: serializeAttempt(attempt),
        });
      }),
    recordFollowUp: (workspace, id, marker, detail) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        yield* upsertCoordination(target, id, { marker: serializeFollowUp(marker), detail });
      }),
    note: (workspace, id, detail) =>
      Effect.gen(function* () {
        const target = yield* requireTarget(workspace);
        const comments = yield* client.listComments(target, id);
        const ledger = botLedger(comments, target);
        if (ledger && coordinationDetail(ledger.body) !== null) {
          yield* upsertCoordination(target, id, { detail: null });
        }
        yield* client.createComment(target, id, formatNoteBody(detail));
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
  WorkSource,
  Effect.gen(function* () {
    const client = yield* LinearClient;
    return make(client);
  }),
);

export { make as makeAdapter };
