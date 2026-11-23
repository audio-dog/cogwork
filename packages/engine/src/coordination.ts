import {
  type AttemptOutcome,
  AttemptRecord,
  type Cause,
  Claim,
  type Claim as ClaimType,
  type HandbackRecord as HandbackRecordType,
  type Lineage,
  type OperationKey,
  type ParkReason,
  type ParkRecord,
  type SourceRevision,
  type WorkflowId,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const defaultClaimant = "cogwork";
export const maxLineageHops = 25;
const maxConsecutiveFailures = 3;

export interface CoordinationLedger {
  readonly claim: ClaimType | null;
  readonly claims?: ReadonlyArray<ClaimType>;
  readonly latestClaimAtMillis?: number;
  readonly latestClaimOperation?: OperationKey;
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly handbacks: ReadonlyArray<HandbackRecordType>;
  readonly parks: ReadonlyArray<ParkRecord>;
  readonly revision: SourceRevision | null;
}

export interface CoordinationCounters {
  readonly consecutiveFailures: number;
  readonly exhausted: boolean;
  readonly hop: number;
  readonly hopCapped: boolean;
}

export type CoordinationGate =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Claimed"; readonly claim: ClaimType }
  | { readonly _tag: "Quiet" }
  | { readonly _tag: "Parked"; readonly reason: ParkReason };

export interface CoordinationView {
  readonly claim: ClaimType | null;
  readonly claimedByUs: boolean;
  readonly barrierAtMillis: number;
  readonly handback: HandbackRecordType | null;
  readonly park: ParkRecord | null;
  readonly revision: SourceRevision | null;
  readonly actedOn: (workflow: WorkflowId) => boolean;
  readonly counters: (key: OperationKey) => CoordinationCounters;
  readonly gate: (key: OperationKey, sourceRevision?: string) => CoordinationGate;
  readonly failedAttemptAtMillis: (key: OperationKey) => number | null;
}

const sameOperation = (left: OperationKey, right: OperationKey) =>
  left.workflow === right.workflow && left.operation === right.operation;

const failureStateFor = (
  attempts: ReadonlyArray<AttemptRecord>,
  barrierAtMillis: number,
  key: OperationKey,
) => {
  const relevant = attempts.filter(
    (attempt) => attempt.atMillis > barrierAtMillis && sameOperation(attempt.operation, key),
  );
  const lastNonFailure = relevant.findLastIndex((attempt) => attempt.outcome !== "failed");
  const failures = relevant.slice(lastNonFailure + 1);
  return {
    consecutiveFailures: failures.length,
    terminal:
      failures.length >= maxConsecutiveFailures || failures.some((attempt) => attempt.terminal === true),
  };
};

const newestByTime = <A extends { readonly atMillis: number }>(records: ReadonlyArray<A>) =>
  records.reduce<A | null>(
    (latest, record) => (latest === null || record.atMillis > latest.atMillis ? record : latest),
    null,
  );

interface ClaimStamp {
  readonly atMillis: number;
  readonly operation: OperationKey;
}

const claimClearsPark = (park: ParkRecord | null, claims: ReadonlyArray<ClaimStamp>) =>
  park !== null &&
  claims.some((claim) => {
    const claimMatchesOperation =
      park.operation === undefined || sameOperation(park.operation, claim.operation);
    return claim.atMillis >= park.atMillis && claimMatchesOperation;
  });

const recordedClaimOf = (ledger: CoordinationLedger) => {
  const { latestClaimAtMillis, latestClaimOperation } = ledger;
  const hasRecordedClaim = latestClaimAtMillis !== undefined && latestClaimOperation !== undefined;
  if (!hasRecordedClaim) return null;
  return { atMillis: latestClaimAtMillis, operation: latestClaimOperation };
};

const claimStampsOf = (ledger: CoordinationLedger) => {
  const claims = ledger.claims?.map(({ claimedAtMillis, operation }) => ({
    atMillis: claimedAtMillis,
    operation,
  }));
  const recordedClaim = recordedClaimOf(ledger);
  const legacyClaims = recordedClaim === null ? [] : [recordedClaim];
  const activeClaims =
    ledger.claim === null
      ? []
      : [{ atMillis: ledger.claim.claimedAtMillis, operation: ledger.claim.operation }];
  return [...(claims ?? legacyClaims), ...activeClaims];
};

interface GateInput {
  readonly ledger: CoordinationLedger;
  readonly park: ParkRecord | null;
  readonly counters: CoordinationCounters;
}

const revisionClearedParks = new Set<ParkReason["_tag"]>([
  "MissingOperation",
  "PlanRejected",
  "AwaitingApproval",
]);

const failureParks = new Set<ParkReason["_tag"]>(["Stuck", "Exhausted"]);

const gateRules = [
  {
    when: ({ ledger }: GateInput) => ledger.claim !== null,
    resolve: ({ ledger }: GateInput): CoordinationGate => ({
      _tag: "Claimed",
      claim: ledger.claim as ClaimType,
    }),
  },
  {
    when: ({ ledger }: GateInput) =>
      ledger.revision !== null && ledger.revision.observed === ledger.revision.processed,
    resolve: (): CoordinationGate => ({ _tag: "Quiet" }),
  },
  {
    when: ({ park }: GateInput) => park !== null,
    resolve: ({ park }: GateInput): CoordinationGate => ({
      _tag: "Parked",
      reason: (park as ParkRecord).reason,
    }),
  },
  {
    when: ({ counters }: GateInput) => counters.hopCapped,
    resolve: (): CoordinationGate => ({ _tag: "Parked", reason: { _tag: "HopCap" } }),
  },
] as const;

export const fold = (ledger: CoordinationLedger, claimant: string): CoordinationView => {
  const handback = newestByTime(ledger.handbacks);
  const barrierAtMillis = handback?.atMillis ?? 0;
  const activeParks = ledger.parks.filter((park) => park.atMillis > barrierAtMillis);
  const latestPark = newestByTime(activeParks);
  const claims = claimStampsOf(ledger);
  const park = claimClearsPark(latestPark, claims) ? null : latestPark;
  const countersAfter = (key: OperationKey, afterMillis: number): CoordinationCounters => {
    const claimAfterBarrier =
      ledger.claim && ledger.claim.claimedAtMillis > afterMillis ? ledger.claim : null;
    const attemptsAfterBarrier = ledger.attempts.filter((attempt) => attempt.atMillis > afterMillis);
    const hop = claimAfterBarrier?.lineage.hop ?? newestByTime(attemptsAfterBarrier)?.lineage.hop ?? 0;
    const { consecutiveFailures, terminal } = failureStateFor(ledger.attempts, afterMillis, key);
    return {
      consecutiveFailures,
      exhausted: terminal,
      hop,
      hopCapped: hop >= maxLineageHops,
    };
  };
  const counters = (key: OperationKey) => countersAfter(key, barrierAtMillis);
  const holdingPark = (key: OperationKey, revisionMovedPast: (candidate: ParkRecord) => boolean) => {
    const matchingPark = newestByTime(
      activeParks.filter((candidate) => {
        const matchesOperation = candidate.operation === undefined || sameOperation(candidate.operation, key);
        const clearedByRevision =
          revisionMovedPast(candidate) && revisionClearedParks.has(candidate.reason._tag);
        return matchesOperation && !clearedByRevision;
      }),
    );
    return claimClearsPark(matchingPark, claims) ? null : matchingPark;
  };
  const failedAttemptAtMillis = (key: OperationKey) => {
    const held = holdingPark(key, () => false);
    if (held === null || !failureParks.has(held.reason._tag)) return null;
    const failures = ledger.attempts.filter(
      (attempt) => attempt.outcome === "failed" && sameOperation(attempt.operation, key),
    );
    return newestByTime(failures)?.atMillis ?? held.atMillis;
  };
  const gate = (key: OperationKey, sourceRevision?: string): CoordinationGate => {
    const processedRevision = ledger.revision?.processed;
    const hasProcessedRevision = processedRevision !== null && processedRevision !== undefined;
    const revisionMovedPast = (candidate: ParkRecord) =>
      sourceRevision !== undefined &&
      (hasProcessedRevision
        ? sourceRevision !== processedRevision
        : candidate.reason._tag === "AwaitingApproval" && sourceRevision !== candidate.reason.revision);
    const isNewSourceRevision =
      sourceRevision !== undefined &&
      (hasProcessedRevision ? sourceRevision !== processedRevision : activeParks.some(revisionMovedPast));
    const input = {
      ledger,
      park: holdingPark(key, revisionMovedPast),
      counters: isNewSourceRevision
        ? { consecutiveFailures: 0, exhausted: false, hop: 0, hopCapped: false }
        : countersAfter(key, barrierAtMillis),
    };
    return gateRules.find(({ when }) => when(input))?.resolve(input) ?? { _tag: "Open" };
  };
  return {
    claim: ledger.claim,
    claimedByUs: ledger.claim?.by === claimant,
    barrierAtMillis,
    handback,
    park,
    revision: ledger.revision,
    actedOn: (workflow) =>
      ledger.attempts.some(
        (attempt) => attempt.operation.workflow === workflow && attempt.outcome === "succeeded",
      ),
    counters,
    gate,
    failedAttemptAtMillis,
  };
};

export class CoordinationError extends Schema.TaggedError<CoordinationError>()("CoordinationError", {
  reason: Schema.Literals(["unavailable", "refused", "claim-held", "stale-claim", "not-this-authority"]),
  retryable: Schema.Boolean,
  message: Schema.String,
}) {}

interface CoordinationAuthority {
  readonly read: (ref: WorkItemRef) => Effect.Effect<CoordinationLedger, CoordinationError>;
  readonly claim: (ref: WorkItemRef, claim: ClaimType) => Effect.Effect<void, CoordinationError>;
  readonly release: (ref: WorkItemRef, claim: ClaimType) => Effect.Effect<void, CoordinationError>;
  readonly recordAttempt: (
    ref: WorkItemRef,
    attempt: AttemptRecord,
    reason?: string,
  ) => Effect.Effect<void, CoordinationError>;
  readonly park: (ref: WorkItemRef, park: ParkRecord) => Effect.Effect<void, CoordinationError>;
  readonly handBack: (ref: WorkItemRef, record: HandbackRecordType) => Effect.Effect<void, CoordinationError>;
  readonly observe: (
    ref: WorkItemRef,
    revision: string,
    cause: Cause,
  ) => Effect.Effect<"moved" | "redelivered", CoordinationError>;
  readonly markProcessed: (ref: WorkItemRef, revision: string) => Effect.Effect<void, CoordinationError>;
}

export interface CoordinationService {
  readonly fold: typeof fold;
  readonly read: (ref: WorkItemRef) => Effect.Effect<CoordinationView, CoordinationError>;
  readonly claim: (
    ref: WorkItemRef,
    input: { readonly operation: OperationKey; readonly lineage: Lineage },
  ) => Effect.Effect<ClaimType, CoordinationError>;
  readonly release: (ref: WorkItemRef, claim: ClaimType) => Effect.Effect<void, CoordinationError>;
  readonly recordAttempt: (
    ref: WorkItemRef,
    input: {
      readonly operation: OperationKey;
      readonly outcome: AttemptOutcome;
      readonly lineage: Lineage;
      readonly reason?: string;
    },
  ) => Effect.Effect<CoordinationView, CoordinationError>;
  readonly park: (
    ref: WorkItemRef,
    reason: ParkReason,
    operation?: OperationKey,
  ) => Effect.Effect<CoordinationView, CoordinationError>;
  readonly handBack: (
    ref: WorkItemRef,
    input: { readonly by: string; readonly note?: string },
  ) => Effect.Effect<CoordinationView, CoordinationError>;
  readonly observe: (
    ref: WorkItemRef,
    revision: string,
    cause: Cause,
  ) => Effect.Effect<"moved" | "redelivered", CoordinationError>;
  readonly markProcessed: (ref: WorkItemRef, revision: string) => Effect.Effect<void, CoordinationError>;
}

type AuthorityByTag = { [Tag in WorkItemRef["_tag"]]: CoordinationAuthority };

export const makeCoordination = (
  tracker: CoordinationAuthority,
  control: CoordinationAuthority,
  claimant = defaultClaimant,
): CoordinationService => {
  const authorities = {
    Issue: tracker,
    PullRequest: control,
    GranolaNote: control,
    SlackMessage: control,
    SlackConversation: control,
    ScheduleInstant: control,
    FanOutChild: control,
  } satisfies AuthorityByTag;
  const authority = (ref: WorkItemRef) => authorities[ref._tag];
  const read = (ref: WorkItemRef) =>
    authority(ref)
      .read(ref)
      .pipe(Effect.map((ledger) => fold(ledger, claimant)));
  const claim = Effect.fn("Coordination.claim")(function* (
    ref: WorkItemRef,
    input: { readonly operation: OperationKey; readonly lineage: Lineage },
  ) {
    const claimedAtMillis = yield* Clock.currentTimeMillis;
    const record = Claim.make({ ...input, by: claimant, claimedAtMillis });
    yield* authority(ref).claim(ref, record);
    return record;
  });
  const recordAttempt = Effect.fn("Coordination.recordAttempt")(function* (
    ref: WorkItemRef,
    input: {
      readonly operation: OperationKey;
      readonly outcome: AttemptOutcome;
      readonly lineage: Lineage;
      readonly reason?: string;
    },
  ) {
    const atMillis = yield* Clock.currentTimeMillis;
    const attempt = AttemptRecord.make({
      operation: input.operation,
      outcome: input.outcome,
      lineage: input.lineage,
      atMillis,
    });
    yield* authority(ref).recordAttempt(ref, attempt, input.reason);
    return yield* read(ref);
  });
  const park = Effect.fn("Coordination.park")(function* (
    ref: WorkItemRef,
    reason: ParkReason,
    operation?: OperationKey,
  ) {
    yield* authority(ref).park(ref, {
      reason,
      ...(operation ? { operation } : {}),
      atMillis: yield* Clock.currentTimeMillis,
    });
    return yield* read(ref);
  });
  const handBack = Effect.fn("Coordination.handBack")(function* (
    ref: WorkItemRef,
    input: { readonly by: string; readonly note?: string },
  ) {
    yield* authority(ref).handBack(ref, {
      by: input.by,
      note: input.note ?? null,
      atMillis: yield* Clock.currentTimeMillis,
    });
    return yield* read(ref);
  });
  return {
    fold,
    read,
    claim,
    release: (ref, record) => authority(ref).release(ref, record),
    recordAttempt,
    park,
    handBack,
    observe: (ref, revision, cause) => authority(ref).observe(ref, revision, cause),
    markProcessed: (ref, revision) => authority(ref).markProcessed(ref, revision),
  };
};

export class Coordination extends Context.Service<Coordination, CoordinationService>()(
  "@cogwork/engine/coordination",
) {}

export const layer = (service: CoordinationService) => Layer.succeed(Coordination, service);
