import { DatabaseSync } from "node:sqlite";
import {
  ConnectionId,
  type ContributionSettingCell,
  resolveOperationSetting,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vitest";
import {
  bootControlStoreLayer,
  ControlStore,
  type ControlStoreService,
  controlStoreClientLayer,
  readControlStore,
} from "./control-store";
import { createStatements } from "./control-store-create.gen";

const pushSchemaMock = vi.hoisted(() => vi.fn());

vi.mock("drizzle-kit/payload/sqlite", () =>
  vi
    .importActual<typeof import("drizzle-kit/payload/sqlite")>("drizzle-kit/payload/sqlite")
    .then((actual) => {
      pushSchemaMock.mockImplementation(actual.pushSchema);
      return { ...actual, pushSchema: pushSchemaMock };
    }),
);

const storeLayerAt = (storePath: string) =>
  bootControlStoreLayer(storePath).pipe(Layer.provideMerge(controlStoreClientLayer(storePath)));

const interruptionGate = Latch.makeUnsafe();

const storeAt = (storePath: string) =>
  Effect.map(ControlStore, (store) =>
    store.health === "available"
      ? { health: store.health }
      : { health: store.health, message: store.message },
  ).pipe(Effect.provide(storeLayerAt(storePath)));

const withStore = <A, E, R>(
  storePath: string,
  use: (store: Extract<ControlStoreService, { readonly health: "available" }>) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(ControlStore, (store) => {
    if (store.health === "unavailable") return Effect.die(new Error(store.message));
    return use(store);
  }).pipe(Effect.provide(storeLayerAt(storePath)));

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

const schemaOf = (storePath: string) =>
  query(
    storePath,
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name LIKE 'sqlite_autoindex_%' ORDER BY type, name",
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

const connectionId = Schema.decodeSync(ConnectionId);

const persistConnectionState = Effect.fn("test.persistConnectionState")((storePath: string) =>
  withStore(storePath, (store) =>
    Effect.gen(function* () {
      yield* store.establishConnection({
        id: connectionId("linear/acme"),
        system: "linear",
        account: "acme",
        status: "established",
      });
      yield* store.revokeConnection(connectionId("linear/acme"));
    }),
  ),
);

const establishSecondAccount = Effect.fn("test.establishSecondAccount")((storePath: string) =>
  withStore(storePath, (store) =>
    Effect.gen(function* () {
      yield* store.establishConnection({
        id: connectionId("linear/acme"),
        system: "linear",
        account: "acme",
        status: "established",
      });
      yield* store.establishConnection({
        id: connectionId("linear/other"),
        system: "linear",
        account: "other",
        status: "established",
      });
    }),
  ),
);

const retentionWindowMillis = 1000 * 60 * 60 * 24 * 30;
const workspace = Schema.decodeSync(WorkspaceId)("example");
const schemaDiff = (sqlStatements: ReadonlyArray<string>) => ({
  sqlStatements: [...sqlStatements],
  hints: [],
  apply: () => Promise.resolve(),
});

afterEach(() => pushSchemaMock.mockClear());

layer(NodeServices.layer)((it) => {
  it.effect("converges an empty store to the generated create schema", () =>
    Effect.gen(function* () {
      const { dir, storePath } = yield* temporaryStore();
      const path = yield* Path.Path;
      const generatedPath = path.join(dir, "generated.db");
      yield* poke(generatedPath, createStatements.join("\n"));

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* schemaOf(storePath), yield* schemaOf(generatedPath));
      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
    }),
  );

  it.effect("adds a column and table while preserving existing rows", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* poke(
        storePath,
        `${createStatements.join("\n")}
         INSERT INTO workspaces (id, name, checkout_path, issue_tracker, linear_history)
         VALUES ('workspace-1', 'kept', '/tmp/kept', '{}', 0);
         ALTER TABLE workspaces DROP COLUMN source_control;
         DROP TABLE connections;`,
      );

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "SELECT id, name FROM workspaces"), [
        { id: "workspace-1", name: "kept" },
      ]);
      assert.isTrue(
        (yield* query(storePath, "PRAGMA table_info(workspaces)")).some(
          (column) => column.name === "source_control",
        ),
      );
      assert.deepStrictEqual(
        yield* query(
          storePath,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connections'",
        ),
        [{ name: "connections" }],
      );
    }),
  );

  it.effect("produces zero diff statements on the second boot after convergence", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.strictEqual(pushSchemaMock.mock.calls.length, 3);
    }),
  );

  it.effect("fails closed when the verification re-diff is not empty", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      pushSchemaMock
        .mockResolvedValueOnce(schemaDiff(["CREATE TABLE convergence_probe (id INTEGER)"]))
        .mockResolvedValueOnce(schemaDiff(["ALTER TABLE convergence_probe ADD remaining TEXT"]));

      const store = yield* storeAt(storePath);

      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(
        store.health === "unavailable" &&
          store.message.includes("ALTER TABLE convergence_probe ADD remaining TEXT"),
      );
    }),
  );

  it.effect("persists Connection lifecycle state", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* persistConnectionState(storePath);

      const reloaded = yield* readControlStore(storePath);
      assert.strictEqual(reloaded.connections.length, 1);
      assert.strictEqual(reloaded.connections[0]?.id, "linear/acme");
      assert.strictEqual(reloaded.connections[0]?.status, "revoked");
    }),
  );

  it.effect("stores Connections by system and account", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* establishSecondAccount(storePath);

      const reloaded = yield* readControlStore(storePath);
      assert.deepStrictEqual(reloaded.connections.map((connection) => connection.id).sort(), [
        "linear/acme",
        "linear/other",
      ]);
    }),
  );

  it.effect("persists every limit column and reads them after restart", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* withStore(storePath, (store) =>
        Effect.all(
          [
            store.setDaemonLimit({ key: "global-concurrency", value: 8, expectedRevision: 0 }),
            store.setDaemonLimit({ key: "per-workspace-concurrency", value: 3, expectedRevision: 1 }),
            store.setDaemonLimit({ key: "daily-budget", value: 20, expectedRevision: 2 }),
          ],
          { discard: true },
        ),
      );
      const seed = yield* withStore(storePath, (store) => Effect.succeed(store.seed));

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
      yield* withStore(storePath, (store) =>
        Effect.all(
          [
            store.updateOperationSetting({
              _tag: "Set",
              row: {
                setting: "model",
                level: { _tag: "Default" },
                scope: { _tag: "PrivateWorkspaceOverlay", workspace },
                value: "overlay-default",
              },
            }),
            store.updateOperationSetting({
              _tag: "Set",
              row: {
                setting: "model",
                level: { _tag: "Operation", workflow: "coding", operation: "implement" },
                scope: { _tag: "SettingsProfile" },
                value: "profile-operation",
              },
            }),
          ],
          { discard: true },
        ),
      );

      const reloaded = yield* withStore(storePath, (store) => Effect.succeed(store.seed));

      assert.strictEqual(
        resolveOperationSetting(reloaded.operationSettings, "model", {
          workflow: "coding",
          operation: "implement",
          workspace,
        }),
        "profile-operation",
      );

      const cleared = yield* withStore(storePath, (store) =>
        store.updateOperationSetting({
          _tag: "Clear",
          cell: {
            setting: "model",
            level: { _tag: "Operation", workflow: "coding", operation: "implement" },
            scope: { _tag: "SettingsProfile" },
          },
        }),
      );

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

  it.effect("sets, clears, and reloads raw contribution setting rows", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      const contribution = {
        id: "local:repo/mcp/tools",
        kind: "mcp-server",
      } satisfies ContributionSettingCell["contribution"];
      const scope = {
        _tag: "PrivateWorkspaceOverlay",
        workspace,
      } satisfies ContributionSettingCell["scope"];

      yield* withStore(storePath, (store) =>
        store.updateContributionSetting({
          _tag: "Set",
          row: { contribution, scope, enabled: true },
        }),
      );

      const reloaded = yield* withStore(storePath, (store) => Effect.succeed(store.seed));

      assert.deepStrictEqual(reloaded.contributionSettings, [{ contribution, scope, enabled: true }]);

      const cleared = yield* withStore(storePath, (store) =>
        store.updateContributionSetting({
          _tag: "Clear",
          cell: { contribution, scope },
        }),
      );

      assert.deepStrictEqual(cleared.contributionSettings, []);
    }),
  );

  it.effect("reads the whole picture without booting or writing the store", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* withStore(storePath, (store) =>
        store.setDaemonLimit({ key: "global-concurrency", value: 8, expectedRevision: 0 }),
      );

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
      const stale = yield* withStore(storePath, (store) =>
        store
          .setDaemonLimit({ key: "global-concurrency", value: 8, expectedRevision: 0 })
          .pipe(
            Effect.andThen(
              Effect.flip(store.setDaemonLimit({ key: "daily-budget", value: 20, expectedRevision: 0 })),
            ),
          ),
      );

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

  it.effect("preserves rows when the schema diff is non-additive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { storePath } = yield* temporaryStore();
      yield* poke(
        storePath,
        `${createStatements.join("\n")}
         CREATE TABLE extra_data (value TEXT NOT NULL);
         INSERT INTO extra_data (value) VALUES ('kept');`,
      );

      const store = yield* storeAt(storePath);
      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.includes("DROP TABLE `extra_data`;"));
      assert.deepStrictEqual(yield* query(storePath, "SELECT value FROM extra_data"), [{ value: "kept" }]);
      assert.isTrue(yield* fs.exists(storePath));
    }),
  );

  it.effect("restores a missing index without replacing the store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { storePath } = yield* temporaryStore();
      yield* storeAt(storePath);
      yield* poke(storePath, "DROP INDEX run_events_at");

      assert.strictEqual((yield* storeAt(storePath)).health, "available");
      assert.deepStrictEqual(
        yield* query(
          storePath,
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_events_at'",
        ),
        [{ name: "run_events_at" }],
      );
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
        `INSERT INTO runs (id, workspace, work_item, stage, harness, status, started_at, event_count)
         VALUES ('expired', 'gh', '#1', 'triage', 'cursor', 'succeeded', 0, 9),
                ('current', 'gh', '#2', 'triage', 'cursor', 'running', 1, 9);
         INSERT INTO run_events (run_id, seq, type, name, data, at)
         VALUES ('expired', 0, 'RUN_STARTED', NULL, '{}', 0),
                ('current', 0, 'RUN_STARTED', NULL, '{}', 9999999999999);`,
      );

      yield* TestClock.setTime(retentionWindowMillis + 1);
      yield* storeAt(storePath);
      assert.deepStrictEqual(yield* query(storePath, "SELECT run_id FROM run_events ORDER BY run_id"), [
        { run_id: "current" },
      ]);
      assert.deepStrictEqual(yield* query(storePath, "SELECT id, event_count FROM runs ORDER BY id"), [
        { id: "current", event_count: 1 },
        { id: "expired", event_count: 0 },
      ]);
    }),
  );

  it.effect("propagates interruption during boot instead of reporting unavailable", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      const fiber = yield* Effect.forkChild(Effect.andThen(interruptionGate.await, storeAt(storePath)));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      assert.strictEqual((yield* Fiber.await(fiber))._tag, "Failure");
    }),
  );
});
