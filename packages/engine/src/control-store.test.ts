import { DatabaseSync } from "node:sqlite";
import { resolveOperationSetting, WorkspaceId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  bootControlStoreLayer,
  ControlStore,
  controlStoreClientLayer,
  readControlStore,
} from "./control-store";

const storeLayerAt = (storePath: string) =>
  bootControlStoreLayer(storePath).pipe(Layer.provideMerge(controlStoreClientLayer(storePath)));

const storeAt = (storePath: string) =>
  Effect.map(ControlStore, (store) =>
    store.health === "available"
      ? { health: store.health }
      : { health: store.health, message: store.message },
  ).pipe(Effect.provide(storeLayerAt(storePath)));

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
const workspace = Schema.decodeSync(WorkspaceId)("example");

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
        [
          { name: "daemon_limits" },
          { name: "operation_settings" },
          { name: "run_events" },
          { name: "runs" },
          { name: "sessions" },
        ],
      );
      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
    }),
  );

  it.effect("persists every limit column and reads them after restart", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* Effect.gen(function* () {
        const store = yield* ControlStore;
        if (store.health === "unavailable") return assert.fail(store.message);
        yield* store.setDaemonLimit({ key: "global-concurrency", value: 8, expectedRevision: 0 });
        yield* store.setDaemonLimit({ key: "per-workspace-concurrency", value: 3, expectedRevision: 1 });
        yield* store.setDaemonLimit({ key: "daily-budget", value: 20, expectedRevision: 2 });
      }).pipe(Effect.provide(storeLayerAt(storePath)));
      const seed = yield* Effect.gen(function* () {
        const store = yield* ControlStore;
        if (store.health === "unavailable") return yield* Effect.die(new Error(store.message));
        return store.seed;
      }).pipe(Effect.provide(storeLayerAt(storePath)));

      assert.deepStrictEqual(seed.daemonLimits, {
        globalConcurrency: 8,
        perWorkspaceConcurrency: 3,
        dailyBudget: 20,
        revision: 3,
      });
    }),
  );

  it.effect("sets, clears, and reloads raw Operation setting rows", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* Effect.gen(function* () {
        const store = yield* ControlStore;
        if (store.health === "unavailable") return yield* Effect.die(new Error(store.message));
        yield* store.updateOperationSetting({
          _tag: "Set",
          row: {
            setting: "model",
            level: { _tag: "Default" },
            scope: { _tag: "PrivateWorkspaceOverlay", workspace },
            value: "overlay-default",
          },
        });
        yield* store.updateOperationSetting({
          _tag: "Set",
          row: {
            setting: "model",
            level: { _tag: "Operation", workflow: "coding", operation: "implement" },
            scope: { _tag: "SettingsProfile" },
            value: "profile-operation",
          },
        });
      }).pipe(Effect.provide(storeLayerAt(storePath)));

      const reloaded = yield* Effect.gen(function* () {
        const store = yield* ControlStore;
        if (store.health === "unavailable") return yield* Effect.die(new Error(store.message));
        return store.seed;
      }).pipe(Effect.provide(storeLayerAt(storePath)));

      assert.strictEqual(
        resolveOperationSetting(reloaded.operationSettings, "model", {
          workflow: "coding",
          operation: "implement",
          workspace,
        }),
        "profile-operation",
      );

      const cleared = yield* Effect.gen(function* () {
        const store = yield* ControlStore;
        if (store.health === "unavailable") return yield* Effect.die(new Error(store.message));
        return yield* store.updateOperationSetting({
          _tag: "Clear",
          cell: {
            setting: "model",
            level: { _tag: "Operation", workflow: "coding", operation: "implement" },
            scope: { _tag: "SettingsProfile" },
          },
        });
      }).pipe(Effect.provide(storeLayerAt(storePath)));

      assert.strictEqual(
        resolveOperationSetting(cleared.operationSettings, "model", {
          workflow: "coding",
          operation: "implement",
          workspace,
        }),
        "overlay-default",
      );
    }),
  );

  it.effect("reads the whole picture without booting or writing the store", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* Effect.gen(function* () {
        const store = yield* ControlStore;
        if (store.health === "unavailable") return assert.fail(store.message);
        yield* store.setDaemonLimit({ key: "global-concurrency", value: 8, expectedRevision: 0 });
      }).pipe(Effect.provide(storeLayerAt(storePath)));

      assert.deepStrictEqual((yield* readControlStore(storePath)).daemonLimits, {
        globalConcurrency: 8,
        perWorkspaceConcurrency: 4,
        dailyBudget: 50,
        revision: 1,
      });
    }),
  );

  it.effect("does not create a missing store during a read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { storePath } = yield* temporaryStore();

      const failure = yield* Effect.flip(readControlStore(storePath));

      assert.strictEqual(failure._tag, "ControlStoreFailure");
      assert.isFalse(yield* fs.exists(storePath));
    }),
  );

  it.effect("rejects a stale revision without changing the durable row", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      const stale = yield* Effect.gen(function* () {
        const store = yield* ControlStore;
        if (store.health === "unavailable") return yield* Effect.die(new Error(store.message));
        yield* store.setDaemonLimit({ key: "global-concurrency", value: 8, expectedRevision: 0 });
        return yield* Effect.flip(
          store.setDaemonLimit({ key: "daily-budget", value: 20, expectedRevision: 0 }),
        );
      }).pipe(Effect.provide(storeLayerAt(storePath)));

      assert.strictEqual(stale._tag, "StaleControlStoreWrite");
      if (stale._tag !== "StaleControlStoreWrite") return assert.fail("expected stale write");
      assert.strictEqual(stale.expectedRevision, 0);
      assert.strictEqual(stale.actualRevision, 1);
      assert.deepStrictEqual(
        yield* query(
          storePath,
          "SELECT global_concurrency, per_workspace_concurrency, daily_budget, revision FROM daemon_limits",
        ),
        [{ global_concurrency: 8, per_workspace_concurrency: 4, daily_budget: 50, revision: 1 }],
      );
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
