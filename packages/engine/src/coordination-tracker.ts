import {
  type AttemptRecord,
  type Claim,
  codingOperation,
  type HandbackRecord,
  type LifecycleStage,
  type Priority,
  type RunPlanWorkContextProse,
  type TriageRole,
  type WorkItemId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import type { CommentHost, CoordinationComment, WireCodec } from "./coordination";
import * as Coordination from "./coordination";
import type { CoordinationAdapter } from "./coordination-adapter";
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

interface TrackerCoordinationAdapter<Ref, CommentId>
  extends CoordinationAdapter<ListedItem<CommentId>, Ref, IssueTrackerError> {
  readonly appendAttemptWithReason: (
    ref: Ref,
    attempt: AttemptRecord,
    reason?: string,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly appendHandbackWithNote: (
    ref: Ref,
    handback: HandbackRecord,
    note?: string,
  ) => Effect.Effect<void, IssueTrackerError>;
}

export const makeTrackerCoordinationAdapter = <Ref, CommentId>(
  host: CoordinationHost<Ref, CommentId>,
): TrackerCoordinationAdapter<Ref, CommentId> => {
  const appendAttemptWithReason = (ref: Ref, attempt: AttemptRecord, reason?: string) =>
    Coordination.upsertCoordination(host.codec, host.comments(ref), {
      status: Coordination.attemptStatus(attempt, reason),
      marker: Coordination.serializeAttempt(host.codec, attempt),
    });

  const appendHandbackWithNote = (ref: Ref, handback: HandbackRecord, note?: string) =>
    Coordination.editCoordination(host.codec, host.comments(ref), {
      status: Coordination.handbackStatus(handback, note),
      marker: Coordination.serializeHandback(host.codec, handback),
    });

  return {
    read: (item) => {
      const ledger = Coordination.selectLedger(host.codec, item.comments);
      const body = ledger?.body ?? "";
      const claim = item.claimLabeled ? Coordination.parseClaim(host.codec, body) : null;
      return Effect.succeed({
        claimHeld: item.claimLabeled,
        claim,
        claimedByUs: claim ? item.acceptedClaimants.includes(claim.by) : false,
        attempts: Coordination.parseAttempts(host.codec, body),
        handback: Coordination.parseHandback(host.codec, body),
      });
    },
    claim: (ref, claim) =>
      Coordination.upsertCoordination(host.codec, host.comments(ref), {
        status: Coordination.claimStatusFor(claim),
        marker: Coordination.serializeClaim(host.codec, claim),
      }).pipe(Effect.andThen(host.addClaim(ref))),
    release: host.removeClaim,
    appendAttempt: (ref, attempt) => appendAttemptWithReason(ref, attempt),
    appendHandback: (ref, handback) => appendHandbackWithNote(ref, handback),
    appendAttemptWithReason,
    appendHandbackWithNote,
  };
};

export const makeCoordinationTracker = <Ref, CommentId>(
  host: CoordinationHost<Ref, CommentId>,
): IssueTrackerService => {
  const { codec } = host;
  const coordination = makeTrackerCoordinationAdapter(host);

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
      return yield* Effect.forEach(listed, (item) =>
        Effect.map(coordination.read(item), (state): TrackerItem => {
          const ledger = Coordination.selectLedger(codec, item.comments);
          const body = ledger?.body ?? "";
          return {
            id: item.id,
            title: item.title,
            url: item.url,
            roles: item.roles,
            assignees: item.assignees,
            ...state,
            followUp: Coordination.parseFollowUp(codec, body),
            openBlockers: item.openBlockers,
            proposal: Coordination.selectTriageProposal(item.comments),
            priority: item.priority,
          };
        }),
      );
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
      yield* coordination.claim(ref, claim);
    }),
    release: Effect.fn("coordinationTracker.release")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* coordination.release(ref);
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
      yield* coordination.appendAttempt(ref, {
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
      yield* coordination.appendAttempt(ref, {
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
      yield* coordination.appendAttempt(ref, {
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
      yield* coordination.appendAttemptWithReason(
        ref,
        {
          workflow: outcome.workflow,
          operation: outcome.operation,
          outcome: "failed",
          atMillis: outcome.atMillis,
        },
        outcome.reason,
      );
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
      yield* coordination.appendHandbackWithNote(ref, outcome.record, outcome.note);
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
      yield* coordination.appendAttempt(ref, {
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
