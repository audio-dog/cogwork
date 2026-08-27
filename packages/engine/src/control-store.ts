import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { migrations as shippedMigrations } from "./control-store-migrations.gen";

export type ControlStoreStatus =
  | { readonly health: "available" }
  | { readonly health: "unavailable"; readonly message: string };
export const ControlStore = Context.Reference<ControlStoreStatus>(
  "@cogwork/engine/control-store/ControlStore",
  { defaultValue: () => ({ health: "unavailable", message: "Control store did not boot" }) },
);
export class ControlStoreBootError extends Data.TaggedError("ControlStoreBootError")<{
  readonly message: string;
}> {}

const migrationsTable = "control_migrations";
const maximumRunEventAgeMillis = 1000 * 60 * 60 * 24 * 30;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
// `VACUUM INTO` cannot carry a bound parameter.
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

const hasTable = Effect.fn("ControlStore.hasTable")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
  return rows.length > 0;
});

const appliedMigrationIds = Effect.fn("ControlStore.appliedMigrationIds")(function* () {
  if (!(yield* hasTable(migrationsTable))) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number }>`SELECT migration_id FROM ${sql(
    migrationsTable,
  )} ORDER BY migration_id`;
  return rows.map((row) => row.migration_id);
});

export type ControlStoreMigrations = Record<string, Effect.Effect<void, SqlError, SqlClient.SqlClient>>;
const migrationIds = (migrations: ControlStoreMigrations) =>
  Effect.map(Migrator.fromRecord(migrations), (resolved) => resolved.map(([id]) => id));
const runMigrations = (migrations: ControlStoreMigrations) =>
  SqliteMigrator.run({ loader: Migrator.fromRecord(migrations), table: migrationsTable });

const retainRunEvents = Effect.fn("ControlStore.retainRunEvents")(function* () {
  if (!(yield* hasTable("run_events"))) return;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM run_events WHERE at < ${now - maximumRunEventAgeMillis}`;
});

const copyBeforeMigrating = Effect.fn("ControlStore.copyBeforeMigrating")(function* (storePath: string) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const destination = `${storePath}.before-migration-${now}.sqlite`;
  yield* sql.unsafe(`VACUUM INTO ${quoted(destination)}`);
  yield* fs.chmod(destination, 0o600);
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

const expectedSchemaFingerprint = Effect.fn("ControlStore.expectedSchemaFingerprint")(function* (
  migrations: ControlStoreMigrations,
) {
  return yield* Effect.gen(function* () {
    yield* runMigrations(migrations);
    return yield* schemaFingerprint();
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })));
});

const validate = Effect.fn("ControlStore.validate")(function* (migrations: ControlStoreMigrations) {
  const sql = yield* SqlClient.SqlClient;
  const integrity = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
  if (integrity[0]?.integrity_check !== "ok")
    return yield* new ControlStoreBootError({
      message: `Control store integrity check failed: ${integrity[0]?.integrity_check ?? "no result"}`,
    });
  if ((yield* schemaFingerprint()) !== (yield* expectedSchemaFingerprint(migrations)))
    return yield* new ControlStoreBootError({ message: "Control store schema is incompatible" });
});

// `Migrator` applies a migration only when its id exceeds the highest applied id, so a shipped id
// below that mark would be skipped in silence and surface later as an unexplained schema mismatch.
const skippedBy = (applied: ReadonlyArray<number>, shipped: ReadonlyArray<number>) => {
  const latest = applied.reduce((highest, id) => Math.max(highest, id), 0);
  return shipped.filter((id) => id <= latest && !applied.includes(id));
};

const boot = Effect.fn("ControlStore.boot")(function* (
  storePath: string,
  migrations: ControlStoreMigrations,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(storePath, 0o600);
  const applied = yield* appliedMigrationIds();
  const shipped = yield* migrationIds(migrations);
  const unknown = applied.filter((id) => !shipped.includes(id));
  if (unknown.length > 0)
    return yield* new ControlStoreBootError({
      message: `Control store carries migrations this build does not ship: ${unknown.join(", ")}`,
    });
  const skipped = skippedBy(applied, shipped);
  if (skipped.length > 0)
    return yield* new ControlStoreBootError({
      message: `Control store would skip migrations older than its history: ${skipped.join(", ")}`,
    });
  yield* retainRunEvents();
  const occupied = (yield* schemaFingerprint()) !== "";
  const pending = shipped.filter((id) => !applied.includes(id));
  if (pending.length > 0 && occupied) yield* copyBeforeMigrating(storePath);
  yield* runMigrations(migrations);
  yield* validate(migrations);
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

const available: ControlStoreStatus = { health: "available" };
const unavailable = (message: string): ControlStoreStatus => ({ health: "unavailable", message });

export const bootControlStoreLayer = (
  storePath: string,
  migrations: ControlStoreMigrations = shippedMigrations,
) =>
  Layer.effect(
    ControlStore,
    boot(storePath, migrations).pipe(
      Effect.map(() => available),
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
