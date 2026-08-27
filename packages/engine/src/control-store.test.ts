import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { bootControlStoreLayer, ControlStore, controlStoreClientLayer } from "./control-store";

const storeAt = (storePath: string) =>
  Effect.provide(
    ControlStore,
    bootControlStoreLayer(storePath).pipe(Layer.provideMerge(controlStoreClientLayer(storePath))),
  );

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

const modeOf = (path: string) =>
  Effect.map(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(path)),
    (info) => (info.mode & 0o777).toString(8),
  );

const temporaryStore = Effect.fn("test.temporaryStore")(function* (name = "control.db") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
  return { dir, storePath: path.join(dir, name) };
});

const retentionWindowMillis = 1000 * 60 * 60 * 24 * 30;

layer(NodeServices.layer)((it) => {
  it.effect("creates the schema once and boots again unchanged", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(
        yield* query(
          storePath,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ),
        [{ name: "run_events" }, { name: "runs" }, { name: "sessions" }, { name: "workspaces" }],
      );
      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
    }),
  );

  it.effect("keeps the store private, and takes an existing directory private with it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir } = yield* temporaryStore();
      const home = path.join(dir, "home");
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.chmod(home, 0o755);
      const storePath = path.join(home, "control.db");

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.strictEqual(yield* modeOf(home), "700");
      assert.strictEqual(yield* modeOf(storePath), "600");
    }),
  );

  it.effect("refuses a store built by another schema and says how to clear it", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* poke(storePath, "CREATE TABLE runs (id TEXT PRIMARY KEY, note TEXT)");

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.includes(storePath));
    }),
  );

  it.effect("refuses a store whose schema drifted under it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { storePath } = yield* temporaryStore();
      yield* storeAt(storePath);
      yield* poke(
        storePath,
        "DROP INDEX run_events_at; CREATE UNIQUE INDEX run_events_at ON run_events (at)",
      );

      assert.strictEqual((yield* storeAt(storePath)).health, "unavailable");
      assert.isTrue(yield* fs.exists(storePath));
    }),
  );

  it.effect("leaves a legacy run ledger beside the store alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, storePath } = yield* temporaryStore();
      const legacyPath = path.join(dir, "runs.db");
      yield* poke(legacyPath, "CREATE TABLE runs (id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('old')");

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "SELECT count(*) AS n FROM runs"), [{ n: 0 }]);
      assert.isTrue(yield* fs.exists(legacyPath));
    }),
  );

  it.effect("removes expired run events at boot", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
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

  it.effect("propagates interruption during boot instead of reporting unavailable", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      const fiber = yield* Effect.forkChild(Effect.andThen(Effect.never, storeAt(storePath)));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      assert.strictEqual((yield* Fiber.await(fiber))._tag, "Failure");
    }),
  );
});
