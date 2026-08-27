import { DatabaseSync } from "node:sqlite";
import { migrate, writeAuthoritative } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const storeAt = (path: string) =>
  migrate(path).pipe(
    Effect.map(() => ({ health: "available" as const })),
    Effect.catchTag("ControlStoreBootError", (error) =>
      Effect.succeed({ health: "unavailable" as const, message: error.message }),
    ),
  );

const migrationIdsAt = (path: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(path)),
    (db) => Effect.sync(() => db.prepare("SELECT id FROM control_migrations ORDER BY id").all()),
    (db) => Effect.sync(() => db.close()),
  );

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
) VALUES ('legacy', 'ws', '#1', 'implement', 'codex', '218-control-store', 1, 'succeeded', 1);
`;

layer(NodeServices.layer)((it) => {
  it.effect("creates schema metadata for a fresh store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.strictEqual((yield* migrationIdsAt(storePath))[0]?.id, 0);
      yield* storeAt(storePath);
      assert.isFalse((yield* fs.readDirectory(dir)).some((entry) => entry.includes("before-migration")));
    }),
  );

  it.effect("backs up an existing store before it applies a pending migration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) =>
          Effect.sync(() =>
            db.exec(
              "INSERT INTO run_events VALUES ('expired', 0, 'RUN_STARTED', NULL, '{}', 0); INSERT INTO run_events VALUES ('current', 0, 'RUN_STARTED', NULL, '{}', 9999999999999); DELETE FROM control_migrations",
            ),
          ),
        (db) => Effect.sync(() => db.close()),
      );

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      const entries = yield* fs.readDirectory(dir);
      const backupName = entries.find((entry) => entry.startsWith("control.db.before-migration-"));
      assert.isDefined(backupName);
      const events = yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(path.join(dir, backupName ?? "missing"))),
        (db) => Effect.sync(() => db.prepare("SELECT run_id FROM run_events ORDER BY run_id").all()),
        (db) => Effect.sync(() => db.close()),
      );
      assert.deepStrictEqual(events, [{ run_id: "current" }]);
    }),
  );

  it.effect("reports an incompatible store as unavailable without deleting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) =>
          Effect.sync(() =>
            db.exec(
              "INSERT INTO run_events VALUES ('evidence', 0, 'RUN_STARTED', NULL, '{}', 0); UPDATE control_migrations SET hash = 'poison'",
            ),
          ),
        (db) => Effect.sync(() => db.close()),
      );

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.length > 0);
      assert.isTrue(yield* fs.exists(storePath));
      const evidence = yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) => Effect.sync(() => db.prepare("SELECT run_id FROM run_events").all()),
        (db) => Effect.sync(() => db.close()),
      );
      assert.deepStrictEqual(evidence, [{ run_id: "evidence" }]);
    }),
  );

  it.effect("rejects a store whose schema no longer matches its migration history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) => Effect.sync(() => db.exec("DROP TABLE run_events")),
        (db) => Effect.sync(() => db.close()),
      );

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
    }),
  );

  it.effect("rejects a unique retention index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) =>
          Effect.sync(() =>
            db.exec("DROP INDEX run_events_at; CREATE UNIQUE INDEX run_events_at ON run_events (at)"),
          ),
        (db) => Effect.sync(() => db.close()),
      );

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
    }),
  );

  it.effect("rejects an unexpected trigger", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) =>
          Effect.sync(() =>
            db.exec(
              "CREATE TRIGGER discard_runs AFTER INSERT ON runs BEGIN DELETE FROM runs WHERE id = NEW.id; END",
            ),
          ),
        (db) => Effect.sync(() => db.close()),
      );

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
    }),
  );

  it.effect("rejects an unexpected table constraint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) =>
          Effect.sync(() =>
            db.exec(
              "DROP INDEX runs_started_at; ALTER TABLE runs RENAME TO poisoned_runs; CREATE TABLE runs (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, work_item TEXT NOT NULL, stage TEXT NOT NULL, harness TEXT NOT NULL, branch TEXT, session TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, estimated INTEGER, status TEXT NOT NULL CHECK(status <> 'running'), started_at INTEGER NOT NULL, ended_at INTEGER); INSERT INTO runs SELECT * FROM poisoned_runs; DROP TABLE poisoned_runs; CREATE INDEX runs_started_at ON runs (started_at DESC)",
            ),
          ),
        (db) => Effect.sync(() => db.close()),
      );

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
    }),
  );

  it.effect("renames and migrates the legacy run ledger", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const legacyPath = path.join(dir, "runs.db");
      const storePath = path.join(dir, "control.db");
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(legacyPath)),
        (db) => Effect.sync(() => db.exec(evolvedLegacyLedgerSql)),
        (db) => Effect.sync(() => db.close()),
      );

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.isFalse(yield* fs.exists(legacyPath));
      const rows = yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) => Effect.sync(() => db.prepare("SELECT id, branch, estimated FROM runs").all()),
        (db) => Effect.sync(() => db.close()),
      );
      assert.deepStrictEqual(rows, [{ id: "legacy", branch: "218-control-store", estimated: 1 }]);
      assert.strictEqual((yield* migrationIdsAt(storePath))[0]?.id, 0);
      assert.isTrue(
        (yield* fs.readDirectory(dir)).some((entry) => entry.startsWith("control.db.before-migration-")),
      );
    }),
  );

  it.effect("removes expired run events at boot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) =>
          Effect.sync(() =>
            db.exec(
              "INSERT INTO run_events VALUES ('expired', 0, 'RUN_STARTED', NULL, '{}', 0); INSERT INTO run_events VALUES ('current', 0, 'RUN_STARTED', NULL, '{}', 9999999999999)",
            ),
          ),
        (db) => Effect.sync(() => db.close()),
      );

      yield* storeAt(storePath);
      const events = yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(storePath)),
        (db) => Effect.sync(() => db.prepare("SELECT run_id FROM run_events ORDER BY run_id").all()),
        (db) => Effect.sync(() => db.close()),
      );
      assert.deepStrictEqual(events, [{ run_id: "current" }]);
    }),
  );

  it.effect("rejects an authoritative write with a stale revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      yield* storeAt(storePath);

      assert.strictEqual(yield* writeAuthoritative(storePath, "limits", "first", 0), 1);
      const stale = yield* Effect.flip(writeAuthoritative(storePath, "limits", "stale", 0));
      assert.strictEqual(stale._tag, "StaleControlStoreWrite");
      if (stale._tag === "StaleControlStoreWrite") assert.strictEqual(stale.actualRevision, 1);
    }),
  );
});
