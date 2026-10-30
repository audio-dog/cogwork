import {
  type AttemptRecord,
  type Cause,
  type Claim,
  codingOperation,
  type HandbackRecord,
  keyOf,
  type LifecycleStage,
  LineageId,
  type ParkRecord,
  type Priority,
  type RunPlanWorkContextProse,
  type TriageRole,
  type WorkItemId,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { statusReason } from "./comments";
import type { CommentHost, CoordinationComment, WireCodec } from "./coordination";
import * as Coordination from "./coordination";
import type { FollowUpMarker, FollowUpTrigger } from "./follow-up";
import type {
  AttemptFailedOutcome,
  ClaimRequest,
  FollowedUpOutcome,
  HandBackOutcome,
  HandOffOutcome,
  ImplementedOutcome,
  ReclassifyOutcome,
  RoleChanges,
  StalledOutcome,
  TrackerItem,
  TriagedOutcome,
} from "./issue-tracker";
import { IssueTrackerError } from "./issue-tracker";
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

interface TrackerRecords<Ref, CommentId> {
  readonly read: (item: ListedItem<CommentId>) => Effect.Effect<{
    readonly claimHeld: boolean;
    readonly claim: Claim | null;
    readonly claimedByUs: boolean;
    readonly attempts: ReadonlyArray<AttemptRecord>;
    readonly handback: HandbackRecord | null;
  }>;
  readonly claim: (ref: Ref, claim: Claim) => Effect.Effect<void, IssueTrackerError>;
  readonly release: (ref: Ref) => Effect.Effect<void, IssueTrackerError>;
  readonly appendAttempt: (ref: Ref, attempt: AttemptRecord) => Effect.Effect<void, IssueTrackerError>;
  readonly appendHandback: (ref: Ref, handback: HandbackRecord) => Effect.Effect<void, IssueTrackerError>;
  readonly appendAttemptWithReason: (
    ref: Ref,
    attempt: AttemptRecord,
    reason?: string,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly appendHandbackWithNote: (
    ref: Ref,
    handback: HandbackRecord,
    note?: string,
    trigger?: FollowUpTrigger,
  ) => Effect.Effect<void, IssueTrackerError>;
}

const makeTrackerRecords = <Ref, CommentId>(
  host: CoordinationHost<Ref, CommentId>,
): TrackerRecords<Ref, CommentId> => {
  const appendAttemptWithReason = (ref: Ref, attempt: AttemptRecord, reason?: string) => {
    const recordedReason = reason ? statusReason(reason) : undefined;
    const recorded = recordedReason ? { ...attempt, reason: recordedReason } : attempt;
    return Coordination.upsertCoordination(host.codec, host.comments(ref), {
      status: Coordination.attemptStatus(recorded),
      marker: Coordination.serializeAttempt(host.codec, recorded),
    });
  };

  const appendHandbackWithNote = (
    ref: Ref,
    handback: HandbackRecord,
    note?: string,
    trigger?: FollowUpTrigger,
  ) =>
    Coordination.editCoordination(host.codec, host.comments(ref), {
      status: Coordination.handbackStatus(handback, note),
      marker: Coordination.serializeHandback(host.codec, handback, trigger),
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
    release: (ref) => host.removeClaim(ref),
    appendAttempt: (ref, attempt) => appendAttemptWithReason(ref, attempt),
    appendHandback: (ref, handback) => appendHandbackWithNote(ref, handback),
    appendAttemptWithReason,
    appendHandbackWithNote,
  };
};

const trackerAuthorityError = (
  message: string,
  reason: Coordination.CoordinationError["reason"] = "unavailable",
) => new Coordination.CoordinationError({ reason, message, retryable: reason === "unavailable" });
const reportedInvalidTrackerRecords = new Set<string>();

const claimsMatch = (actual: Claim, expected: Claim) =>
  actual.by === expected.by &&
  actual.claimedAtMillis === expected.claimedAtMillis &&
  actual.operation.workflow === expected.operation.workflow &&
  actual.operation.operation === expected.operation.operation &&
  actual.lineage.root === expected.lineage.root &&
  actual.lineage.parent === expected.lineage.parent &&
  actual.lineage.hop === expected.lineage.hop;

export const makeTrackerCoordination = <Ref, CommentId>(
  host: CoordinationHost<Ref, CommentId>,
  workspace: WorkspaceIssueTrackerBinding,
  item: ListedItem<CommentId>,
  claimant = Coordination.defaultClaimant,
) => {
  const records = makeTrackerRecords(host);
  const body = Coordination.selectLedger(host.codec, item.comments)?.body ?? "";
  const spans = host.codec.scan(body);
  const parsedClaims = Coordination.parseClaims(host.codec, body);
  const parsedClaim = parsedClaims.at(-1) ?? null;
  const invalidRecord =
    spans.filter((span) => span.name === "claim").length !== parsedClaims.length ||
    spans.filter((span) => span.name === "attempt").length !==
      Coordination.parseAttempts(host.codec, body).length ||
    spans.filter((span) => span.name === "handback").length !==
      Coordination.parseHandbacks(host.codec, body).length ||
    spans.filter((span) => span.name === "park").length !== Coordination.parseParks(host.codec, body).length;
  const state: { ledger: Coordination.CoordinationLedger } = {
    ledger: {
      claim: item.claimLabeled ? parsedClaim : null,
      claims: parsedClaims,
      latestClaimAtMillis: parsedClaim?.claimedAtMillis,
      latestClaimOperation: parsedClaim?.operation,
      attempts: Coordination.parseAttempts(host.codec, body),
      handbacks: Coordination.parseHandbacks(host.codec, body),
      parks: Coordination.parseParks(host.codec, body),
      revision: null,
    },
  };
  const issueRef = { _tag: "Issue", workspace: workspace.config.name, id: item.id } as const;
  const invalidRecordKey = keyOf(issueRef);
  const matches = (ref: WorkItemRef) =>
    ref._tag === "Issue" && ref.workspace === issueRef.workspace && ref.id === issueRef.id;
  const target = Effect.fn("TrackerCoordination.target")(function* (ref: WorkItemRef) {
    if (!matches(ref)) {
      return yield* trackerAuthorityError("item is not held by this tracker authority", "not-this-authority");
    }
    return yield* host
      .resolve(workspace, item.id)
      .pipe(Effect.mapError((error) => trackerAuthorityError(error.message)));
  });
  const update = (next: Coordination.CoordinationLedger) =>
    Effect.sync(() => {
      state.ledger = next;
    });
  const authority = {
    read: (ref: WorkItemRef) => {
      if (!matches(ref)) {
        return Effect.fail(
          trackerAuthorityError("item is not held by this tracker authority", "not-this-authority"),
        );
      }
      if (!invalidRecord || reportedInvalidTrackerRecords.has(invalidRecordKey)) {
        return Effect.succeed(state.ledger);
      }
      return Effect.sync(() => {
        reportedInvalidTrackerRecords.add(invalidRecordKey);
      }).pipe(
        Effect.andThen(
          Effect.logError("invalid persisted coordination record dropped", {
            authority: "tracker",
            item: item.id,
          }),
        ),
        Effect.map(() => state.ledger),
      );
    },
    claim: (ref: WorkItemRef, record: Claim) =>
      Effect.gen(function* () {
        if (state.ledger.claim !== null) {
          return yield* trackerAuthorityError("item already has an active Claim", "claim-held");
        }
        const native = yield* target(ref);
        yield* records
          .claim(native, record)
          .pipe(Effect.mapError((error) => trackerAuthorityError(error.message)));
        yield* update({
          ...state.ledger,
          claim: record,
          claims: [...(state.ledger.claims ?? []), record],
          latestClaimAtMillis: record.claimedAtMillis,
          latestClaimOperation: record.operation,
        });
      }),
    release: (ref: WorkItemRef, record: Claim) =>
      Effect.gen(function* () {
        if (state.ledger.claim === null || !claimsMatch(state.ledger.claim, record)) {
          return yield* trackerAuthorityError("active Claim does not match expected Claim", "stale-claim");
        }
        const native = yield* target(ref);
        yield* records.release(native).pipe(Effect.mapError((error) => trackerAuthorityError(error.message)));
        yield* update({ ...state.ledger, claim: null });
      }),
    recordAttempt: (ref: WorkItemRef, record: AttemptRecord, reason?: string) =>
      Effect.gen(function* () {
        const native = yield* target(ref);
        yield* records
          .appendAttemptWithReason(native, record, reason)
          .pipe(Effect.mapError((error) => trackerAuthorityError(error.message)));
        yield* update({ ...state.ledger, attempts: [...state.ledger.attempts, record] });
      }),
    park: (ref: WorkItemRef, record: ParkRecord) =>
      Effect.gen(function* () {
        const native = yield* target(ref);
        yield* Coordination.upsertCoordination(host.codec, host.comments(native), {
          marker: Coordination.serializePark(host.codec, record),
        }).pipe(Effect.mapError((error) => trackerAuthorityError(error.message)));
        yield* update({ ...state.ledger, parks: [...state.ledger.parks, record] });
      }),
    handBack: (ref: WorkItemRef, record: HandbackRecord) =>
      Effect.gen(function* () {
        const native = yield* target(ref);
        yield* records
          .appendHandbackWithNote(native, record, record.note ?? undefined)
          .pipe(Effect.mapError((error) => trackerAuthorityError(error.message)));
        yield* update({ ...state.ledger, handbacks: [...state.ledger.handbacks, record] });
      }),
    observe: (_ref: WorkItemRef, _revision: string, _cause: Cause) =>
      Effect.fail(trackerAuthorityError("tracker authority owns source revisions", "not-this-authority")),
    markProcessed: (_ref: WorkItemRef, _revision: string) =>
      Effect.fail(trackerAuthorityError("tracker authority owns source revisions", "not-this-authority")),
  };
  const control = {
    ...authority,
    read: (_ref: WorkItemRef) =>
      Effect.fail(trackerAuthorityError("engine-minted item requires Control store", "not-this-authority")),
  };
  return Coordination.makeCoordination(authority, control, claimant);
};

const lineageFor = (workspace: WorkspaceIssueTrackerBinding, id: WorkItemId) => ({
  root: LineageId.make(keyOf({ _tag: "Issue", workspace: workspace.config.name, id })),
  parent: null,
  hop: 0,
});

export const makeCoordinationTracker = <Ref, CommentId>(host: CoordinationHost<Ref, CommentId>) => {
  const { codec } = host;
  const records = makeTrackerRecords(host);

  const handOffWrite = <A, R>(
    write: Effect.Effect<A, IssueTrackerError, R>,
    item: WorkItemId,
    step: "add role" | "remove role" | "marker" | "note",
  ) =>
    write.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("hand-off write failed", { item, step, message: error.message }),
      ),
    );

  const applyRoles = Effect.fn("coordinationTracker.applyRoles")(function* (
    ref: Ref,
    changes: RoleChanges,
    handOffItem?: WorkItemId,
  ) {
    const addRole = (role: TriageRole) => {
      const write = host.addRole(ref, role);
      return handOffItem === undefined ? write : handOffWrite(write, handOffItem, "add role");
    };
    const removeRole = (role: TriageRole) => {
      const write = host.removeRole(ref, role);
      return handOffItem === undefined ? write : handOffWrite(write, handOffItem, "remove role");
    };
    yield* Effect.forEach(changes.add, addRole);
    yield* Effect.forEach(changes.remove, removeRole).pipe(
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

  const applyEngineHandoff = Effect.fn("coordinationTracker.applyEngineHandoff")(function* (
    ref: Ref,
    stage: LifecycleStage,
    atMillis: number,
    item: WorkItemId,
  ) {
    const changes = { remove: [handoffRoleFor(stage)], add: ["ready-for-human"] } as const;
    yield* applyRoles(ref, changes, item);
    yield* handOffWrite(
      Coordination.upsertCoordination(codec, host.comments(ref), {
        marker: Coordination.serializeEngineHandoff(codec, atMillis),
      }),
      item,
      "marker",
    ).pipe(
      Effect.tapError(() =>
        applyRoles(ref, { remove: changes.add, add: changes.remove }).pipe(
          Effect.catchTag("IssueTrackerError", (error) =>
            Effect.logWarning("engine hand-off rollback failed", { message: error.message }),
          ),
        ),
      ),
    );
  });

  const writeNote = (ref: Ref, detail: string) => Coordination.postNote(codec, host.comments(ref), detail);

  return {
    rateLimitScope: host.rateLimitScope,
    observe: Effect.fn("coordinationTracker.observe")(function* (workspace: WorkspaceIssueTrackerBinding) {
      const listed = yield* host.list(workspace);
      return yield* Effect.forEach(listed, (item) =>
        Effect.flatMap(records.read(item), (state) => {
          const ledger = Coordination.selectLedger(codec, item.comments);
          const body = ledger?.body ?? "";
          const claimant =
            state.claim && item.acceptedClaimants.includes(state.claim.by)
              ? state.claim.by
              : Coordination.defaultClaimant;
          const service = makeTrackerCoordination(host, workspace, item, claimant);
          const ref = { _tag: "Issue", workspace: workspace.config.name, id: item.id } as const;
          return service.read(ref).pipe(
            Effect.mapError(
              (error) => new IssueTrackerError({ reason: "unavailable", message: error.message }),
            ),
            Effect.map(
              (view): TrackerItem => ({
                id: item.id,
                title: item.title,
                url: item.url,
                roles: item.roles,
                assignees: item.assignees,
                ...state,
                engineHandoffAtMillis: Coordination.parseEngineHandoffAtMillis(codec, body),
                followUpTrigger: Coordination.parseFollowUpTrigger(codec, body),
                coordination: view,
                followUp: Coordination.parseFollowUp(codec, body),
                openBlockers: item.openBlockers,
                proposal: Coordination.selectTriageProposal(item.comments),
                priority: item.priority,
              }),
            ),
          );
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
      const claim: Claim = {
        by: host.claimIdentity(ref),
        claimedAtMillis: request.claimedAtMillis,
        operation: codingOperation(request.stage),
        lineage: lineageFor(workspace, id),
      };
      yield* records.claim(ref, claim);
    }),
    release: Effect.fn("coordinationTracker.release")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* records.release(ref);
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
      yield* records.appendAttempt(ref, {
        operation: codingOperation("triage"),
        outcome: "succeeded",
        atMillis: outcome.atMillis,
        lineage: lineageFor(workspace, id),
      });
    }),
    implemented: Effect.fn("coordinationTracker.implemented")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: ImplementedOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* applyRoles(ref, { remove: ["ready-for-agent"], add: [] });
      yield* records.appendAttempt(ref, {
        operation: codingOperation("implement"),
        outcome: "succeeded",
        atMillis: outcome.atMillis,
        lineage: lineageFor(workspace, id),
      });
    }),
    followedUp: Effect.fn("coordinationTracker.followedUp")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: FollowedUpOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* writeFollowUp(ref, outcome.marker, outcome.summary);
      yield* records.appendAttempt(ref, {
        operation: codingOperation("follow-up"),
        outcome: "succeeded",
        atMillis: outcome.atMillis,
        lineage: lineageFor(workspace, id),
      });
    }),
    attemptFailed: Effect.fn("coordinationTracker.attemptFailed")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: AttemptFailedOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      if (outcome.marker) yield* writeFollowUp(ref, outcome.marker);
      yield* records.appendAttemptWithReason(
        ref,
        {
          operation: { workflow: outcome.workflow, operation: outcome.operation },
          outcome: "failed",
          ...(outcome.terminal === true ? { terminal: true } : {}),
          atMillis: outcome.atMillis,
          lineage: lineageFor(workspace, id),
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
      yield* applyEngineHandoff(ref, outcome.stage, yield* Clock.currentTimeMillis, id);
      if (outcome.note !== undefined) yield* handOffWrite(writeNote(ref, outcome.note), id, "note");
    }),
    handBack: Effect.fn("coordinationTracker.handBack")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: HandBackOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* applyRoles(ref, outcome.changes);
      yield* records
        .appendHandbackWithNote(
          ref,
          { ...outcome.record, note: outcome.note ?? null },
          outcome.note,
          outcome.trigger,
        )
        .pipe(
          Effect.tapError(() =>
            applyRoles(ref, { remove: outcome.changes.add, add: outcome.changes.remove }).pipe(
              Effect.catchTag("IssueTrackerError", (error) =>
                Effect.logWarning("handback role rollback failed", { message: error.message }),
              ),
            ),
          ),
        );
    }),
    stalled: Effect.fn("coordinationTracker.stalled")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: StalledOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* writeFollowUp(ref, outcome.marker, outcome.detail);
      yield* applyEngineHandoff(ref, "follow-up", outcome.atMillis, id);
      yield* records.appendAttempt(ref, {
        operation: codingOperation("follow-up"),
        outcome: "abandoned",
        atMillis: outcome.atMillis,
        lineage: lineageFor(workspace, id),
      });
    }),
    reclassify: Effect.fn("coordinationTracker.reclassify")(function* (
      workspace: WorkspaceIssueTrackerBinding,
      id: WorkItemId,
      outcome: ReclassifyOutcome,
    ) {
      const ref = yield* host.resolve(workspace, id);
      yield* applyRoles(ref, outcome.changes);
      yield* Coordination.upsertCoordination(codec, host.comments(ref), {
        marker: Coordination.serializeEngineHandoffCleared(codec),
      }).pipe(
        Effect.tapError(() =>
          applyRoles(ref, { remove: outcome.changes.add, add: outcome.changes.remove }).pipe(
            Effect.catchTag("IssueTrackerError", (error) =>
              Effect.logWarning("reclassification rollback failed", { message: error.message }),
            ),
          ),
        ),
      );
      if (outcome.note !== undefined) yield* writeNote(ref, outcome.note);
    }),
  };
};
