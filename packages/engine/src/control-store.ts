import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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
export class ControlStoreBootError extends Schema.TaggedError<ControlStoreBootError>()(
  "ControlStoreBootError",
  { message: Schema.String },
) {}
export class StaleControlStoreWrite extends Schema.TaggedError<StaleControlStoreWrite>()(
  "StaleControlStoreWrite",
  { key: Schema.String, expectedRevision: Schema.Finite, actualRevision: Schema.Finite },
) {}
export class ControlStoreWriteError extends Schema.TaggedError<ControlStoreWriteError>()(
  "ControlStoreWriteError",
  { message: Schema.String },
) {}

const migrationsTable = "control_migrations";
const legacyLedgerName = "runs.db";
const maximumRunEventAgeMillis = 1000 * 60 * 60 * 24 * 30;
const importedTables = ["runs", "sessions", "run_events"] as const;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
// `ATTACH`, `VACUUM INTO`, and identifiers cannot carry a bound parameter.
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

// Which migrations a store boots with. Production passes the shipped set; a test passes a prefix of
// it to stand in for a store an older build left behind.
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

// The copy is the only evidence a failed migration leaves behind, so it is taken before the
// migrator opens its transaction and after retention has bounded what there is to copy.
const copyBeforeMigrating = Effect.fn("ControlStore.copyBeforeMigrating")(function* (storePath: string) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const destination = `${storePath}.before-migration-${now}.sqlite`;
  yield* sql.unsafe(`VACUUM INTO ${quoted(destination)}`);
  yield* fs.chmod(destination, 0o600);
});

const columnsOf = Effect.fn("ControlStore.columnsOf")(function* (schema: string, table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info(${table}, ${schema})`;
  return rows.map((row) => row.name);
});

const importTable = Effect.fn("ControlStore.importTable")(function* (table: (typeof importedTables)[number]) {
  const legacy = yield* columnsOf("legacy", table);
  if (legacy.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const shared = (yield* columnsOf("main", table)).filter((column) => legacy.includes(column));
  const columns = shared.map((column) => `"${column}"`).join(", ");
  yield* sql.unsafe(
    `INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM legacy.${table} WHERE true ON CONFLICT DO NOTHING`,
  );
});

// A legacy `runs.db` is imported rather than renamed into place. Its tables were created by a
// bootstrap that predates drizzle-kit, so their DDL does not match what the migrations produce, and
// adopting the file would leave a store the schema check has to be taught to forgive. Copying the
// rows into a freshly migrated store keeps that check exact, and keeps the old file as evidence.
const importLegacyLedger = Effect.fn("ControlStore.importLegacyLedger")(function* (legacyPath: string) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.acquireUseRelease(
    sql.unsafe(`ATTACH DATABASE ${quoted(legacyPath)} AS legacy`),
    () =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* Effect.forEach(importedTables, importTable, { discard: true });
          yield* sql`UPDATE runs SET status = 'exhausted' WHERE status = 'blocked'`;
        }),
      ),
    () => Effect.ignore(sql.unsafe("DETACH DATABASE legacy")),
  );
  yield* fs.rename(legacyPath, `${legacyPath}.imported-${now}`);
});

// Every store reaches its schema by running the same statements, so the expected shape is what those
// statements produce in an empty database and the comparison can stay textual.
const schemaFingerprint = Effect.fn("ControlStore.schemaFingerprint")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
  }>`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name LIKE 'sqlite_autoindex_%' ORDER BY type, name`;
  return rows.map((row) => `${row.type}:${row.name}:${row.sql ?? ""}`).join("\n");
});

const expectedSchemaFingerprint = (migrations: ControlStoreMigrations) =>
  Effect.gen(function* () {
    yield* runMigrations(migrations);
    return yield* schemaFingerprint();
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })));

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

const boot = Effect.fn("ControlStore.boot")(function* (
  storePath: string,
  migrations: ControlStoreMigrations,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.chmod(storePath, 0o600);
  const applied = yield* appliedMigrationIds();
  const shipped = yield* migrationIds(migrations);
  const unknown = applied.filter((id) => !shipped.includes(id));
  if (unknown.length > 0)
    return yield* new ControlStoreBootError({
      message: `Control store carries migrations this build does not ship: ${unknown.join(", ")}`,
    });
  yield* retainRunEvents();
  // A store the client has just created holds nothing, so there is nothing to copy.
  const occupied = (yield* schemaFingerprint()) !== "";
  const pending = shipped.filter((id) => !applied.includes(id));
  if (pending.length > 0 && occupied) yield* copyBeforeMigrating(storePath);
  yield* runMigrations(migrations);
  const legacyPath = path.join(path.dirname(storePath), legacyLedgerName);
  if (legacyPath !== storePath && (yield* fs.exists(legacyPath))) yield* importLegacyLedger(legacyPath);
  yield* validate(migrations);
});

export const writeAuthoritative = Effect.fn("ControlStore.writeAuthoritative")(function* (
  key: string,
  value: string,
  expectedRevision: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly revision: number;
        }>`SELECT revision FROM authoritative_records WHERE key = ${key}`;
        const actualRevision = rows[0]?.revision ?? 0;
        if (actualRevision !== expectedRevision)
          return yield* new StaleControlStoreWrite({ key, expectedRevision, actualRevision });
        const revision = actualRevision + 1;
        yield* sql`INSERT INTO authoritative_records (key, value, revision) VALUES (${key}, ${value}, ${revision}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = excluded.revision`;
        return revision;
      }),
    )
    .pipe(Effect.catchTag("SqlError", (error) => new ControlStoreWriteError({ message: messageOf(error) })));
});

// The directory has to exist, and be private, before the client opens the file inside it.
const prepareStoreDirectory = Effect.fn("ControlStore.prepareStoreDirectory")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(storePath), { recursive: true, mode: 0o700 });
});

export const controlStoreClientLayer = (storePath: string) =>
  Layer.unwrap(
    Effect.map(prepareStoreDirectory(storePath), () => SqliteClient.layer({ filename: storePath })),
  );

const available: ControlStoreStatus = { health: "available" };
const unavailable = (message: string): ControlStoreStatus => ({ health: "unavailable", message });

// Boot fails closed: any failure — and any defect — leaves the daemon serving RPC with the store
// reported unavailable, and the store itself untouched as evidence.
export const bootControlStoreLayer = (
  storePath: string,
  migrations: ControlStoreMigrations = shippedMigrations,
) =>
  Layer.effect(
    ControlStore,
    boot(storePath, migrations).pipe(
      Effect.map(() => available),
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt;
        return Effect.succeed(
          unavailable(Cause.hasFails(cause) ? messageOf(Cause.squash(cause)) : Cause.pretty(cause)),
        );
      }),
    ),
  );
