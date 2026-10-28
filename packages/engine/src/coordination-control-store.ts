import {
  AttemptRecord,
  Claim,
  ControlStoreFailure,
  HandbackRecord,
  TrimmedNonEmptyString,
  WorkItemId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ControlStore } from "./control-store";
import { type CoordinationAdapter, type CoordinationState, defaultClaimant } from "./coordination-adapter";

const StoredClaimEvent = Schema.Struct({
  sequence: Schema.Finite,
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

type LineageRecord = {
  readonly lineageRoot?: WorkItemId;
  readonly lineageParent?: WorkItemId | null;
};

export interface SourceRevisions {
  readonly observed: string;
  readonly processed: string | null;
}

export interface ControlStoreCoordinationService
  extends CoordinationAdapter<WorkItemId, WorkItemId, Claim, ControlStoreFailure> {
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
const decodeItem = Schema.decodeUnknownEffect(WorkItemId);
const decodeRevision = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const decodeClaim = Schema.decodeUnknownEffect(Claim);
const decodeAttempt = Schema.decodeUnknownEffect(AttemptRecord);
const decodeHandbackRecord = Schema.decodeUnknownEffect(HandbackRecord);
const isControlStoreFailure = Schema.is(ControlStoreFailure);
const unclaimed = { claimHeld: false, claim: null, claimedByUs: false };

const failure =
  (operation: string, retryable = true) =>
  (cause: unknown) =>
    ControlStoreFailure.make({ operation, message: String(cause), retryable });

const mapFailure = (operation: string) => (cause: unknown) =>
  isControlStoreFailure(cause) ? cause : failure(operation)(cause);

const reject = (operation: string, message: string) => Effect.fail(failure(operation, false)(message));

const lineageOf = (record: LineageRecord, operation: string) => {
  const hasLineage = record.lineageRoot !== undefined && Object.hasOwn(record, "lineageParent");
  if (!hasLineage) return reject(operation, "lineage root and parent are required");
  return Effect.succeed({ root: record.lineageRoot, parent: record.lineageParent ?? null });
};

const claimsMatch = (actual: Claim, expected: Claim) =>
  actual.by === expected.by &&
  actual.claimedAtMillis === expected.claimedAtMillis &&
  actual.stage === expected.stage &&
  actual.lineageRoot === expected.lineageRoot &&
  actual.lineageParent === expected.lineageParent;

export const makeControlStoreCoordination = Effect.gen(function* () {
  const store = yield* ControlStore;
  if (store.health === "unavailable") {
    return yield* ControlStoreFailure.make({
      operation: "open Control store",
      message: store.message,
      retryable: true,
    });
  }
  const sql = yield* SqlClient.SqlClient;

  const latestClaimEvent = Effect.fn("ControlStoreCoordination.latestClaimEvent")(function* (
    item: WorkItemId,
  ) {
    const [stored] = yield* sql<StoredClaimEvent>`
      SELECT
        sequence,
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
    return stored === undefined ? null : yield* decodeClaimEvent(stored);
  });

  const claimFromEvent = (event: StoredClaimEvent) =>
    decodeClaim({
      by: event.by,
      claimedAtMillis: event.claimedAtMillis,
      ...(event.stage === null ? {} : { stage: event.stage }),
      lineageRoot: event.lineageRoot,
      lineageParent: event.lineageParent,
    });

  const activeClaim = Effect.fn("ControlStoreCoordination.activeClaim")(function* (item: WorkItemId) {
    const event = yield* latestClaimEvent(item);
    if (event === null || event.action === "release") return null;
    return { event, claim: yield* claimFromEvent(event) };
  });

  const ensureItem = Effect.fn("ControlStoreCoordination.ensureItem")(function* (
    item: WorkItemId,
    operation: string,
  ) {
    const rows = yield* sql`SELECT work_item FROM coordination_items WHERE work_item = ${item} LIMIT 1`;
    if (rows.length === 0) return yield* reject(operation, "source revision must be observed first");
  });

  const readClaim = Effect.fn("ControlStoreCoordination.readClaim")(function* (item: WorkItemId) {
    const active = yield* activeClaim(item);
    if (active === null) return unclaimed;
    return {
      claimHeld: true,
      claim: active.claim,
      claimedByUs: active.claim.by === defaultClaimant,
    };
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

  const read = Effect.fn("ControlStoreCoordination.read")(function* (input: WorkItemId) {
    const item = yield* decodeItem(input);
    const [claim, attempts, handback] = yield* Effect.all([
      readClaim(item),
      readAttempts(item),
      readHandback(item),
    ]);
    return { ...claim, attempts, handback } satisfies CoordinationState;
  });

  const insertClaim = Effect.fn("ControlStoreCoordination.insertClaim")(function* (
    item: WorkItemId,
    record: Claim,
    root: WorkItemId,
    parent: WorkItemId | null,
  ) {
    yield* ensureItem(item, "write Claim");
    const active = yield* activeClaim(item);
    if (active !== null) return yield* reject("write Claim", "item already has an active Claim");
    yield* sql`
      INSERT INTO coordination_claim_events (
        work_item, action, by, claimed_at_millis, stage, lineage_root, lineage_parent
      ) VALUES (
        ${item}, 'claim', ${defaultClaimant}, ${record.claimedAtMillis}, ${record.stage ?? null},
        ${root}, ${parent}
      )
    `;
  });

  const claim = Effect.fn("ControlStoreCoordination.claim")(function* (
    itemInput: WorkItemId,
    recordInput: Claim,
  ) {
    const item = yield* decodeItem(itemInput);
    const record = yield* decodeClaim(recordInput);
    const lineage = yield* lineageOf(record, "write Claim");
    if (record.by !== defaultClaimant) return yield* reject("write Claim", "claimant is not this daemon");
    yield* sql.withTransaction(insertClaim(item, record, lineage.root, lineage.parent));
  });

  const insertRelease = Effect.fn("ControlStoreCoordination.insertRelease")(function* (
    item: WorkItemId,
    expected: Claim,
  ) {
    yield* ensureItem(item, "release Claim");
    const active = yield* activeClaim(item);
    if (active === null || !claimsMatch(active.claim, expected)) {
      return yield* reject("release Claim", "active Claim does not match the expected Claim");
    }
    yield* sql`
      INSERT INTO coordination_claim_events (work_item, action, released_claim_sequence)
      VALUES (${item}, 'release', ${active.event.sequence})
    `;
  });

  const release = Effect.fn("ControlStoreCoordination.release")(function* (
    itemInput: WorkItemId,
    expectedInput: Claim,
  ) {
    const item = yield* decodeItem(itemInput);
    const expected = yield* decodeClaim(expectedInput);
    yield* lineageOf(expected, "release Claim");
    yield* sql.withTransaction(insertRelease(item, expected));
  });

  const appendAttempt = Effect.fn("ControlStoreCoordination.appendAttempt")(function* (
    itemInput: WorkItemId,
    recordInput: AttemptRecord,
  ) {
    const item = yield* decodeItem(itemInput);
    const record = yield* decodeAttempt(recordInput);
    const lineage = yield* lineageOf(record, "append Attempt record");
    yield* ensureItem(item, "append Attempt record");
    yield* sql`
      INSERT INTO coordination_attempts (
        work_item, stage, outcome, at_millis, lineage_root, lineage_parent
      ) VALUES (
        ${item}, ${record.stage}, ${record.outcome}, ${record.atMillis}, ${lineage.root}, ${lineage.parent}
      )
    `;
  });

  const appendHandback = Effect.fn("ControlStoreCoordination.appendHandback")(function* (
    itemInput: WorkItemId,
    recordInput: HandbackRecord,
  ) {
    const item = yield* decodeItem(itemInput);
    const record = yield* decodeHandbackRecord(recordInput);
    yield* ensureItem(item, "append Handback record");
    yield* sql`
      INSERT INTO coordination_handbacks (work_item, by, at_millis)
      VALUES (${item}, ${record.by}, ${record.atMillis})
    `;
  });

  const insertSourceRevision = Effect.fn("ControlStoreCoordination.insertSourceRevision")(function* (
    item: WorkItemId,
    revision: string,
  ) {
    yield* sql`INSERT OR IGNORE INTO coordination_items (work_item) VALUES (${item})`;
    yield* sql`
      INSERT OR IGNORE INTO coordination_source_revisions (work_item, revision)
      VALUES (${item}, ${revision})
    `;
  });

  const observeSourceRevision = Effect.fn("ControlStoreCoordination.observeSourceRevision")(function* (
    itemInput: WorkItemId,
    revisionInput: string,
  ) {
    const item = yield* decodeItem(itemInput);
    const revision = yield* decodeRevision(revisionInput);
    yield* sql.withTransaction(insertSourceRevision(item, revision));
  });

  const markSourceRevisionProcessed = Effect.fn("ControlStoreCoordination.markSourceRevisionProcessed")(
    function* (itemInput: WorkItemId, revisionInput: string) {
      const item = yield* decodeItem(itemInput);
      const revision = yield* decodeRevision(revisionInput);
      const updated = yield* sql`
      UPDATE coordination_source_revisions
      SET processed = 1
      WHERE work_item = ${item} AND revision = ${revision}
      RETURNING revision
    `;
      if (updated.length === 0) {
        return yield* reject("mark source revision processed", "source revision was not observed");
      }
    },
  );

  const readSourceRevisions = Effect.fn("ControlStoreCoordination.readSourceRevisions")(function* (
    itemInput: WorkItemId,
  ) {
    const item = yield* decodeItem(itemInput);
    const [stored] = yield* sql<StoredSourceRevisions>`
      SELECT
        current.revision AS observed,
        (
          SELECT processed.revision
          FROM coordination_source_revisions AS processed
          WHERE processed.work_item = ${item} AND processed.processed = 1
          ORDER BY processed.sequence DESC
          LIMIT 1
        ) AS processed
      FROM coordination_source_revisions AS current
      WHERE current.work_item = ${item}
      ORDER BY current.sequence DESC
      LIMIT 1
    `;
    return stored === undefined ? null : yield* decodeSourceRevisions(stored);
  });

  const write = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    store.withWrite(effect).pipe(Effect.mapError(mapFailure(operation)));

  return {
    read: (item) => read(item).pipe(Effect.mapError(mapFailure("read coordination"))),
    claim: (item, record) => write("write Claim", claim(item, record)),
    release: (item, expected) => write("release Claim", release(item, expected)),
    appendAttempt: (item, record) => write("append Attempt record", appendAttempt(item, record)),
    appendHandback: (item, record) => write("append Handback record", appendHandback(item, record)),
    observeSourceRevision: (item, revision) =>
      write("observe source revision", observeSourceRevision(item, revision)),
    markSourceRevisionProcessed: (item, revision) =>
      write("mark source revision processed", markSourceRevisionProcessed(item, revision)),
    readSourceRevisions: (item) =>
      readSourceRevisions(item).pipe(Effect.mapError(mapFailure("read source revisions"))),
  } satisfies ControlStoreCoordinationService;
});
