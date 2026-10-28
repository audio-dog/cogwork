import { AttemptRecord, Claim, HandbackRecord, type LifecycleStage } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { markdownCode, parseTriageProposal, statusReason } from "./comments";
import { FollowUpMarker } from "./follow-up";
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

const stageGerund: Record<LifecycleStage, string> = {
  triage: "triaging",
  implement: "implementing",
  "follow-up": "following up on",
};

export const defaultStatus = "Working on this issue.";

export const claimStatus = (stage: LifecycleStage) => `Currently ${stageGerund[stage]} this issue.`;

export const claimStatusFor = (claim: Claim) =>
  claim.stage ? claimStatus(claim.stage) : `In progress — claimed by ${claim.by}.`;

export const attemptStatus = (attempt: AttemptRecord, reason?: string | null) => {
  if (attempt.outcome === "succeeded") return `${attempt.operation} completed.`;
  if (attempt.outcome === "abandoned") return `${attempt.operation} abandoned.`;
  const trimmed = reason ? statusReason(reason) : "";
  if (trimmed) return `Last ${attempt.operation} attempt failed: ${markdownCode(trimmed)}`;
  return `Last ${attempt.operation} attempt failed.`;
};

export const handbackStatus = (handback: HandbackRecord, note?: string) => {
  const detail = note ? statusReason(note) : "";
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
const decodeFollowUp = Schema.decodeUnknownResult(FollowUpMarker);

export const parseClaim = (codec: WireCodec, body: string) => {
  const candidates = pairsNamed(codec, body, "claim").flatMap((pairs) =>
    okToArray(
      decodeClaim({
        by: pairs.by,
        claimedAtMillis: Number(pairs.at),
        ...(pairs.stage === undefined ? {} : { stage: pairs.stage }),
      }),
    ),
  );
  return candidates.at(-1) ?? null;
};

const attemptKeyFromPairs = (pairs: Record<string, string>) =>
  pairs.stage === undefined
    ? { workflow: pairs.workflow, operation: pairs.operation }
    : { workflow: "coding", operation: pairs.stage };

export const parseAttempts = (codec: WireCodec, body: string) =>
  pairsNamed(codec, body, "attempt").flatMap((pairs) =>
    okToArray(
      decodeAttempt({
        ...attemptKeyFromPairs(pairs),
        outcome: pairs.outcome,
        atMillis: Number(pairs.at),
      }),
    ),
  );

export const parseHandback = (codec: WireCodec, body: string) => {
  const candidates = pairsNamed(codec, body, "handback").flatMap((pairs) =>
    okToArray(decodeHandback({ by: pairs.by, atMillis: Number(pairs.at) })),
  );
  return candidates.at(-1) ?? null;
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

export const serializeClaim = (codec: WireCodec, claim: Claim) =>
  codec.encode({
    name: "claim",
    pairs: `by=${claim.by} at=${claim.claimedAtMillis}${claim.stage ? ` stage=${claim.stage}` : ""}`,
  });

export const serializeAttempt = (codec: WireCodec, attempt: AttemptRecord) =>
  codec.encode({
    name: "attempt",
    pairs: `workflow=${attempt.workflow} operation=${attempt.operation} outcome=${attempt.outcome} at=${attempt.atMillis}`,
  });

export const serializeHandback = (codec: WireCodec, handback: HandbackRecord) =>
  codec.encode({
    name: "handback",
    pairs: `by=${handback.by} at=${handback.atMillis}`,
  });

export const serializeFollowUp = (codec: WireCodec, marker: FollowUpMarker) =>
  codec.encode({
    name: "follow-up",
    pairs: `checks=${marker.checks} human=${marker.humanCommentAtMillis} noProgress=${marker.noProgress} base=${marker.baseDivergence} bot=${marker.botTriggerAtMillis}`,
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
