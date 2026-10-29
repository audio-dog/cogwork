import {
  AttemptOutcome,
  AttemptRecord,
  type Cause,
  Claim,
  HandbackRecord,
  keyOf,
  ParkReason,
  ParkRecord,
  TrimmedNonEmptyString,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ControlStore } from "./control-store";
import {
  CoordinationError,
  type CoordinationLedger,
  defaultClaimant,
  makeCoordination,
} from "./coordination";

const StoredClaimEvent = Schema.Struct({
  sequence: Schema.Finite,
  action: Schema.Literals(["claim", "release"]),
  by: Schema.NullOr(Schema.String),
  claimedAtMillis: Schema.NullOr(Schema.Finite),
  workflow: Schema.NullOr(Schema.String),
  operation: Schema.NullOr(Schema.String),
  lineageRoot: Schema.NullOr(Schema.String),
  lineageParent: Schema.NullOr(Schema.String),
  lineageHop: Schema.NullOr(Schema.Finite),
});
type StoredClaimEvent = typeof StoredClaimEvent.Type;

interface DecodedClaimEvent {
  readonly event: StoredClaimEvent;
  readonly claim: Claim | null;
}

const StoredAttempt = Schema.Struct({
  workflow: Schema.String,
  operation: Schema.String,
  outcome: AttemptOutcome,
  atMillis: Schema.Finite,
  lineageRoot: Schema.String,
  lineageParent: Schema.NullOr(Schema.String),
  lineageHop: Schema.Finite,
});

const StoredHandback = Schema.Struct({
  by: Schema.String,
  atMillis: Schema.Finite,
  note: Schema.NullOr(Schema.String),
});

const StoredPark = Schema.Struct({
  reason: Schema.String,
  workflow: Schema.NullOr(Schema.String),
  operation: Schema.NullOr(Schema.String),
  atMillis: Schema.Finite,
});

const StoredSourceRevision = Schema.Struct({
  observed: Schema.String,
  processed: Schema.NullOr(Schema.String),
});
const ParkReasonJson = Schema.fromJsonString(ParkReason);

const coordinationError = (
  reason: CoordinationError["reason"],
  message: string,
  retryable = reason === "unavailable",
) => new CoordinationError({ reason, message, retryable });

const notThisAuthority = () =>
  coordinationError("not-this-authority", "tracker items use tracker authority", false);

const claimsMatch = (actual: Claim, expected: Claim) =>
  actual.by === expected.by &&
  actual.claimedAtMillis === expected.claimedAtMillis &&
  actual.operation.workflow === expected.operation.workflow &&
  actual.operation.operation === expected.operation.operation &&
  actual.lineage.root === expected.lineage.root &&
  actual.lineage.parent === expected.lineage.parent &&
  actual.lineage.hop === expected.lineage.hop;

const controlRef = (ref: WorkItemRef) =>
  ref._tag === "Issue" ? Effect.fail(notThisAuthority()) : Effect.succeed(keyOf(ref));

const makeControlStoreAuthority = () =>
  Effect.gen(function* () {
    const store = yield* ControlStore;
    if (store.health === "unavailable") {
      return yield* coordinationError("unavailable", store.message);
    }
    const sql = yield* SqlClient.SqlClient;
    const reported = new Set<string>();

    const reportInvalid = (kind: string) =>
      reported.has(kind)
        ? Effect.void
        : Effect.sync(() => reported.add(kind)).pipe(
            Effect.andThen(Effect.logError("invalid persisted coordination record dropped", { kind })),
          );

    const decoded = Effect.fn("ControlStoreCoordination.decoded")(function* <A>(
      kind: string,
      result: Result.Result<A, unknown>,
    ) {
      if (Result.isSuccess(result)) return result.success;
      yield* reportInvalid(kind);
      return null;
    });

    const decodeClaim = (row: StoredClaimEvent) =>
      decoded(
        "Claim",
        Schema.decodeUnknownResult(Claim)({
          by: row.by,
          claimedAtMillis: row.claimedAtMillis,
          operation: { workflow: row.workflow, operation: row.operation },
          lineage: { root: row.lineageRoot, parent: row.lineageParent, hop: row.lineageHop },
        }),
      );

    const decodeClaimEvent = Effect.fn("ControlStoreCoordination.decodeClaimEvent")(function* (
      unknown: Record<string, unknown>,
    ) {
      const event = yield* decoded("Claim event", Schema.decodeUnknownResult(StoredClaimEvent)(unknown));
      if (event === null) return null;
      if (event.action === "release") return { event, claim: null } satisfies DecodedClaimEvent;
      const claim = yield* decodeClaim(event);
      return claim === null ? null : ({ event, claim } satisfies DecodedClaimEvent);
    });

    const claimEvents = Effect.fn("ControlStoreCoordination.claimEvents")(function* (workItem: string) {
      const rows = yield* sql<Record<string, unknown>>`
      SELECT sequence, action, by, claimed_at_millis AS claimedAtMillis,
        workflow, operation, lineage_root AS lineageRoot,
        lineage_parent AS lineageParent, lineage_hop AS lineageHop
      FROM coordination_claim_events
      WHERE work_item = ${workItem}
      ORDER BY sequence DESC
    `;
      return yield* Effect.forEach(rows, decodeClaimEvent).pipe(
        Effect.map((events) => events.filter((event): event is DecodedClaimEvent => event !== null)),
      );
    });

    const activeClaim = Effect.fn("ControlStoreCoordination.activeClaim")(function* (workItem: string) {
      const [latest] = yield* claimEvents(workItem);
      return latest?.claim ? { event: latest.event, claim: latest.claim } : null;
    });

    const ensureItem = Effect.fn("ControlStoreCoordination.ensureItem")(function* (workItem: string) {
      const rows = yield* sql`SELECT work_item FROM coordination_items WHERE work_item = ${workItem} LIMIT 1`;
      if (rows.length === 0) {
        return yield* coordinationError("refused", "source revision must be observed first", false);
      }
    });

    const readAttempts = Effect.fn("ControlStoreCoordination.readAttempts")(function* (workItem: string) {
      const rows = yield* sql<Record<string, unknown>>`
      SELECT workflow, operation, outcome, at_millis AS atMillis,
        lineage_root AS lineageRoot, lineage_parent AS lineageParent, lineage_hop AS lineageHop
      FROM coordination_attempts
      WHERE work_item = ${workItem}
      ORDER BY sequence
    `;
      return yield* Effect.forEach(rows, (unknown) =>
        decoded("Attempt row", Schema.decodeUnknownResult(StoredAttempt)(unknown)).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.succeed(null)
              : decoded(
                  "Attempt",
                  Schema.decodeResult(AttemptRecord)({
                    operation: { workflow: row.workflow, operation: row.operation },
                    outcome: row.outcome,
                    atMillis: row.atMillis,
                    lineage: { root: row.lineageRoot, parent: row.lineageParent, hop: row.lineageHop },
                  }),
                ),
          ),
        ),
      ).pipe(Effect.map((records) => records.filter((record): record is AttemptRecord => record !== null)));
    });

    const readHandbacks = Effect.fn("ControlStoreCoordination.readHandbacks")(function* (workItem: string) {
      const rows = yield* sql<Record<string, unknown>>`
      SELECT by, at_millis AS atMillis, note
      FROM coordination_handbacks
      WHERE work_item = ${workItem}
      ORDER BY sequence
    `;
      return yield* Effect.forEach(rows, (unknown) =>
        decoded("Handback row", Schema.decodeUnknownResult(StoredHandback)(unknown)).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.succeed(null)
              : decoded("Handback", Schema.decodeResult(HandbackRecord)(row)),
          ),
        ),
      ).pipe(Effect.map((records) => records.filter((record): record is HandbackRecord => record !== null)));
    });

    const readParks = Effect.fn("ControlStoreCoordination.readParks")(function* (workItem: string) {
      const rows = yield* sql<Record<string, unknown>>`
      SELECT reason, workflow, operation, at_millis AS atMillis
      FROM coordination_parks
      WHERE work_item = ${workItem}
      ORDER BY sequence
    `;
      return yield* Effect.forEach(rows, (unknown) =>
        decoded("Park row", Schema.decodeUnknownResult(StoredPark)(unknown)).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.succeed(null)
              : decoded("Park reason", Schema.decodeResult(ParkReasonJson)(row.reason)).pipe(
                  Effect.flatMap((reason) => {
                    if (reason === null) return Effect.succeed(null);
                    const hasNoOperation = row.workflow === null && row.operation === null;
                    const operation = hasNoOperation
                      ? {}
                      : { operation: { workflow: row.workflow, operation: row.operation } };
                    return decoded(
                      "Park record",
                      Schema.decodeUnknownResult(ParkRecord)({
                        reason,
                        ...operation,
                        atMillis: row.atMillis,
                      }),
                    );
                  }),
                ),
          ),
        ),
      ).pipe(Effect.map((records) => records.filter((record): record is ParkRecord => record !== null)));
    });

    const readRevision = Effect.fn("ControlStoreCoordination.readRevision")(function* (workItem: string) {
      const [unknown] = yield* sql<Record<string, unknown>>`
      SELECT current.revision AS observed,
        (SELECT processed.revision FROM coordination_source_revisions AS processed
          WHERE processed.work_item = ${workItem} AND processed.processed = 1
          ORDER BY processed.sequence DESC LIMIT 1) AS processed
      FROM coordination_source_revisions AS current
      WHERE current.work_item = ${workItem}
      ORDER BY current.sequence DESC
      LIMIT 1
    `;
      if (unknown === undefined) return null;
      return yield* decoded("Source revision", Schema.decodeUnknownResult(StoredSourceRevision)(unknown));
    });

    const read = Effect.fn("ControlStoreCoordination.read")(function* (ref: WorkItemRef) {
      const workItem = yield* controlRef(ref);
      const [claims, attempts, handbacks, parks, revision] = yield* Effect.all([
        claimEvents(workItem),
        readAttempts(workItem),
        readHandbacks(workItem),
        readParks(workItem),
        readRevision(workItem),
      ]);
      const [latest] = claims;
      const latestClaim = claims.find(({ claim }) => claim !== null)?.claim ?? null;
      return {
        claim: latest?.claim ?? null,
        latestClaimAtMillis: latestClaim?.claimedAtMillis,
        attempts,
        handbacks,
        parks,
        revision,
      } satisfies CoordinationLedger;
    });

    const claim = Effect.fn("ControlStoreCoordination.claim")(function* (ref: WorkItemRef, record: Claim) {
      const workItem = yield* controlRef(ref);
      yield* ensureItem(workItem);
      if ((yield* activeClaim(workItem)) !== null) {
        return yield* coordinationError("claim-held", "item already has an active Claim", false);
      }
      yield* sql`
      INSERT INTO coordination_claim_events (
        work_item, action, by, claimed_at_millis, workflow, operation,
        lineage_root, lineage_parent, lineage_hop
      ) VALUES (
        ${workItem}, 'claim', ${record.by}, ${record.claimedAtMillis},
        ${record.operation.workflow}, ${record.operation.operation}, ${record.lineage.root},
        ${record.lineage.parent}, ${record.lineage.hop}
      )
    `;
    });

    const release = Effect.fn("ControlStoreCoordination.release")(function* (
      ref: WorkItemRef,
      expected: Claim,
    ) {
      const workItem = yield* controlRef(ref);
      const active = yield* activeClaim(workItem);
      if (active === null || !claimsMatch(active.claim, expected)) {
        return yield* coordinationError("stale-claim", "active Claim does not match expected Claim", false);
      }
      yield* sql`
      INSERT INTO coordination_claim_events (work_item, action, released_claim_sequence)
      VALUES (${workItem}, 'release', ${active.event.sequence})
    `;
    });

    const recordAttempt = Effect.fn("ControlStoreCoordination.recordAttempt")(function* (
      ref: WorkItemRef,
      record: AttemptRecord,
    ) {
      const workItem = yield* controlRef(ref);
      yield* ensureItem(workItem);
      yield* sql`
      INSERT INTO coordination_attempts (
        work_item, workflow, operation, outcome, at_millis,
        lineage_root, lineage_parent, lineage_hop
      ) VALUES (
        ${workItem}, ${record.operation.workflow}, ${record.operation.operation}, ${record.outcome},
        ${record.atMillis}, ${record.lineage.root}, ${record.lineage.parent}, ${record.lineage.hop}
      )
    `;
    });

    const handBack = Effect.fn("ControlStoreCoordination.handBack")(function* (
      ref: WorkItemRef,
      record: HandbackRecord,
    ) {
      const workItem = yield* controlRef(ref);
      yield* ensureItem(workItem);
      yield* sql`
      INSERT INTO coordination_handbacks (work_item, by, at_millis, note)
      VALUES (${workItem}, ${record.by}, ${record.atMillis}, ${record.note})
    `;
    });

    const park = Effect.fn("ControlStoreCoordination.park")(function* (ref: WorkItemRef, record: ParkRecord) {
      const workItem = yield* controlRef(ref);
      yield* ensureItem(workItem);
      const reason = yield* Schema.encodeEffect(ParkReasonJson)(record.reason);
      yield* sql`
      INSERT INTO coordination_parks (work_item, reason, workflow, operation, at_millis)
      VALUES (
        ${workItem},
        ${reason},
        ${record.operation?.workflow ?? null},
        ${record.operation?.operation ?? null},
        ${record.atMillis}
      )
    `;
    });

    const observe = Effect.fn("ControlStoreCoordination.observe")(function* (
      ref: WorkItemRef,
      revision: string,
    ) {
      const workItem = yield* controlRef(ref);
      const decodedRevision = yield* Schema.decodeEffect(TrimmedNonEmptyString)(revision);
      yield* sql`INSERT OR IGNORE INTO coordination_items (work_item) VALUES (${workItem})`;
      const inserted = yield* sql`
      INSERT OR IGNORE INTO coordination_source_revisions (work_item, revision)
      VALUES (${workItem}, ${decodedRevision})
      RETURNING revision
    `;
      return inserted.length === 0 ? "redelivered" : "moved";
    });

    const markProcessed = Effect.fn("ControlStoreCoordination.markProcessed")(function* (
      ref: WorkItemRef,
      revision: string,
    ) {
      const workItem = yield* controlRef(ref);
      const updated = yield* sql`
      UPDATE coordination_source_revisions SET processed = 1
      WHERE work_item = ${workItem} AND revision = ${revision}
      RETURNING revision
    `;
      if (updated.length === 0) {
        return yield* coordinationError("refused", "source revision was not observed", false);
      }
    });

    const mapFailure = (cause: unknown) =>
      Schema.is(CoordinationError)(cause)
        ? cause
        : coordinationError("unavailable", cause instanceof Error ? cause.message : String(cause));
    const write = <A, E>(effect: Effect.Effect<A, E>) =>
      store.withWrite(effect).pipe(Effect.mapError(mapFailure));
    const safeRead = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(mapFailure));

    return {
      read: (ref: WorkItemRef) => safeRead(read(ref)),
      claim: (ref: WorkItemRef, record: Claim) => write(claim(ref, record)),
      release: (ref: WorkItemRef, record: Claim) => write(release(ref, record)),
      recordAttempt: (ref: WorkItemRef, record: AttemptRecord) => write(recordAttempt(ref, record)),
      park: (ref: WorkItemRef, record: ParkRecord) => write(park(ref, record)),
      handBack: (ref: WorkItemRef, record: HandbackRecord) => write(handBack(ref, record)),
      observe: (ref: WorkItemRef, revision: string, _cause: Cause) => write(observe(ref, revision)),
      markProcessed: (ref: WorkItemRef, revision: string) => write(markProcessed(ref, revision)),
    };
  });

const trackerAuthority = {
  read: (_ref: WorkItemRef) => Effect.fail(notThisAuthority()),
  claim: (_ref: WorkItemRef, _claim: Claim) => Effect.fail(notThisAuthority()),
  release: (_ref: WorkItemRef, _claim: Claim) => Effect.fail(notThisAuthority()),
  recordAttempt: (_ref: WorkItemRef, _attempt: AttemptRecord, _reason?: string) =>
    Effect.fail(notThisAuthority()),
  park: (_ref: WorkItemRef, _park: ParkRecord) => Effect.fail(notThisAuthority()),
  handBack: (_ref: WorkItemRef, _record: HandbackRecord) => Effect.fail(notThisAuthority()),
  observe: (_ref: WorkItemRef, _revision: string, _cause: Cause) => Effect.fail(notThisAuthority()),
  markProcessed: (_ref: WorkItemRef, _revision: string) => Effect.fail(notThisAuthority()),
};

const unavailableAuthority = (error: CoordinationError) => ({
  read: (_ref: WorkItemRef) => Effect.fail(error),
  claim: (_ref: WorkItemRef, _claim: Claim) => Effect.fail(error),
  release: (_ref: WorkItemRef, _claim: Claim) => Effect.fail(error),
  recordAttempt: (_ref: WorkItemRef, _attempt: AttemptRecord, _reason?: string) => Effect.fail(error),
  park: (_ref: WorkItemRef, _park: ParkRecord) => Effect.fail(error),
  handBack: (_ref: WorkItemRef, _record: HandbackRecord) => Effect.fail(error),
  observe: (_ref: WorkItemRef, _revision: string, _cause: Cause) => Effect.fail(error),
  markProcessed: (_ref: WorkItemRef, _revision: string) => Effect.fail(error),
});

export const makeControlStoreCoordination = Effect.match(makeControlStoreAuthority(), {
  onFailure: (error) => makeCoordination(trackerAuthority, unavailableAuthority(error), defaultClaimant),
  onSuccess: (control) => makeCoordination(trackerAuthority, control, defaultClaimant),
});
