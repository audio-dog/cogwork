import type { AttemptRecord, Claim, TriageRole, WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import type { CommentHost, CoordinationComment, WireCodec } from "./coordination";
import * as Coordination from "./coordination";
import type {
  ClaimRequest,
  FollowUpMarker,
  IssueTrackerError,
  IssueTrackerService,
  RoleChanges,
  TrackerItem,
} from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

export interface ListedItem<CommentId> {
  readonly id: WorkItemId;
  readonly title: string;
  readonly roles: ReadonlyArray<TriageRole>;
  readonly assignees: ReadonlyArray<string>;
  readonly claimLabeled: boolean;
  readonly openBlockers: number;
  readonly claimIdentity: string;
  readonly comments: ReadonlyArray<CoordinationComment<CommentId>>;
}

export interface CoordinationHost<Ref, CommentId> {
  readonly codec: WireCodec;
  readonly rateLimitScope: (workspace: RegisteredWorkspace) => string | null;
  readonly list: (
    workspace: RegisteredWorkspace,
  ) => Effect.Effect<ReadonlyArray<ListedItem<CommentId>>, IssueTrackerError>;
  readonly resolve: (workspace: RegisteredWorkspace, id: WorkItemId) => Effect.Effect<Ref, IssueTrackerError>;
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
    roles: item.roles,
    assignees: item.assignees,
    claimLabeled: item.claimLabeled,
    claim,
    claimedByUs: claim?.by === item.claimIdentity,
    attempts: Coordination.parseAttempts(codec, body),
    owned: ledger !== undefined,
    followUp: Coordination.parseFollowUp(codec, body),
    openBlockers: item.openBlockers,
    proposal: Coordination.selectTriageProposal(item.comments),
  };
};

export const makeCoordinationTracker = <Ref, CommentId>(
  host: CoordinationHost<Ref, CommentId>,
): IssueTrackerService => {
  const { codec } = host;
  return {
    rateLimitScope: host.rateLimitScope,
    observe: Effect.fn("coordinationTracker.observe")(function* (workspace: RegisteredWorkspace) {
      const listed = yield* host.list(workspace);
      return listed.map((item) => buildItem(codec, item));
    }),
    claim: Effect.fn("coordinationTracker.claim")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      request: ClaimRequest,
    ) {
      const ref = yield* host.resolve(workspace, id);
      const claim: Claim = { ...request, by: host.claimIdentity(ref) };
      yield* host.addClaim(ref);
      yield* Coordination.upsertCoordination(codec, host.comments(ref), {
        status: Coordination.claimStatusFor(claim),
        marker: Coordination.serializeClaim(codec, claim),
      });
    }),
    release: Effect.fn("coordinationTracker.release")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* host.removeClaim(ref);
    }),
    recordAttempt: Effect.fn("coordinationTracker.recordAttempt")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      attempt: AttemptRecord,
      reason?: string,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* Coordination.upsertCoordination(codec, host.comments(ref), {
        status: Coordination.attemptStatus(attempt, reason),
        marker: Coordination.serializeAttempt(codec, attempt),
      });
    }),
    recordFollowUp: Effect.fn("coordinationTracker.recordFollowUp")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      marker: FollowUpMarker,
      detail?: string,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* Coordination.upsertCoordination(codec, host.comments(ref), {
        marker: Coordination.serializeFollowUp(codec, marker),
        detail,
      });
    }),
    note: Effect.fn("coordinationTracker.note")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      detail: string,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* Coordination.postNote(codec, host.comments(ref), detail);
    }),
    setRoles: Effect.fn("coordinationTracker.setRoles")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      changes: RoleChanges,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* Effect.forEach(changes.remove, (role) => host.removeRole(ref, role));
      yield* Effect.forEach(changes.add, (role) => host.addRole(ref, role));
      yield* host.afterRoleChange(ref, changes);
    }),
  };
};
