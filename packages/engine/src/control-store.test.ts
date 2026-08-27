import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  bootControlStoreLayer,
  ControlStore,
  type ControlStoreMigrations,
  controlStoreClientLayer,
} from "./control-store";

const storeLayer = (storePath: string, migrations?: ControlStoreMigrations) =>
  bootControlStoreLayer(storePath, migrations).pipe(Layer.provideMerge(controlStoreClientLayer(storePath)));

const storeAt = (storePath: string, migrations?: ControlStoreMigrations) =>
  Effect.provide(ControlStore, storeLayer(storePath, migrations));

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

// Two migrations either can apply alone, so a store can hold the later one without the earlier.
const laterOnly = { "2_beta": step("CREATE TABLE beta (id text PRIMARY KEY)") };
const bothIndependent = { "1_alpha": step("CREATE TABLE alpha (id text PRIMARY KEY)"), ...laterOnly };

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

const modeOf = (path: string) =>
  Effect.map(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(path)),
    (info) => (info.mode & 0o777).toString(8),
  );

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

  it.effect("keeps the store private, and takes an existing directory private with it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const home = path.join(dir, "home");
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.chmod(home, 0o755);
      const storePath = path.join(home, "control.db");

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.strictEqual(yield* modeOf(home), "700");
      assert.strictEqual(yield* modeOf(storePath), "600");
    }),
  );

  it.effect("copies an occupied store before it applies a pending migration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      assert.deepStrictEqual(yield* storeAt(storePath, firstStep), { health: "available" });
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
      assert.strictEqual(yield* modeOf(path.join(dir, backupName ?? "missing")), "600");
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

  it.effect("refuses a shipped migration its history would silently skip", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      // A store that applied `2_` while `1_` was still on another branch. `Migrator` compares against
      // the highest applied id, so `1_` would never run and the schema would be quietly wrong.
      assert.deepStrictEqual(yield* storeAt(storePath, laterOnly), { health: "available" });

      const store = yield* storeAt(storePath, bothIndependent);
      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.includes("skip"));
    }),
  );

  it.effect("propagates interruption during boot instead of reporting unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const storePath = path.join(dir, "control.db");
      const blocked: ControlStoreMigrations = {
        "1_blocked": Effect.flatMap(SqlClient.SqlClient, () => Effect.never),
      };

      const fiber = yield* Effect.forkChild(storeAt(storePath, blocked));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(exit._tag === "Failure");
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

  it.effect("ignores a legacy run ledger beside the store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
      const legacyPath = path.join(dir, "runs.db");
      const storePath = path.join(dir, "control.db");
      yield* poke(legacyPath, "CREATE TABLE runs (id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('old')");

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "SELECT count(*) AS n FROM runs"), [{ n: 0 }]);
      assert.isTrue(yield* fs.exists(legacyPath));
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
});
