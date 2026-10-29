import {
  type AttemptOutcome,
  AttemptRecord,
  type Cause,
  Claim,
  type Claim as ClaimType,
  HandbackRecord,
  type HandbackRecord as HandbackRecordType,
  type LifecycleStage,
  type Lineage,
  type OperationKey,
  type ParkReason,
  type ParkRecord,
  ParkRecord as ParkRecordSchema,
  type SourceRevision,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { markdownCode, parseTriageProposal, statusReason } from "./comments";
import { FollowUpMarker, type FollowUpTrigger } from "./follow-up";
import { IssueTrackerError } from "./issue-tracker";

export interface MarkerSpan {
  readonly name: string;
  readonly pairs: string;
  readonly start: number;
  readonly end: number;
}

export interface WireCodec {
  readonly ledgerMarker: string;
  readonly encode: (marker: { readonly name: string; readonly pairs: string }) => string;
  readonly scan: (body: string) => ReadonlyArray<MarkerSpan>;
}

export interface CoordinationComment<Id> {
  readonly id: Id;
  readonly body: string;
  readonly isBot: boolean;
  readonly createdAtMillis: number;
}

export interface CommentHost<Id> {
  readonly comments: Effect.Effect<ReadonlyArray<CoordinationComment<Id>>, IssueTrackerError>;
  readonly edit: (id: Id, body: string) => Effect.Effect<void, IssueTrackerError>;
  readonly create: (body: string) => Effect.Effect<void, IssueTrackerError>;
}

export interface CoordinationUpdate {
  readonly status?: string;
  readonly marker?: string;
  readonly detail?: string | null;
}

export interface CoordinationBody {
  readonly status: string;
  readonly markers: ReadonlyArray<string>;
  readonly detail: string | null;
}

const attribution = "> *This was posted by cogwork.*";

export const defaultClaimant = "cogwork";
export const maxAttemptsPerOperation = 3;
export const maxLineageHops = 25;

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
  readonly park: ParkRecord | null;
  readonly revision: SourceRevision | null;
  readonly counters: (key: OperationKey) => CoordinationCounters;
  readonly gate: (key: OperationKey) => CoordinationGate;
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
    terminal: failures.some((attempt) => attempt.terminal === true),
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
  {
    when: ({ counters }: GateInput) => counters.exhausted,
    resolve: (): CoordinationGate => ({
      _tag: "Parked",
      reason: { _tag: "Exhausted", reason: "failure limit" },
    }),
  },
] as const;

export const fold = (ledger: CoordinationLedger, claimant: string): CoordinationView => {
  const handback = newestByTime(ledger.handbacks);
  const barrierAtMillis = handback?.atMillis ?? 0;
  const activeParks = ledger.parks.filter((park) => park.atMillis > barrierAtMillis);
  const latestPark = newestByTime(activeParks);
  const claims = claimStampsOf(ledger);
  const park = claimClearsPark(latestPark, claims) ? null : latestPark;
  const claimAfterBarrier =
    ledger.claim && ledger.claim.claimedAtMillis > barrierAtMillis ? ledger.claim : null;
  const attemptsAfterBarrier = ledger.attempts.filter((attempt) => attempt.atMillis > barrierAtMillis);
  const hop = claimAfterBarrier?.lineage.hop ?? newestByTime(attemptsAfterBarrier)?.lineage.hop ?? 0;
  const counters = (key: OperationKey): CoordinationCounters => {
    const { consecutiveFailures, terminal } = failureStateFor(ledger.attempts, barrierAtMillis, key);
    return {
      consecutiveFailures,
      exhausted: terminal || consecutiveFailures >= maxAttemptsPerOperation,
      hop,
      hopCapped: hop >= maxLineageHops,
    };
  };
  const gate = (key: OperationKey): CoordinationGate => {
    const matchingPark = newestByTime(
      activeParks.filter(
        (candidate) => candidate.operation === undefined || sameOperation(candidate.operation, key),
      ),
    );
    const input = {
      ledger,
      park: claimClearsPark(matchingPark, claims) ? null : matchingPark,
      counters: counters(key),
    };
    return gateRules.find(({ when }) => when(input))?.resolve(input) ?? { _tag: "Open" };
  };
  return {
    claim: ledger.claim,
    claimedByUs: ledger.claim?.by === claimant,
    barrierAtMillis,
    park,
    revision: ledger.revision,
    counters,
    gate,
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

const stageGerund: Record<LifecycleStage, string> = {
  triage: "triaging",
  implement: "implementing",
  "follow-up": "following up on",
};

export const defaultStatus = "Working on this issue.";

export const claimStatus = (stage: LifecycleStage) => `Currently ${stageGerund[stage]} this issue.`;

export const claimStatusFor = (claim: ClaimType) => {
  const stage = claim.operation.operation as LifecycleStage;
  const isCodingStage = claim.operation.workflow === "coding" && Object.hasOwn(stageGerund, stage);
  return isCodingStage ? claimStatus(stage) : `In progress — claimed by ${claim.by}.`;
};

export const attemptStatus = (attempt: AttemptRecord) => {
  if (attempt.outcome === "succeeded") return `${attempt.operation.operation} completed.`;
  if (attempt.outcome === "abandoned") return `${attempt.operation.operation} abandoned.`;
  const trimmed = attempt.reason ? statusReason(attempt.reason) : "";
  if (trimmed) return `Last ${attempt.operation.operation} attempt failed: ${markdownCode(trimmed)}`;
  return `Last ${attempt.operation.operation} attempt failed.`;
};

export const handbackStatus = (handback: HandbackRecordType, note?: string) => {
  const detail = note ? statusReason(note) : statusReason(handback.note ?? "");
  return detail ? `Handed back by ${handback.by}: ${detail}` : `Handed back by ${handback.by}.`;
};

const okToArray = <A>(result: Result.Result<A, unknown>): ReadonlyArray<A> =>
  Result.isSuccess(result) ? [result.success] : [];

const toPair = (token: string) => {
  const eq = token.indexOf("=");
  return eq > 0 ? [[token.slice(0, eq), token.slice(eq + 1)] as const] : [];
};

const parsePairs = (payload: string): Record<string, string> =>
  Object.fromEntries(payload.split(/\s+/).flatMap(toPair));

const orNull = (text: string) => text.trim() || null;

interface DecodedBody {
  readonly ledgerStart: number | null;
  readonly detailStart: number | null;
  readonly detailEnd: number | null;
  readonly region: ReadonlyArray<MarkerSpan>;
}

const decodeBody = (codec: WireCodec, body: string): DecodedBody => {
  const spans = codec.scan(body);
  const ledger = spans.find((span) => span.name === "ledger");
  const detail = spans.find((span) => span.name === "detail");
  const regionEnd = detail?.start ?? body.length;
  return {
    ledgerStart: ledger?.start ?? null,
    detailStart: detail?.start ?? null,
    detailEnd: detail?.end ?? null,
    region: spans.filter((span) => span.start < regionEnd),
  };
};

const anchor = (name: string) => name === "ledger" || name === "detail";

const pairsNamed = (codec: WireCodec, body: string, name: string) =>
  decodeBody(codec, body)
    .region.filter((span) => span.name === name)
    .map((span) => parsePairs(span.pairs));

const decodeClaim = Schema.decodeUnknownResult(Claim);
const decodeAttempt = Schema.decodeUnknownResult(AttemptRecord);
const decodeHandback = Schema.decodeUnknownResult(HandbackRecord);
const decodePark = Schema.decodeUnknownResult(Schema.fromJsonString(ParkRecordSchema));
const decodeFollowUp = Schema.decodeUnknownResult(FollowUpMarker);
const decodeReason = Option.liftThrowable(decodeURIComponent);
const lineageParentOf = (parent: string) => (parent === "none" ? null : parent);

const lineagePairs = (pairs: Record<string, string>) => ({
  root: pairs.root,
  parent: pairs.parent === undefined ? undefined : lineageParentOf(pairs.parent),
  hop: Number(pairs.hop),
});

const decodeNote = (note: string | undefined) => {
  if (note === undefined) return null;
  const result = Result.try(() => decodeURIComponent(note));
  return Result.isSuccess(result) ? result.success : null;
};

export const parseClaim = (codec: WireCodec, body: string) => {
  const candidates = parseClaims(codec, body);
  return candidates.at(-1) ?? null;
};

export const parseClaims = (codec: WireCodec, body: string) =>
  pairsNamed(codec, body, "claim").flatMap((pairs) =>
    okToArray(
      decodeClaim({
        by: pairs.by,
        claimedAtMillis: Number(pairs.at),
        operation: { workflow: pairs.workflow, operation: pairs.operation },
        lineage: lineagePairs(pairs),
      }),
    ),
  );

export const parseAttempts = (codec: WireCodec, body: string) =>
  pairsNamed(codec, body, "attempt").flatMap((pairs) =>
    okToArray(
      decodeAttempt({
        operation: { workflow: pairs.workflow, operation: pairs.operation },
        outcome: pairs.outcome,
        ...(pairs.terminal === "true" ? { terminal: true } : {}),
        atMillis: Number(pairs.at),
        lineage: lineagePairs(pairs),
        ...(pairs.reason === undefined ? {} : { reason: Option.getOrUndefined(decodeReason(pairs.reason)) }),
      }),
    ),
  );

export const parseHandback = (codec: WireCodec, body: string) => {
  const candidates = parseHandbacks(codec, body);
  return candidates.at(-1) ?? null;
};

export const parseHandbacks = (codec: WireCodec, body: string) =>
  pairsNamed(codec, body, "handback").flatMap((pairs) =>
    okToArray(decodeHandback({ by: pairs.by, atMillis: Number(pairs.at), note: decodeNote(pairs.note) })),
  );

const followUpTriggerKinds = [
  "human-feedback",
  "trusted-bot-finding",
  "failing-check",
  "merge-conflict",
] as const satisfies ReadonlyArray<FollowUpTrigger["kind"]>;

export const parseFollowUpTrigger = (codec: WireCodec, body: string): FollowUpTrigger | null => {
  const pairs = pairsNamed(codec, body, "handback").at(-1);
  const kind = followUpTriggerKinds.find((candidate) => candidate === pairs?.trigger);
  if (!kind) return null;
  const atMillis = Number(pairs?.triggerAt);
  if (!Number.isFinite(atMillis)) return null;
  return { kind, atMillis };
};

export const parseParks = (codec: WireCodec, body: string) =>
  pairsNamed(codec, body, "park").flatMap((pairs) =>
    pairs.record === undefined ? [] : okToArray(decodePark(decodeNote(pairs.record))),
  );

export const parseEngineHandoffAtMillis = (codec: WireCodec, body: string) => {
  const atMillis = Number(pairsNamed(codec, body, "engine-handoff").at(-1)?.at);
  return Number.isFinite(atMillis) ? atMillis : null;
};

export const parseFollowUp = (codec: WireCodec, body: string) => {
  const candidates = pairsNamed(codec, body, "follow-up").flatMap((pairs) =>
    okToArray(
      decodeFollowUp({
        checks: pairs.checks,
        humanCommentAtMillis: Number(pairs.human),
        noProgress: Number(pairs.noProgress),
        // Markers written before base divergence existed have no `base=`; read them as "none".
        baseDivergence: pairs.base ?? "none",
        // Omit when absent so the schema default (0) applies rather than a NaN from `Number(undefined)`.
        ...(pairs.bot === undefined ? {} : { botTriggerAtMillis: Number(pairs.bot) }),
        ...(pairs.failing === undefined ? {} : { latestFailingCheckAtMillis: Number(pairs.failing) }),
        ...(pairs.attempt === undefined ? {} : { attemptAtMillis: Number(pairs.attempt) }),
      }),
    ),
  );
  return candidates.at(-1) ?? null;
};

export const hasLedgerMarker = (codec: WireCodec, body: string) =>
  codec.scan(body).some((span) => span.name === "ledger");

export const hasCogworkMarker = (codec: WireCodec, body: string) => codec.scan(body).length > 0;

export const coordinationStatus = (codec: WireCodec, body: string) => {
  const { ledgerStart } = decodeBody(codec, body);
  return orNull(body.slice(0, ledgerStart ?? body.length).replace(attribution, ""));
};

export const coordinationDetail = (codec: WireCodec, body: string) => {
  const { detailEnd } = decodeBody(codec, body);
  return detailEnd === null ? null : orNull(body.slice(detailEnd));
};

export const coordinationMarkers = (codec: WireCodec, body: string) =>
  decodeBody(codec, body)
    .region.filter((span) => !anchor(span.name))
    .map((span) => body.slice(span.start, span.end));

// Strip to a fixpoint: deleting one marker can splice the bytes on either side into a fresh marker
// the first scan never saw (a nested-comment gadget), so re-scan until nothing is left to strip.
const stripMarkers = (codec: WireCodec, text: string): string => {
  const spans = codec.scan(text);
  if (spans.length === 0) return text;
  const stripped = spans.reduceRight((acc, span) => acc.slice(0, span.start) + acc.slice(span.end), text);
  return stripMarkers(codec, stripped);
};

export const serializeClaim = (codec: WireCodec, claim: ClaimType) =>
  codec.encode({
    name: "claim",
    pairs: `by=${claim.by} at=${claim.claimedAtMillis} workflow=${claim.operation.workflow} operation=${claim.operation.operation} root=${claim.lineage.root} parent=${claim.lineage.parent ?? "none"} hop=${claim.lineage.hop}`,
  });

export const serializeAttempt = (codec: WireCodec, attempt: AttemptRecord) =>
  codec.encode({
    name: "attempt",
    pairs: `workflow=${attempt.operation.workflow} operation=${attempt.operation.operation} outcome=${attempt.outcome}${attempt.terminal === true ? " terminal=true" : ""} at=${attempt.atMillis} root=${attempt.lineage.root} parent=${attempt.lineage.parent ?? "none"} hop=${attempt.lineage.hop}${attempt.reason ? ` reason=${encodeURIComponent(attempt.reason)}` : ""}`,
  });

export const serializeHandback = (
  codec: WireCodec,
  handback: HandbackRecordType,
  trigger?: FollowUpTrigger,
) =>
  codec.encode({
    name: "handback",
    pairs: `by=${handback.by} at=${handback.atMillis}${handback.note === null ? "" : ` note=${encodeURIComponent(handback.note)}`}${trigger ? ` trigger=${trigger.kind} triggerAt=${trigger.atMillis}` : ""}`,
  });

export const serializePark = (codec: WireCodec, park: ParkRecord) =>
  codec.encode({
    name: "park",
    pairs: `record=${encodeURIComponent(Schema.encodeSync(Schema.fromJsonString(ParkRecordSchema))(park))}`,
  });

export const serializeEngineHandoff = (codec: WireCodec, atMillis: number) =>
  codec.encode({ name: "engine-handoff", pairs: `at=${atMillis}` });

export const serializeEngineHandoffCleared = (codec: WireCodec) =>
  codec.encode({ name: "engine-handoff", pairs: "at=none" });

export const serializeFollowUp = (codec: WireCodec, marker: FollowUpMarker) =>
  codec.encode({
    name: "follow-up",
    pairs: `checks=${marker.checks} human=${marker.humanCommentAtMillis} noProgress=${marker.noProgress} base=${marker.baseDivergence} bot=${marker.botTriggerAtMillis}${marker.latestFailingCheckAtMillis === undefined ? "" : ` failing=${marker.latestFailingCheckAtMillis}`}${marker.attemptAtMillis === undefined ? "" : ` attempt=${marker.attemptAtMillis}`}`,
  });

const detailSection = (codec: WireCodec, detail: string | null) => {
  const visible = orNull(stripMarkers(codec, detail ?? ""));
  return visible === null ? [] : ["", codec.encode({ name: "detail", pairs: "" }), "", visible];
};

export const formatCoordinationBody = (codec: WireCodec, { status, markers, detail }: CoordinationBody) =>
  [attribution, "", status, "", codec.ledgerMarker, ...markers, ...detailSection(codec, detail)].join("\n");

export const formatNoteBody = (codec: WireCodec, detail: string) => orNull(stripMarkers(codec, detail)) ?? "";

export const selectLedger = <Id>(codec: WireCodec, comments: ReadonlyArray<CoordinationComment<Id>>) =>
  comments
    .filter((comment) => comment.isBot && hasLedgerMarker(codec, comment.body))
    .toSorted((left, right) => left.createdAtMillis - right.createdAtMillis)
    .at(0);

// The triage proposal lives in its own bot note (not the ledger), so a self-halt's question can
// be re-derived from the tracker on every reconcile. The newest one wins when triage runs again.
export const selectTriageProposal = <Id>(comments: ReadonlyArray<CoordinationComment<Id>>) =>
  comments
    .filter((comment) => comment.isBot)
    .toSorted((left, right) => left.createdAtMillis - right.createdAtMillis)
    .flatMap((comment) => {
      const text = parseTriageProposal(comment.body);
      return text === null ? [] : [text];
    })
    .at(-1) ?? null;

const nextDetail = (codec: WireCodec, update: CoordinationUpdate, previous: string) => {
  if (!Object.hasOwn(update, "detail")) return coordinationDetail(codec, previous);
  return update.detail ?? null;
};

const coordinationUpdate = <Id>(
  codec: WireCodec,
  comments: ReadonlyArray<CoordinationComment<Id>>,
  update: CoordinationUpdate,
) => {
  const ledger = selectLedger(codec, comments);
  const previous = ledger?.body ?? "";
  const markers = coordinationMarkers(codec, previous);
  const body = formatCoordinationBody(codec, {
    status: update.status ?? coordinationStatus(codec, previous) ?? defaultStatus,
    markers: update.marker === undefined ? markers : [...markers, update.marker],
    detail: nextDetail(codec, update, previous),
  });
  return { ledger, body };
};

export const upsertCoordination = Effect.fn("coordination.upsertCoordination")(function* <Id>(
  codec: WireCodec,
  host: CommentHost<Id>,
  update: CoordinationUpdate,
) {
  const comments = yield* host.comments;
  const { ledger, body } = coordinationUpdate(codec, comments, update);
  if (ledger) {
    yield* host.edit(ledger.id, body);
    return;
  }
  yield* host.create(body);
});

export const editCoordination = Effect.fn("coordination.editCoordination")(function* <Id>(
  codec: WireCodec,
  host: CommentHost<Id>,
  update: CoordinationUpdate,
) {
  const comments = yield* host.comments;
  const { ledger, body } = coordinationUpdate(codec, comments, update);
  if (!ledger) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: "Cannot hand back a work item without a coordination comment",
    });
  }
  yield* host.edit(ledger.id, body);
});

export const postNote = Effect.fn("coordination.postNote")(function* <Id>(
  codec: WireCodec,
  host: CommentHost<Id>,
  detail: string,
) {
  const comments = yield* host.comments;
  const ledger = selectLedger(codec, comments);
  if (ledger && coordinationDetail(codec, ledger.body) !== null) {
    yield* upsertCoordination(codec, host, { detail: null });
  }
  yield* host.create(formatNoteBody(codec, detail));
});
