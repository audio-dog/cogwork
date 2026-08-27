// @effect-diagnostics-next-line nodeBuiltinImport:off
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { migrations } from "./control-store-migrations";

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

const maximumRunEventAgeMillis = 1000 * 60 * 60 * 24 * 30;
const sqliteBusyTimeoutMillis = 30_000;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
const applied = (db: DatabaseSync) =>
  db
    .prepare("SELECT id, hash FROM control_migrations ORDER BY id")
    .all()
    .map((row) => ({ id: Number(row.id), hash: String(row.hash) }));
const compatible = (rows: ReadonlyArray<{ readonly id: number; readonly hash: string }>) =>
  rows.every((row, index) => migrations[index]?.id === row.id && migrations[index]?.hash === row.hash);

const normalizeSql = (sql: unknown) =>
  String(sql ?? "")
    .toLowerCase()
    .replace(/[`"]/g, "")
    .replace(/\bconstraint\s+\w+\s+/g, "")
    .replace(/\s+/g, "");

const tableNames = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((table) => String(table.name));

const objectShape = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name LIKE 'sqlite_autoindex_%' ORDER BY type, name",
    )
    .all()
    .map((object) => `object:${String(object.type)}:${String(object.name)}`);

const tableShape = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT name, ncol, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(
      (table) =>
        `table:${String(table.name)}:${Number(table.ncol)}:${Number(table.wr)}:${Number(table.strict)}`,
    );

const columnShape = (db: DatabaseSync, table: string) =>
  db
    .prepare(
      'SELECT name, lower(type) AS type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY name',
    )
    .all(table)
    .map(
      (column) =>
        `column:${table}:${String(column.name)}:${String(column.type)}:${Number(column.notnull)}:${String(column.dflt_value ?? "")}:${Number(column.pk)}:${Number(column.hidden)}`,
    );

const indexShape = (db: DatabaseSync, table: string) =>
  db
    .prepare('SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name')
    .all(table)
    .flatMap((index) => [
      `index:${table}:${String(index.name)}:${Number(index.unique)}:${String(index.origin)}:${Number(index.partial)}`,
      ...db
        .prepare('SELECT seqno, name, "desc", coll, key FROM pragma_index_xinfo(?) ORDER BY seqno')
        .all(String(index.name))
        .map(
          (column) =>
            `index-column:${String(index.name)}:${Number(column.seqno)}:${String(column.name ?? "")}:${Number(column.desc)}:${String(column.coll)}:${Number(column.key)}`,
        ),
    ]);

const foreignKeyShape = (db: DatabaseSync, table: string) =>
  db
    .prepare(
      'SELECT id, seq, "table", "from", "to", on_update, on_delete, match FROM pragma_foreign_key_list(?) ORDER BY id, seq',
    )
    .all(table)
    .map(
      (key) =>
        `foreign-key:${table}:${Number(key.id)}:${Number(key.seq)}:${String(key.table)}:${String(key.from)}:${String(key.to)}:${String(key.on_update)}:${String(key.on_delete)}:${String(key.match)}`,
    );

const constraintShape = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((table) => {
      const sql = normalizeSql(table.sql);
      const features = ["check(", "collate", "generated", "references", "withoutrowid", "strict"].filter(
        (feature) => sql.includes(feature),
      );
      return `constraints:${String(table.name)}:${features.join(",")}`;
    });

const schemaShape = (db: DatabaseSync) => {
  const tables = tableNames(db);
  return [
    ...objectShape(db),
    ...tableShape(db),
    ...tables.flatMap((table) => [
      ...columnShape(db, table),
      ...indexShape(db, table),
      ...foreignKeyShape(db, table),
    ]),
    ...constraintShape(db),
  ];
};

const expectedSchemaShape = (() => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations) {
      for (const statement of migration.statements) db.exec(statement);
    }
    return schemaShape(db);
  } finally {
    db.close();
  }
})();

const validateSchema = (db: DatabaseSync) => {
  if (schemaShape(db).join("|") !== expectedSchemaShape.join("|"))
    throw new Error("Control store schema is incompatible");
};

const validate = (db: DatabaseSync) => {
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok")
    throw new Error(`Control store integrity check failed: ${integrity?.integrity_check ?? "no result"}`);
  if (!compatible(applied(db))) throw new Error("Control store migration history is incompatible");
  validateSchema(db);
};

const backup = (dbPath: string, backupPath: string) => {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    reader.exec(`VACUUM INTO ${quoted(backupPath)}`);
    chmodSync(backupPath, 0o600);
  } finally {
    reader.close();
  }
};

const pendingMigrations = (db: DatabaseSync) => {
  const current = applied(db);
  if (!compatible(current)) throw new Error("Control store migration history is incompatible");
  return migrations.slice(current.length);
};

const retainRunEvents = (db: DatabaseSync) => {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_events'").get();
  if (!table) return;
  // @effect-diagnostics-next-line globalDate:off
  const cutoff = Date.now() - maximumRunEventAgeMillis;
  db.prepare("DELETE FROM run_events WHERE at < ?").run(cutoff);
};

const applyPendingMigrations = (
  db: DatabaseSync,
  dbPath: string,
  existed: boolean,
  pending: typeof migrations,
) => {
  if (pending.length === 0) return;
  db.exec("COMMIT");
  db.exec("BEGIN IMMEDIATE");
  const lockedPending = pendingMigrations(db);
  // @effect-diagnostics-next-line globalDate:off
  if (lockedPending.length > 0 && existed) backup(dbPath, `${dbPath}.before-migration-${Date.now()}.sqlite`);
  for (const migration of lockedPending) {
    for (const statement of migration.statements) db.exec(statement);
    db.prepare("INSERT INTO control_migrations (id, hash) VALUES (?, ?)").run(migration.id, migration.hash);
  }
};

const migrateStore = (dbPath: string) => {
  const existed = existsSync(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    chmodSync(dbPath, 0o600);
    db.exec(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMillis}`);
    db.exec("CREATE TABLE IF NOT EXISTS control_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    const pending = pendingMigrations(db);
    retainRunEvents(db);
    applyPendingMigrations(db, dbPath, existed, pending);
    validate(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
};

const migrateLegacyLedger = (dbPath: string) => {
  const legacyPath = join(dirname(dbPath), "runs.db");
  if (existsSync(dbPath) || !existsSync(legacyPath)) return;
  renameSync(legacyPath, dbPath);
};

export const migrate = Effect.fn("ControlStore.migrate")(function* (dbPath: string) {
  yield* Effect.try({
    try: () => {
      migrateLegacyLedger(dbPath);
      migrateStore(dbPath);
    },
    catch: (error) => new ControlStoreBootError({ message: messageOf(error) }),
  });
});

export const writeAuthoritative = Effect.fn("ControlStore.writeAuthoritative")(function* (
  dbPath: string,
  key: string,
  value: string,
  expectedRevision: number,
) {
  return yield* Effect.try({
    try: () => {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("BEGIN IMMEDIATE");
        const actualRevision = Number(
          db.prepare("SELECT revision FROM authoritative_records WHERE key = ?").get(key)?.revision ?? 0,
        );
        if (actualRevision !== expectedRevision)
          throw new StaleControlStoreWrite({ key, expectedRevision, actualRevision });
        const revision = actualRevision + 1;
        db.prepare(
          "INSERT INTO authoritative_records (key, value, revision) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = excluded.revision",
        ).run(key, value, revision);
        db.exec("COMMIT");
        return revision;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        db.close();
      }
    },
    catch: (error) =>
      Schema.is(StaleControlStoreWrite)(error)
        ? error
        : new ControlStoreWriteError({ message: messageOf(error) }),
  });
});

const available: ControlStoreStatus = { health: "available" };
const unavailable = (message: string): ControlStoreStatus => ({ health: "unavailable", message });
export const bootControlStoreLayer = (dbPath: string) =>
  Layer.effect(
    ControlStore,
    migrate(dbPath).pipe(
      Effect.map(() => available),
      Effect.catchTag("ControlStoreBootError", (error) => Effect.succeed(unavailable(error.message))),
    ),
  );
