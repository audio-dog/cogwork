import {
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  type DaemonLimits,
  DaemonLimits as DaemonLimitsSchema,
  type DaemonLimitUpdate,
  defaultDaemonLimits,
  StaleControlStoreWrite,
} from "@cogwork/contracts";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createStatements } from "./control-store-create.gen";

export type ControlStoreService =
  | {
      readonly health: "available";
      readonly seed: ControlStorePicture;
      readonly picture: Effect.Effect<ControlStorePicture, ControlStoreFailure>;
      readonly setDaemonLimit: (
        update: DaemonLimitUpdate,
      ) => Effect.Effect<ControlStorePicture, ControlStoreFailure | StaleControlStoreWrite>;
      readonly withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    }
  | {
      readonly health: "unavailable";
      readonly message: string;
      readonly seed: null;
      readonly picture: Effect.Effect<never, ControlStoreFailure>;
      readonly setDaemonLimit: (
        update: DaemonLimitUpdate,
      ) => Effect.Effect<never, ControlStoreFailure | StaleControlStoreWrite>;
      readonly withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    };
export class ControlStoreBootError extends Data.TaggedError("ControlStoreBootError")<{
  readonly message: string;
}> {}

const maximumRunEventAgeMillis = 1000 * 60 * 60 * 24 * 30;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const storeFailure = (operation: string) => (error: unknown) =>
  ControlStoreFailure.make({ operation, message: messageOf(error) });

const decodeDaemonLimits = Schema.decodeUnknownEffect(DaemonLimitsSchema);
const isStaleControlStoreWrite = Schema.is(StaleControlStoreWrite);

const setDaemonLimitFailure = (error: unknown) =>
  isStaleControlStoreWrite(error) ? error : storeFailure("set daemon limit")(error);

const readPicture = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const [row] = yield* sql<DaemonLimits>`
      SELECT
        global_concurrency AS globalConcurrency,
        per_workspace_concurrency AS perWorkspaceConcurrency,
        daily_budget AS dailyBudget,
        revision
      FROM daemon_limits
      WHERE id = 1
    `;
    const daemonLimits = yield* decodeDaemonLimits(row);
    return { daemonLimits };
  });

export const readOnlyControlStoreClientLayer = (storePath: string) =>
  SqliteClient.layer({ filename: storePath, readonly: true, disableWAL: true });

export const readControlStore = Effect.fn("ControlStore.read")((storePath: string) =>
  Effect.flatMap(SqlClient.SqlClient, readPicture).pipe(
    Effect.provide(readOnlyControlStoreClientLayer(storePath)),
    Effect.scoped,
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      return Effect.fail(storeFailure("read Control store")(Cause.squash(cause)));
    }),
  ),
);

const updateLimitRevision = (sql: SqlClient.SqlClient, update: DaemonLimitUpdate) => {
  if (update.key === "global-concurrency") {
    return sql<{ readonly revision: number }>`
      UPDATE daemon_limits
      SET global_concurrency = ${update.value}, revision = revision + 1
      WHERE id = 1 AND revision = ${update.expectedRevision}
      RETURNING revision
    `;
  }
  if (update.key === "per-workspace-concurrency") {
    return sql<{ readonly revision: number }>`
      UPDATE daemon_limits
      SET per_workspace_concurrency = ${update.value}, revision = revision + 1
      WHERE id = 1 AND revision = ${update.expectedRevision}
      RETURNING revision
    `;
  }
  return sql<{ readonly revision: number }>`
    UPDATE daemon_limits
    SET daily_budget = ${update.value}, revision = revision + 1
    WHERE id = 1 AND revision = ${update.expectedRevision}
    RETURNING revision
  `;
};

const makeAvailableControlStore = Effect.fn("ControlStore.makeAvailable")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writeGate = Semaphore.makeUnsafe(1);
  const picture = () => readPicture(sql).pipe(Effect.mapError(storeFailure("read Control store")));
  const seed: ControlStorePicture = yield* picture();
  const setDaemonLimit = Effect.fn("ControlStore.setDaemonLimit")(function* (update: DaemonLimitUpdate) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* updateLimitRevision(sql, update);
        if (updated.length > 0) return yield* readPicture(sql);
        const actual = yield* readPicture(sql);
        return yield* StaleControlStoreWrite.make({
          expectedRevision: update.expectedRevision,
          actualRevision: actual.daemonLimits.revision,
        });
      }),
    );
  });
  return {
    health: "available" as const,
    seed,
    picture: picture(),
    setDaemonLimit: (update: DaemonLimitUpdate) =>
      setDaemonLimit(update).pipe(Effect.mapError(setDaemonLimitFailure)),
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => writeGate.withPermits(1)(effect),
  };
});

const schemaFingerprint = Effect.fn("ControlStore.schemaFingerprint")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
  }>`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name LIKE 'sqlite_autoindex_%' ORDER BY type, name`;
  return rows.map((row) => `${row.type}:${row.name}:${row.sql ?? ""}`).join("\n");
});

const createSchema = Effect.fn("ControlStore.createSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of createStatements) yield* sql.unsafe(statement);
});

const expectedSchemaFingerprint = Effect.fn("ControlStore.expectedSchemaFingerprint")(function* () {
  return yield* Effect.gen(function* () {
    yield* createSchema();
    return yield* schemaFingerprint();
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })));
});

const retainRunEvents = Effect.fn("ControlStore.retainRunEvents")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM run_events WHERE at < ${now - maximumRunEventAgeMillis}`;
});

const seedDaemonLimits = Effect.fn("ControlStore.seedDaemonLimits")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO daemon_limits (
      id,
      global_concurrency,
      per_workspace_concurrency,
      daily_budget,
      revision
    ) VALUES (
      1,
      ${defaultDaemonLimits.globalConcurrency},
      ${defaultDaemonLimits.perWorkspaceConcurrency},
      ${defaultDaemonLimits.dailyBudget},
      ${defaultDaemonLimits.revision}
    )
  `;
});

// cogwork has no released version to migrate anyone from, so a store is created once and replaced
// whenever the schema moves. The comparison is exact because both sides run the same statements.
const boot = Effect.fn("ControlStore.boot")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(storePath, 0o600);
  const found = yield* schemaFingerprint();
  if (found === "") yield* createSchema();
  else if (found !== (yield* expectedSchemaFingerprint()))
    return yield* new ControlStoreBootError({
      message: `Control store schema does not match this build. Delete ${storePath} and start again.`,
    });
  yield* seedDaemonLimits();
  yield* retainRunEvents();
});

// The directory has to exist, and be private, before the client opens the file inside it. `mode`
// applies only to a directory `makeDirectory` creates, so an existing one needs the explicit chmod.
const prepareStoreDirectory = Effect.fn("ControlStore.prepareStoreDirectory")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(storePath), { recursive: true, mode: 0o700 });
  yield* fs.chmod(path.dirname(storePath), 0o700);
});

export const controlStoreClientLayer = (storePath: string) =>
  Layer.unwrap(
    Effect.map(prepareStoreDirectory(storePath), () => SqliteClient.layer({ filename: storePath })),
  );

const unavailable = (message: string): ControlStoreService => {
  const failure = ControlStoreFailure.make({ operation: "open Control store", message });
  return {
    health: "unavailable",
    message,
    seed: null,
    picture: Effect.fail(failure),
    setDaemonLimit: () => Effect.fail(failure),
    withWrite: (effect) => effect,
  };
};

export const ControlStore = Context.Reference<ControlStoreService>(
  "@cogwork/engine/control-store/ControlStore",
  { defaultValue: () => unavailable("Control store did not boot") },
);

export const bootControlStoreLayer = (storePath: string) =>
  Layer.effect(
    ControlStore,
    Effect.andThen(boot(storePath), makeAvailableControlStore).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.andThen(
          Effect.logError("control store boot failed", { cause: Cause.pretty(cause) }),
          Effect.succeed(
            unavailable(Cause.hasFails(cause) ? messageOf(Cause.squash(cause)) : Cause.pretty(cause)),
          ),
        );
      }),
    ),
  );
