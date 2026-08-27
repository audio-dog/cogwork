import { DatabaseSync } from "node:sqlite";
import {
  bootControlStoreLayer,
  ControlStore,
  type ControlStoreMigrations,
  controlStoreClientLayer,
  writeAuthoritative,
} from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const storeLayer = (storePath: string, migrations?: ControlStoreMigrations) =>
  bootControlStoreLayer(storePath, migrations).pipe(Layer.provideMerge(controlStoreClientLayer(storePath)));

// Boot reports its own outcome rather than failing, so a test reads the status it left behind.
const storeAt = (storePath: string, migrations?: ControlStoreMigrations) =>
  Effect.provide(ControlStore, storeLayer(storePath, migrations));

// Only one migration ships today, so the incremental path needs a set a test controls: booting with
// the first entry alone stands in for the store an older build left behind.
const step = (statement: string) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement));
const firstStep = {
  "1_run-events": step(
    "CREATE TABLE run_events (run_id text NOT NULL, seq integer NOT NULL, at integer NOT NULL)",
  ),
};
const bothSteps = {
  ...firstStep,
  "2_retention-index": step("CREATE INDEX run_events_at ON run_events (at)"),
};
const retentionWindowMillis = 1000 * 60 * 60 * 24 * 30;

const poke = (storePath: string, statements: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (db) => Effect.sync(() => db.exec(statements)),
    (db) => Effect.sync(() => db.close()),
  );

const query = (storePath: string, sql: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (db) => Effect.sync(() => db.prepare(sql).all()),
    (db) => Effect.sync(() => db.close()),
  );

const appliedNamesAt = (storePath: string) =>
  query(storePath, "SELECT name FROM control_migrations ORDER BY migration_id");

// What the pre-drizzle run ledger left on disk: tables from its bootstrap SQL, columns added later by
// `ALTER TABLE`, and a run parked at the retired `blocked` status.
const evolvedLegacyLedgerSql = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  work_item TEXT NOT NULL,
  stage TEXT NOT NULL,
  harness TEXT NOT NULL,
  session TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  harness TEXT NOT NULL,
  kind TEXT NOT NULL,
  handle TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  data TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX runs_started_at ON runs (started_at DESC);
ALTER TABLE runs ADD COLUMN branch TEXT;
ALTER TABLE runs ADD COLUMN estimated INTEGER;
INSERT INTO runs (
  id, workspace, work_item, stage, harness, branch, estimated, status, started_at
) VALUES ('legacy', 'ws', '#1', 'implement', 'codex', '218-control-store', 1, 'blocked', 1);
`;

layer(NodeServices.layer)((it) => {
  it.effect("creates schema metadata for a fresh store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* appliedNamesAt(storePath), [{ name: "control-store" }]);
      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.isFalse((yield* fs.readDirectory(dir)).some((entry) => entry.includes("before-migration")));
    }),
  );

  it.effect("copies an occupied store before it applies a pending migration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      assert.deepStrictEqual(yield* storeAt(storePath, firstStep), { health: "available" });
      // Retention measures age against the clock, so move it past the window under test.
      yield* TestClock.setTime(retentionWindowMillis + 1);
      yield* poke(
        storePath,
        "INSERT INTO run_events VALUES ('expired', 0, 0); INSERT INTO run_events VALUES ('current', 0, 9999999999999)",
      );

      assert.deepStrictEqual(yield* storeAt(storePath, bothSteps), { health: "available" });
      const backupName = (yield* fs.readDirectory(dir)).find((entry) =>
        entry.startsWith("control.db.before-migration-"),
      );
      assert.isDefined(backupName);
      // Retention runs before the copy, so the copy carries the bounded history and not the rest.
      assert.deepStrictEqual(
        yield* query(
          path.join(dir, backupName ?? "missing"),
          "SELECT run_id FROM run_events ORDER BY run_id",
        ),
        [{ run_id: "current" }],
      );
    }),
  );

  it.effect("reports a store from a newer build as unavailable without deleting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* poke(
        storePath,
        "INSERT INTO run_events VALUES ('evidence', 0, 'RUN_STARTED', NULL, '{}', 9999999999999); INSERT INTO control_migrations (migration_id, name) VALUES (99999999999999, 'from-the-future')",
      );

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.length > 0);
      assert.isTrue(yield* fs.exists(storePath));
      assert.deepStrictEqual(yield* query(storePath, "SELECT run_id FROM run_events"), [
        { run_id: "evidence" },
      ]);
    }),
  );

  it.effect("rejects a store whose schema no longer matches its migration history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* poke(storePath, "DROP TABLE run_events");

      assert.strictEqual((yield* storeAt(storePath)).health, "unavailable");
    }),
  );

  it.effect("rejects a unique retention index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* poke(
        storePath,
        "DROP INDEX run_events_at; CREATE UNIQUE INDEX run_events_at ON run_events (at)",
      );

      assert.strictEqual((yield* storeAt(storePath)).health, "unavailable");
    }),
  );

  it.effect("rejects an unexpected trigger", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* poke(
        storePath,
        "CREATE TRIGGER discard_runs AFTER INSERT ON runs BEGIN DELETE FROM runs WHERE id = NEW.id; END",
      );

      assert.strictEqual((yield* storeAt(storePath)).health, "unavailable");
    }),
  );

  it.effect("rejects an unexpected table constraint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* poke(
        storePath,
        "DROP INDEX runs_started_at; ALTER TABLE runs RENAME TO poisoned_runs; CREATE TABLE runs (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, work_item TEXT NOT NULL, stage TEXT NOT NULL, harness TEXT NOT NULL, branch TEXT, session TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, estimated INTEGER, status TEXT NOT NULL CHECK(status <> 'running'), started_at INTEGER NOT NULL, ended_at INTEGER); INSERT INTO runs SELECT * FROM poisoned_runs; DROP TABLE poisoned_runs; CREATE INDEX runs_started_at ON runs (started_at DESC)",
      );

      assert.strictEqual((yield* storeAt(storePath)).health, "unavailable");
    }),
  );

  it.effect("imports the legacy run ledger and retires the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const legacyPath = path.join(dir, "runs.db");
      const storePath = path.join(dir, "control.db");
      yield* poke(legacyPath, evolvedLegacyLedgerSql);

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "SELECT id, branch, estimated, status FROM runs"), [
        { id: "legacy", branch: "218-control-store", estimated: 1, status: "exhausted" },
      ]);
      assert.isFalse(yield* fs.exists(legacyPath));
      assert.isTrue((yield* fs.readDirectory(dir)).some((entry) => entry.startsWith("runs.db.imported-")));
      // The import lands in a freshly migrated store, so no pre-migration copy is involved.
      assert.isFalse((yield* fs.readDirectory(dir)).some((entry) => entry.includes("before-migration")));
    }),
  );

  it.effect("rolls back a failed legacy import and retries it at the next boot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const legacyPath = path.join(dir, "runs.db");
      const storePath = path.join(dir, "control.db");
      yield* poke(
        legacyPath,
        `${evolvedLegacyLedgerSql}
DROP TABLE sessions;
CREATE TABLE sessions (id TEXT PRIMARY KEY);
INSERT INTO sessions VALUES ('broken');`,
      );

      assert.strictEqual((yield* storeAt(storePath)).health, "unavailable");
      assert.deepStrictEqual(yield* query(storePath, "SELECT id FROM runs"), []);
      yield* poke(
        legacyPath,
        "DROP TABLE sessions; CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, harness TEXT NOT NULL, kind TEXT NOT NULL, handle TEXT, created_at INTEGER NOT NULL)",
      );

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "SELECT id FROM runs"), [{ id: "legacy" }]);
      assert.isFalse(yield* fs.exists(legacyPath));
    }),
  );

  it.effect("retries legacy file retirement without duplicating imported rows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const legacyPath = path.join(dir, "runs.db");
      const storePath = path.join(dir, "control.db");
      const importedPath = path.join(dir, "runs.db.imported-123");
      yield* TestClock.setTime(123);
      yield* poke(legacyPath, evolvedLegacyLedgerSql);
      yield* fs.makeDirectory(importedPath);

      assert.strictEqual((yield* storeAt(storePath)).health, "unavailable");
      assert.deepStrictEqual(yield* query(storePath, "SELECT id FROM runs"), [{ id: "legacy" }]);
      assert.isTrue(yield* fs.exists(legacyPath));
      yield* fs.remove(importedPath, { recursive: true });

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "SELECT id FROM runs"), [{ id: "legacy" }]);
      assert.isFalse(yield* fs.exists(legacyPath));
    }),
  );

  it.effect("removes expired run events at boot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* poke(
        storePath,
        "INSERT INTO run_events VALUES ('expired', 0, 'RUN_STARTED', NULL, '{}', 0); INSERT INTO run_events VALUES ('current', 0, 'RUN_STARTED', NULL, '{}', 9999999999999)",
      );

      yield* TestClock.setTime(retentionWindowMillis + 1);
      yield* storeAt(storePath);
      assert.deepStrictEqual(yield* query(storePath, "SELECT run_id FROM run_events ORDER BY run_id"), [
        { run_id: "current" },
      ]);
    }),
  );

  it.effect("rejects an authoritative write with a stale revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");

      const outcome = yield* Effect.gen(function* () {
        const first = yield* writeAuthoritative("limits", "first", 0);
        const stale = yield* Effect.flip(writeAuthoritative("limits", "stale", 0));
        return { first, stale };
      }).pipe(Effect.provide(storeLayer(storePath)));

      assert.strictEqual(outcome.first, 1);
      assert.strictEqual(outcome.stale._tag, "StaleControlStoreWrite");
      if (outcome.stale._tag === "StaleControlStoreWrite")
        assert.strictEqual(outcome.stale.actualRevision, 1);
    }),
  );
});
