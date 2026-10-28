import {
  type AttemptRecord,
  type Claim,
  codingOperation,
  type LifecycleStage,
  type Priority,
  type RunPlanWorkContextProse,
  type TriageRole,
  type WorkItemId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import { statusReason } from "./comments";
import type { CommentHost, CoordinationComment, WireCodec } from "./coordination";
import * as Coordination from "./coordination";
import type { FollowUpMarker } from "./follow-up";
import type {
  AttemptFailedOutcome,
  ClaimRequest,
  FollowedUpOutcome,
  HandBackOutcome,
  HandOffOutcome,
  ImplementedOutcome,
  IssueTrackerError,
  IssueTrackerService,
  ReclassifyOutcome,
  RoleChanges,
  StalledOutcome,
  TrackerItem,
  TriagedOutcome,
} from "./issue-tracker";
import type { WorkspaceIssueTrackerBinding } from "./projector";

const handoffRoles = {
  triage: "needs-triage",
  implement: "ready-for-agent",
  "follow-up": "ready-for-agent",
} satisfies Record<LifecycleStage, TriageRole>;

export const handoffRoleFor = (stage: LifecycleStage) => handoffRoles[stage];

export interface ListedItem<CommentId> {
  readonly id: WorkItemId;
  readonly title: string;
  readonly url: string;
  readonly roles: ReadonlyArray<TriageRole>;
  readonly assignees: ReadonlyArray<string>;
  readonly claimLabeled: boolean;
  readonly openBlockers: number;
  readonly acceptedClaimants: ReadonlyArray<string>;
  readonly priority: Priority;
  readonly comments: ReadonlyArray<CoordinationComment<CommentId>>;
}

export interface CoordinationHost<Ref, CommentId> {
  readonly codec: WireCodec;
  readonly rateLimitScope: (workspace: WorkspaceIssueTrackerBinding) => string | null;
  readonly list: (
    workspace: WorkspaceIssueTrackerBinding,
  ) => Effect.Effect<ReadonlyArray<ListedItem<CommentId>>, IssueTrackerError>;
  readonly resolve: (
    workspace: WorkspaceIssueTrackerBinding,
    id: WorkItemId,
  ) => Effect.Effect<Ref, IssueTrackerError>;
  readonly readProse: (ref: Ref) => Effect.Effect<RunPlanWorkContextProse, IssueTrackerError>;
  readonly comments: (ref: Ref) => CommentHost<CommentId>;
  readonly claimIdentity: (ref: Ref) => string;
  readonly addClaim: (ref: Ref) => Effect.Effect<void, IssueTrackerError>;
  readonly removeClaim: (ref: Ref) => Effect.Effect<void, IssueTrackerError>;
  readonly addRole: (ref: Ref, role: TriageRole) => Effect.Effect<void, IssueTrackerError>;
  readonly removeRole: (ref: Ref, role: TriageRole) => Effect.Effect<void, IssueTrackerError>;
  readonly afterRoleChange: (ref: Ref, changes: RoleChanges) => Effect.Effect<void, IssueTrackerError>;
}

const buildItem = <CommentId>(codec: WireCodec, item: ListedItem<CommentId>): TrackerItem => {
  const ledger = Coordination.selectLedger(codec, item.comments);
  const body = ledger?.body ?? "";
  const claim = item.claimLabeled ? Coordination.parseClaim(codec, body) : null;
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    roles: item.roles,
    assignees: item.assignees,
    claimLabeled: item.claimLabeled,
    claim,
    claimedByUs: claim ? item.acceptedClaimants.includes(claim.by) : false,
    attempts: Coordination.parseAttempts(codec, body),
    handback: Coordination.parseHandback(codec, body),
    followUp: Coordination.parseFollowUp(codec, body),
    openBlockers: item.openBlockers,
    proposal: Coordination.selectTriageProposal(item.comments),
    priority: item.priority,
  };
};

export const makeCoordinationTracker = <Ref, CommentId>(
  host: CoordinationHost<Ref, CommentId>,
): IssueTrackerService => {
  const { codec } = host;

  const applyRoles = Effect.fn("coordinationTracker.applyRoles")(function* (ref: Ref, changes: RoleChanges) {
    yield* Effect.forEach(changes.add, (role) => host.addRole(ref, role));
    yield* Effect.forEach(changes.remove, (role) => host.removeRole(ref, role)).pipe(
      Effect.tapError(() =>
        Effect.forEach(changes.add, (role) => host.removeRole(ref, role)).pipe(
          Effect.catchTag("IssueTrackerError", (error) =>
            Effect.logWarning("role transition rollback failed", { message: error.message }),
          ),
        ),
      ),
    );
    yield* host.afterRoleChange(ref, changes);
  });

  const writeAttempt = (ref: Ref, attempt: AttemptRecord) => {
    const recorded = attempt.reason ? { ...attempt, reason: statusReason(attempt.reason) } : attempt;
    return Coordination.upsertCoordination(codec, host.comments(ref), {
      status: Coordination.attemptStatus(recorded),
      marker: Coordination.serializeAttempt(codec, recorded),
    });
  };

  const writeFollowUp = (ref: Ref, marker: FollowUpMarker, detail?: string) =>
    Coordination.upsertCoordination(codec, host.comments(ref), {
      marker: Coordination.serializeFollowUp(codec, marker),
      detail,
    });

  const writeNote = (ref: Ref, detail: string) => Coordination.postNote(codec, host.comments(ref), detail);

  return {
    rateLimitScope: host.rateLimitScope,
    observe: Effect.fn("coordinationTracker.observe")(function* (workspace: WorkspaceIssueTrackerBinding) {
      const listed = yield* host.list(workspace);
      return listed.map((item) => buildItem(codec, item));
    }),
    readProse: Effect.fn("coordinationTracker.readProse")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const ref = yield* host.resolve(workspace, id);
      return yield* host.readProse(ref);
    }),
    claim: Effect.fn("coordinationTracker.claim")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      request: ClaimRequest,
    ) {
      const ref = yield* host.resolve(workspace, id);
      const claim: Claim = { ...request, by: host.claimIdentity(ref) };
      yield* Coordination.upsertCoordination(codec, host.comments(ref), {
        status: Coordination.claimStatusFor(claim),
        marker: Coordination.serializeClaim(codec, claim),
      });
      yield* host.addClaim(ref);
    }),
    release: Effect.fn("coordinationTracker.release")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* host.removeClaim(ref);
    }),
    note: Effect.fn("coordinationTracker.note")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      detail: string,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* writeNote(ref, detail);
    }),
    triaged: Effect.fn("coordinationTracker.triaged")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: TriagedOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* writeNote(ref, outcome.proposal);
      yield* applyRoles(ref, { remove: ["needs-triage"], add: [outcome.role] });
      yield* writeAttempt(ref, {
        ...codingOperation("triage"),
        outcome: "succeeded",
        atMillis: outcome.atMillis,
      });
    }),
    implemented: Effect.fn("coordinationTracker.implemented")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: ImplementedOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* applyRoles(ref, { remove: ["ready-for-agent"], add: [] });
      yield* writeAttempt(ref, {
        ...codingOperation("implement"),
        outcome: "succeeded",
        atMillis: outcome.atMillis,
      });
    }),
    followedUp: Effect.fn("coordinationTracker.followedUp")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: FollowedUpOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* writeFollowUp(ref, outcome.marker, outcome.summary);
      yield* writeAttempt(ref, {
        ...codingOperation("follow-up"),
        outcome: "succeeded",
        atMillis: outcome.atMillis,
      });
    }),
    attemptFailed: Effect.fn("coordinationTracker.attemptFailed")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: AttemptFailedOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* writeAttempt(ref, {
        workflow: outcome.workflow,
        operation: outcome.operation,
        outcome: "failed",
        atMillis: outcome.atMillis,
        reason: outcome.reason,
      });
    }),
    handOff: Effect.fn("coordinationTracker.handOff")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: HandOffOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* applyRoles(ref, { remove: [handoffRoleFor(outcome.stage)], add: ["ready-for-human"] });
      if (outcome.note !== undefined) yield* writeNote(ref, outcome.note);
    }),
    handBack: Effect.fn("coordinationTracker.handBack")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: HandBackOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* Coordination.editCoordination(codec, host.comments(ref), {
        status: Coordination.handbackStatus(outcome.record, outcome.note),
        marker: Coordination.serializeHandback(codec, outcome.record),
      });
      yield* applyRoles(ref, outcome.changes);
    }),
    stalled: Effect.fn("coordinationTracker.stalled")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: StalledOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* writeFollowUp(ref, outcome.marker, outcome.detail);
      yield* applyRoles(ref, { remove: [handoffRoleFor("follow-up")], add: ["ready-for-human"] });
      yield* writeAttempt(ref, {
        ...codingOperation("follow-up"),
        outcome: "abandoned",
        atMillis: outcome.atMillis,
      });
    }),
    reclassify: Effect.fn("coordinationTracker.reclassify")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: ReclassifyOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* applyRoles(ref, outcome.changes);
      if (outcome.note !== undefined) yield* writeNote(ref, outcome.note);
    }),
  };
};
