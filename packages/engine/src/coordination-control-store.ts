import {
  AttemptRecord,
  Claim,
  ControlStoreFailure,
  HandbackRecord,
  type WorkItemId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ControlStore } from "./control-store";
import type { CoordinationAdapter, CoordinationState } from "./coordination-adapter";

const StoredClaimEvent = Schema.Struct({
  action: Schema.Literals(["claim", "release"]),
  by: Schema.NullOr(Schema.String),
  claimedAtMillis: Schema.NullOr(Schema.Finite),
  stage: Schema.NullOr(Schema.String),
  lineageRoot: Schema.NullOr(Schema.String),
  lineageParent: Schema.NullOr(Schema.String),
});
type StoredClaimEvent = typeof StoredClaimEvent.Type;

const StoredAttempt = Schema.Struct({
  stage: Schema.String,
  outcome: Schema.String,
  atMillis: Schema.Finite,
  lineageRoot: Schema.String,
  lineageParent: Schema.NullOr(Schema.String),
});
type StoredAttempt = typeof StoredAttempt.Type;

const StoredHandback = Schema.Struct({
  by: Schema.String,
  atMillis: Schema.Finite,
});
type StoredHandback = typeof StoredHandback.Type;

const StoredSourceRevisions = Schema.Struct({
  observed: Schema.String,
  processed: Schema.NullOr(Schema.String),
});
type StoredSourceRevisions = typeof StoredSourceRevisions.Type;

export interface SourceRevisions {
  readonly observed: string;
  readonly processed: string | null;
}

export interface ControlStoreCoordinationService
  extends CoordinationAdapter<WorkItemId, WorkItemId, ControlStoreFailure> {
  readonly observeSourceRevision: (
    item: WorkItemId,
    revision: string,
  ) => Effect.Effect<void, ControlStoreFailure>;
  readonly markSourceRevisionProcessed: (
    item: WorkItemId,
    revision: string,
  ) => Effect.Effect<void, ControlStoreFailure>;
  readonly readSourceRevisions: (
    item: WorkItemId,
  ) => Effect.Effect<SourceRevisions | null, ControlStoreFailure>;
}

const decodeClaimEvent = Schema.decodeUnknownEffect(StoredClaimEvent);
const decodeAttempts = Schema.decodeUnknownEffect(Schema.Array(StoredAttempt));
const decodeHandback = Schema.decodeUnknownEffect(StoredHandback);
const decodeSourceRevisions = Schema.decodeUnknownEffect(StoredSourceRevisions);
const decodeClaim = Schema.decodeUnknownEffect(Claim);
const decodeAttempt = Schema.decodeUnknownEffect(AttemptRecord);
const decodeHandbackRecord = Schema.decodeUnknownEffect(HandbackRecord);
const unclaimed = { claimHeld: false, claim: null, claimedByUs: false };

const failure = (operation: string) => (cause: unknown) =>
  ControlStoreFailure.make({ operation, message: String(cause), retryable: true });

const lineageOf = (record: Pick<Claim, "lineageRoot" | "lineageParent">, operation: string) => {
  const hasLineage = record.lineageRoot !== undefined && Object.hasOwn(record, "lineageParent");
  if (!hasLineage) return Effect.fail(failure(operation)("lineage root and parent are required"));
  return Effect.succeed({ root: record.lineageRoot, parent: record.lineageParent ?? null });
};

export const makeControlStoreCoordination = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ControlStore;

  const readClaim = Effect.fn("ControlStoreCoordination.readClaim")(function* (item: WorkItemId) {
    const [stored] = yield* sql<StoredClaimEvent>`
      SELECT
        action,
        by,
        claimed_at_millis AS claimedAtMillis,
        stage,
        lineage_root AS lineageRoot,
        lineage_parent AS lineageParent
      FROM coordination_claim_events
      WHERE work_item = ${item}
      ORDER BY sequence DESC
      LIMIT 1
    `;
    if (stored === undefined) return unclaimed;
    const event = yield* decodeClaimEvent(stored);
    if (event.action === "release") return unclaimed;
    const claim = yield* decodeClaim({
      by: event.by,
      claimedAtMillis: event.claimedAtMillis,
      ...(event.stage === null ? {} : { stage: event.stage }),
      lineageRoot: event.lineageRoot,
      lineageParent: event.lineageParent,
    });
    return { claimHeld: true, claim, claimedByUs: claim.by === "cogwork" };
  });

  const readAttempts = Effect.fn("ControlStoreCoordination.readAttempts")(function* (item: WorkItemId) {
    const stored = yield* sql<StoredAttempt>`
      SELECT
        stage,
        outcome,
        at_millis AS atMillis,
        lineage_root AS lineageRoot,
        lineage_parent AS lineageParent
      FROM coordination_attempts
      WHERE work_item = ${item}
      ORDER BY sequence
    `;
    const rows = yield* decodeAttempts(stored);
    return yield* Effect.forEach(rows, (row) => decodeAttempt(row));
  });

  const readHandback = Effect.fn("ControlStoreCoordination.readHandback")(function* (item: WorkItemId) {
    const [stored] = yield* sql<StoredHandback>`
      SELECT by, at_millis AS atMillis
      FROM coordination_handbacks
      WHERE work_item = ${item}
      ORDER BY sequence DESC
      LIMIT 1
    `;
    return stored === undefined ? null : yield* decodeHandbackRecord(yield* decodeHandback(stored));
  });

  const read = Effect.fn("ControlStoreCoordination.read")(function* (item: WorkItemId) {
    const [claim, attempts, handback] = yield* Effect.all([
      readClaim(item),
      readAttempts(item),
      readHandback(item),
    ]);
    return { ...claim, attempts, handback } satisfies CoordinationState;
  });

  const claim = Effect.fn("ControlStoreCoordination.claim")(function* (item: WorkItemId, record: Claim) {
    const lineage = yield* lineageOf(record, "write Claim");
    yield* sql`
      INSERT INTO coordination_claim_events (
        work_item, action, by, claimed_at_millis, stage, lineage_root, lineage_parent
      ) VALUES (
        ${item}, 'claim', ${record.by}, ${record.claimedAtMillis}, ${record.stage ?? null},
        ${lineage.root}, ${lineage.parent}
      )
    `;
  });

  const release = Effect.fn("ControlStoreCoordination.release")(function* (item: WorkItemId) {
    yield* sql`
      INSERT INTO coordination_claim_events (work_item, action)
      VALUES (${item}, 'release')
    `;
  });

  const appendAttempt = Effect.fn("ControlStoreCoordination.appendAttempt")(function* (
    item: WorkItemId,
    record: AttemptRecord,
  ) {
    const lineage = yield* lineageOf(record, "append Attempt record");
    yield* sql`
      INSERT INTO coordination_attempts (
        work_item, stage, outcome, at_millis, lineage_root, lineage_parent
      ) VALUES (
        ${item}, ${record.stage}, ${record.outcome}, ${record.atMillis}, ${lineage.root}, ${lineage.parent}
      )
    `;
  });

  const appendHandback = Effect.fn("ControlStoreCoordination.appendHandback")(function* (
    item: WorkItemId,
    record: HandbackRecord,
  ) {
    yield* sql`
      INSERT INTO coordination_handbacks (work_item, by, at_millis)
      VALUES (${item}, ${record.by}, ${record.atMillis})
    `;
  });

  const observeSourceRevision = Effect.fn("ControlStoreCoordination.observeSourceRevision")(function* (
    item: WorkItemId,
    revision: string,
  ) {
    yield* sql`
      INSERT INTO coordination_items (work_item, observed_source_revision)
      VALUES (${item}, ${revision})
      ON CONFLICT (work_item) DO UPDATE SET observed_source_revision = excluded.observed_source_revision
    `;
  });

  const markSourceRevisionProcessed = Effect.fn("ControlStoreCoordination.markSourceRevisionProcessed")(
    function* (item: WorkItemId, revision: string) {
      yield* sql`
      INSERT INTO coordination_items (
        work_item, observed_source_revision, processed_source_revision
      ) VALUES (${item}, ${revision}, ${revision})
      ON CONFLICT (work_item) DO UPDATE SET processed_source_revision = excluded.processed_source_revision
    `;
    },
  );

  const readSourceRevisions = Effect.fn("ControlStoreCoordination.readSourceRevisions")(function* (
    item: WorkItemId,
  ) {
    const [stored] = yield* sql<StoredSourceRevisions>`
      SELECT
        observed_source_revision AS observed,
        processed_source_revision AS processed
      FROM coordination_items
      WHERE work_item = ${item}
    `;
    return stored === undefined ? null : yield* decodeSourceRevisions(stored);
  });

  const write = <A, E>(
    operation: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, ControlStoreFailure> =>
    store.withWrite(effect).pipe(Effect.mapError(failure(operation)));

  return {
    read: (item) => read(item).pipe(Effect.mapError(failure("read coordination"))),
    claim: (item, record) => write("write Claim", claim(item, record)),
    release: (item) => write("release Claim", release(item)),
    appendAttempt: (item, record) => write("append Attempt record", appendAttempt(item, record)),
    appendHandback: (item, record) => write("append Handback record", appendHandback(item, record)),
    observeSourceRevision: (item, revision) =>
      write("observe source revision", observeSourceRevision(item, revision)),
    markSourceRevisionProcessed: (item, revision) =>
      write("mark source revision processed", markSourceRevisionProcessed(item, revision)),
    readSourceRevisions: (item) =>
      readSourceRevisions(item).pipe(Effect.mapError(failure("read source revisions"))),
  } satisfies ControlStoreCoordinationService;
});
