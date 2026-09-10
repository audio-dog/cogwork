import { DatabaseSync } from "node:sqlite";
import {
  ConnectionId,
  type ContributionSettingCell,
  HarnessEnablement,
  HarnessName,
  resolveOperationSetting,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { afterEach, vi } from "vitest";
import {
  bootControlStoreLayer,
  ControlStore,
  type ControlStoreService,
  controlStoreWriteGateWaitDuration,
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

const interruptionGate = Latch.makeUnsafe();
const lockHolderScript = `
const lockfile = require("proper-lockfile");
lockfile.lock(process.argv[1], { realpath: false }).then(() => {
  process.stdout.write("locked\\n");
  process.stdin.resume();
});
`;

const storeAt = (storePath: string) =>
  Effect.map(ControlStore, (store) =>
    store.health === "available"
      ? { health: store.health }
      : { health: store.health, message: store.message },
  ).pipe(Effect.provide(bootControlStoreLayer(storePath)));

const withStore = <A, E, R>(
  storePath: string,
  use: (store: Extract<ControlStoreService, { readonly health: "available" }>) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(ControlStore, (store) => {
    if (store.health === "unavailable") return Effect.die(new Error(store.message));
    return use(store);
  }).pipe(Effect.provide(bootControlStoreLayer(storePath)));

const poke = (storePath: string, statements: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (db) => Effect.sync(() => db.exec(statements)),
    (db) => Effect.sync(() => db.close()),
  );

const pokeRenameShapedStore = (storePath: string) =>
  poke(
    storePath,
    `${createStatements.join("\n").replace("`source_control` text", "`source_control_old` text")}
     INSERT INTO workspaces (
       id, name, checkout_path, issue_tracker, source_control_old, linear_history
     ) VALUES ('workspace-1', 'kept', '/tmp/kept', '{}', 'original', 0);`,
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
const harnessName = Schema.decodeSync(HarnessName);

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
const LoggedSchemaChanges = Schema.Array(
  Schema.Struct({
    classification: Schema.Literals(["additive", "destructive"]),
    statement: Schema.String,
  }),
);
const LoggedSchemaConvergence = Schema.Tuple([
  Schema.Literal("converging Control store schema"),
  Schema.Struct({ changes: LoggedSchemaChanges }),
]);

type StructuredLog = ReturnType<typeof Logger.formatStructured.log>;

class ControlStoreLogProbe extends Context.Service<
  ControlStoreLogProbe,
  {
    readonly entries: Effect.Effect<ReadonlyArray<StructuredLog>>;
    readonly logger: Logger.Logger<unknown, void>;
  }
>()("@cogwork/engine/control-store.test/ControlStoreLogProbe") {
  static readonly layer = Layer.sync(ControlStoreLogProbe, () => {
    const entries = MutableRef.make<ReadonlyArray<StructuredLog>>([]);
    return {
      entries: Effect.sync(() => MutableRef.get(entries)),
      logger: Logger.make((options) =>
        MutableRef.update(entries, (current) => [...current, Logger.formatStructured.log(options)]),
      ),
    };
  });
}

const controlStoreBackups = (names: ReadonlyArray<string>) =>
  names.filter((name) => name.startsWith("control.db.") && name.endsWith(".backup"));

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

  it.effect("creates the store directory before acquiring its schema lock", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { dir } = yield* temporaryStore();
      const storePath = path.join(dir, "missing", "control.db");

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.strictEqual(yield* modeOf(path.dirname(storePath)), "700");
    }),
  );

  it.layer(ControlStoreLogProbe.layer)((it) => {
    it.effect("adds a column and table while preserving workspace and Operation settings", () =>
      Effect.gen(function* () {
        const { storePath } = yield* temporaryStore();
        const logProbe = yield* ControlStoreLogProbe;
        yield* poke(
          storePath,
          `${createStatements.join("\n")}
         INSERT INTO workspaces (
           id, name, checkout_path, issue_tracker, mcp_skills, linear_history,
           worktree_link_paths, worktree_setup
         ) VALUES (
           'workspace-1', 'kept', '/tmp/kept', '{"type":"github","connectionId":"unbound"}',
           '[{"name":"linear","endpoint":"https://mcp.linear.app/mcp/readonly","auth":{"type":"credential-store"}}]', 0,
           '[".repos"]', '["pnpm install"]'
         );
         INSERT INTO operation_settings (setting, level, workflow, operation, scope, workspace, value)
         VALUES
           ('harness', 'default', '', '', 'settings-profile', '', '"codex"'),
           ('model', 'default', '', '', 'settings-profile', '', '"openai/gpt-5"'),
           ('effort', 'default', '', '', 'settings-profile', '', '"high"'),
           ('enabled', 'operation', 'coding', 'triage', 'settings-profile', '', 'true'),
           ('enabled', 'operation', 'coding', 'implement', 'settings-profile', '', 'true'),
           ('enabled', 'operation', 'coding', 'follow-up', 'settings-profile', '', 'true');
         ALTER TABLE workspaces DROP COLUMN source_control;
         DROP TABLE connections;`,
        );
        const workspaceBefore = yield* query(
          storePath,
          `SELECT id, name, checkout_path, issue_tracker, mcp_skills, worktree_link_paths, worktree_setup
           FROM workspaces`,
        );
        const operationSettingsBefore = yield* query(
          storePath,
          `SELECT setting, level, workflow, operation, scope, workspace, value
           FROM operation_settings
           ORDER BY setting, operation`,
        );

        assert.deepStrictEqual(yield* storeAt(storePath).pipe(Effect.withLogger(logProbe.logger)), {
          health: "available",
        });
        assert.deepStrictEqual(
          yield* query(
            storePath,
            `SELECT id, name, checkout_path, issue_tracker, mcp_skills, worktree_link_paths, worktree_setup
             FROM workspaces`,
          ),
          workspaceBefore,
        );
        assert.deepStrictEqual(
          yield* query(
            storePath,
            `SELECT setting, level, workflow, operation, scope, workspace, value
             FROM operation_settings
             ORDER BY setting, operation`,
          ),
          operationSettingsBefore,
        );
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
        const convergenceLog = (yield* logProbe.entries)
          .map((entry) => entry.message)
          .find(Schema.is(LoggedSchemaConvergence));
        if (!convergenceLog) return assert.fail("expected convergence log");
        assert.isTrue(convergenceLog[1].changes.every((change) => change.classification === "additive"));
      }),
    );
  });

  it.effect("changes a column type while preserving existing rows", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* poke(
        storePath,
        `${createStatements
          .join("\n")
          .replace("`linear_history` integer NOT NULL", "`linear_history` text NOT NULL")}
         INSERT INTO workspaces (id, name, checkout_path, issue_tracker, linear_history)
         VALUES ('workspace-1', 'kept', '/tmp/kept', '{}', '0');`,
      );

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "SELECT id, name, linear_history FROM workspaces"), [
        { id: "workspace-1", name: "kept", linear_history: 0 },
      ]);
      assert.isTrue(
        (yield* query(storePath, "PRAGMA table_info(workspaces)")).some(
          (column) => column.name === "linear_history" && column.type === "INTEGER",
        ),
      );
    }),
  );

  it.effect("produces zero diff statements on the second boot after convergence", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.strictEqual(pushSchemaMock.mock.calls.length, 5);
    }),
  );

  it.effect("keeps a store valid when two boots race to converge it", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      const results = yield* Effect.all([storeAt(storePath), storeAt(storePath)], {
        concurrency: "unbounded",
      });

      assert.isTrue(results.some((store) => store.health === "available"));
      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(storePath, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    }),
  );

  it.effect("fails closed when the verification re-diff is not empty", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      yield* poke(
        storePath,
        `${createStatements.join("\n")}
         CREATE TABLE extra_data (value TEXT NOT NULL);
         INSERT INTO extra_data VALUES ('kept');`,
      );
      pushSchemaMock
        .mockResolvedValueOnce(schemaDiff(["DROP TABLE extra_data"]))
        .mockResolvedValueOnce(schemaDiff(["DROP TABLE extra_data"]))
        .mockResolvedValueOnce(schemaDiff(["ALTER TABLE convergence_probe ADD remaining TEXT"]));

      const store = yield* storeAt(storePath);

      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(
        store.health === "unavailable" &&
          store.message.includes("ALTER TABLE convergence_probe ADD remaining TEXT"),
      );
      assert.deepStrictEqual(yield* query(storePath, "SELECT value FROM extra_data"), [{ value: "kept" }]);
    }),
  );

  it.effect("fails closed on an unexpected schema diff error and leaves the store untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, storePath } = yield* temporaryStore();
      yield* poke(
        storePath,
        `${createStatements.join("\n")}
         CREATE TABLE extra_data (value TEXT NOT NULL);
         INSERT INTO extra_data VALUES ('kept');`,
      );
      pushSchemaMock.mockRejectedValueOnce(new Error("unexpected converge failure"));

      const store = yield* storeAt(storePath);
      const backups = controlStoreBackups(yield* fs.readDirectory(dir));

      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.includes("unexpected converge failure"));
      assert.deepStrictEqual(yield* query(storePath, "SELECT value FROM extra_data"), [{ value: "kept" }]);
      assert.deepStrictEqual(
        yield* query(
          storePath,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extra_data'",
        ),
        [{ name: "extra_data" }],
      );
      assert.strictEqual(backups.length, 0);
    }),
  );

  it.effect("fails closed on a schema preflight defect and leaves the store untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, storePath } = yield* temporaryStore();
      yield* poke(
        storePath,
        `${createStatements.join("\n")}
         CREATE TABLE extra_data (value TEXT NOT NULL);
         INSERT INTO extra_data VALUES ('kept');`,
      );
      pushSchemaMock.mockResolvedValueOnce({
        get sqlStatements() {
          throw new Error("unexpected preflight defect");
        },
        hints: [],
        apply: () => Promise.resolve(),
      });

      const store = yield* storeAt(storePath);
      const backups = controlStoreBackups(yield* fs.readDirectory(dir));

      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.includes("unexpected preflight defect"));
      assert.deepStrictEqual(yield* query(storePath, "SELECT value FROM extra_data"), [{ value: "kept" }]);
      assert.strictEqual(backups.length, 0);
    }),
  );

  it.effect("backs up a rename-shaped store and converges a fresh store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, storePath } = yield* temporaryStore();
      yield* pokeRenameShapedStore(storePath);

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      const backups = controlStoreBackups(yield* fs.readDirectory(dir));
      assert.strictEqual(backups.length, 1);
      const backupPath = path.join(dir, backups[0] ?? "missing");
      assert.deepStrictEqual(
        yield* query(backupPath, "SELECT id, name, source_control_old FROM workspaces"),
        [{ id: "workspace-1", name: "kept", source_control_old: "original" }],
      );
      assert.deepStrictEqual(yield* query(storePath, "SELECT id FROM workspaces"), []);
      assert.isTrue(
        (yield* query(storePath, "PRAGMA table_info(workspaces)")).some(
          (column) => column.name === "source_control",
        ),
      );
    }),
  );

  it.effect("leaves a rename-shaped store untouched when its WAL is active", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, storePath } = yield* temporaryStore();
      const writer = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const db = new DatabaseSync(storePath);
          db.exec(
            `${createStatements.join("\n").replace("`source_control` text", "`source_control_old` text")}
             PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             INSERT INTO workspaces (
               id, name, checkout_path, issue_tracker, source_control_old, linear_history
             ) VALUES ('workspace-1', 'kept', '/tmp/kept', '{}', 'original', 0);`,
          );
          return db;
        }),
        (db) => Effect.sync(() => db.close()),
      );

      assert.isTrue(yield* fs.exists(`${storePath}-wal`));
      const store = yield* storeAt(storePath);

      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.includes("WAL"));
      assert.isTrue(yield* fs.exists(storePath));
      assert.strictEqual(controlStoreBackups(yield* fs.readDirectory(dir)).length, 0);
      assert.deepStrictEqual(writer.prepare("SELECT id FROM workspaces").all(), [{ id: "workspace-1" }]);
    }),
  );

  it.effect("serializes racing rename-shaped preflights", () =>
    Effect.gen(function* () {
      const actualPushSchema = pushSchemaMock.getMockImplementation();
      if (!actualPushSchema) return yield* Effect.die("missing pushSchema implementation");
      const concurrency = MutableRef.make({ active: 0, maximum: 0 });
      pushSchemaMock.mockImplementation((...args) => {
        const current = MutableRef.get(concurrency);
        MutableRef.set(concurrency, {
          active: current.active + 1,
          maximum: Math.max(current.maximum, current.active + 1),
        });
        return Promise.resolve()
          .then(() => actualPushSchema(...args))
          .finally(() => MutableRef.update(concurrency, (state) => ({ ...state, active: state.active - 1 })));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => pushSchemaMock.mockImplementation(actualPushSchema)),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, storePath } = yield* temporaryStore();
      yield* pokeRenameShapedStore(storePath);

      const results = yield* Effect.all([storeAt(storePath), storeAt(storePath)], {
        concurrency: "unbounded",
      });
      const backups = controlStoreBackups(yield* fs.readDirectory(dir));

      assert.strictEqual(MutableRef.get(concurrency).maximum, 1);
      assert.isTrue(results.some((store) => store.health === "available"));
      assert.strictEqual(backups.length, 1);
      assert.deepStrictEqual(
        yield* query(path.join(dir, backups[0] ?? "missing"), "SELECT id FROM workspaces"),
        [{ id: "workspace-1" }],
      );
    }),
  );

  it.effect(
    "waits for a cross-process schema preflight lock",
    () =>
      Effect.gen(function* () {
        const { storePath } = yield* temporaryStore();
        const child = yield* ChildProcess.make(process.execPath, ["-e", lockHolderScript, storePath]);
        const ready = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );
        assert.strictEqual(Option.getOrUndefined(ready)?.trim(), "locked");

        const bootFiber = yield* Effect.forkChild(storeAt(storePath));
        yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
        assert.isUndefined(bootFiber.pollUnsafe());

        yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" });
        yield* Effect.ignore(child.exitCode);
        assert.deepStrictEqual(yield* Fiber.join(bootFiber).pipe(Effect.timeout("5 seconds")), {
          health: "available",
        });
      }),
    10_000,
  );

  it.effect("fails closed when the schema preflight lock is compromised", () =>
    Effect.gen(function* () {
      const actualPushSchema = pushSchemaMock.getMockImplementation();
      if (!actualPushSchema) return yield* Effect.die("missing pushSchema implementation");
      const pending = Promise.withResolvers<Awaited<ReturnType<typeof actualPushSchema>>>();
      const started = Deferred.makeUnsafe<void>();
      pushSchemaMock.mockImplementation(() => {
        Deferred.doneUnsafe(started, Effect.void);
        return pending.promise;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          pending.resolve(schemaDiff([]));
          pushSchemaMock.mockImplementation(actualPushSchema);
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const { storePath } = yield* temporaryStore();
      const bootFiber = yield* Effect.forkChild(storeAt(storePath));
      yield* Deferred.await(started);

      assert.strictEqual(pushSchemaMock.mock.calls.length, 1);
      assert.isTrue(yield* fs.exists(`${storePath}.lock`));
      yield* fs.remove(`${storePath}.lock`, { recursive: true });

      const store = yield* Fiber.join(bootFiber);
      assert.strictEqual(store.health, "unavailable");
      assert.isTrue(store.health === "unavailable" && store.message.includes("schema lock was compromised"));
    }),
  );

  it.effect("preserves an existing backup from the same timestamp", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, storePath } = yield* temporaryStore();
      const existingBackupPath = `${storePath}.1234.backup`;
      yield* TestClock.setTime(1234);
      yield* poke(
        existingBackupPath,
        "CREATE TABLE evidence (value TEXT NOT NULL); INSERT INTO evidence VALUES ('first');",
      );
      yield* poke(
        storePath,
        createStatements.join("\n").replace("`source_control` text", "`source_control_old` text"),
      );

      assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
      assert.deepStrictEqual(yield* query(existingBackupPath, "SELECT value FROM evidence"), [
        { value: "first" },
      ]);
      assert.strictEqual(
        (yield* fs.readDirectory(dir)).filter(
          (name) => name.startsWith("control.db.1234") && name.endsWith(".backup"),
        ).length,
        2,
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

  it.effect("measures time waiting for the write gate", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      const before = (yield* Metric.value(controlStoreWriteGateWaitDuration)).count;
      yield* withStore(storePath, (store) => store.withWrite(Effect.void));
      assert.strictEqual((yield* Metric.value(controlStoreWriteGateWaitDuration)).count, before + 1);
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

  it.layer(ControlStoreLogProbe.layer)((it) => {
    it.effect("ignores one stored setting for an unknown Operation without dropping valid settings", () =>
      Effect.gen(function* () {
        const { storePath } = yield* temporaryStore();
        const logProbe = yield* ControlStoreLogProbe;
        assert.deepStrictEqual(yield* storeAt(storePath), { health: "available" });
        yield* poke(
          storePath,
          `INSERT INTO operation_settings (setting, level, workflow, operation, scope, workspace, value)
           VALUES
             ('model', 'operation', 'coding', 'implement', 'settings-profile', '', '"openai/gpt-5"'),
             ('model', 'operation', 'coding', 'verify', 'settings-profile', '', '"ignored"');`,
        );

        const reloaded = yield* readControlStore(storePath).pipe(Effect.withLogger(logProbe.logger));

        assert.strictEqual(
          resolveOperationSetting(reloaded.operationSettings, "model", {
            workflow: "coding",
            operation: "implement",
            workspace,
          }),
          "openai/gpt-5",
        );
        assert.strictEqual(reloaded.operationSettings.length, 1);
        const warnings = (yield* logProbe.entries).filter(
          (entry) =>
            entry.level === "WARN" &&
            Array.isArray(entry.message) &&
            entry.message.includes("ignored stored Operation setting for unknown Operation"),
        );
        assert.strictEqual(warnings.length, 1);
      }),
    );
  });

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

  it.effect("sets and reloads Harness enablement", () =>
    Effect.gen(function* () {
      const { storePath } = yield* temporaryStore();
      const codex = harnessName("codex");

      yield* withStore(storePath, (store) => store.setHarnessEnabled(codex, false));

      const reloaded = yield* withStore(storePath, (store) => Effect.succeed(store.seed));
      assert.deepStrictEqual(reloaded.harnessSettings, [
        HarnessEnablement.make({ harness: codex, enabled: false }),
      ]);

      const enabled = yield* withStore(storePath, (store) => store.setHarnessEnabled(codex, true));
      assert.deepStrictEqual(enabled.harnessSettings, []);
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

  it.layer(ControlStoreLogProbe.layer)((it) => {
    it.effect("drops a column and table while preserving surviving rows", () =>
      Effect.gen(function* () {
        const { storePath } = yield* temporaryStore();
        const logProbe = yield* ControlStoreLogProbe;
        yield* poke(
          storePath,
          `${createStatements.join("\n")}
         ALTER TABLE workspaces ADD COLUMN legacy TEXT;
         INSERT INTO workspaces (id, name, checkout_path, issue_tracker, linear_history, legacy)
         VALUES ('workspace-1', 'kept', '/tmp/kept', '{}', 0, 'removed');
         CREATE TABLE extra_data (value TEXT NOT NULL);
         INSERT INTO extra_data (value) VALUES ('kept');`,
        );

        assert.deepStrictEqual(yield* storeAt(storePath).pipe(Effect.withLogger(logProbe.logger)), {
          health: "available",
        });
        assert.deepStrictEqual(yield* query(storePath, "SELECT id, name FROM workspaces"), [
          { id: "workspace-1", name: "kept" },
        ]);
        assert.isFalse(
          (yield* query(storePath, "PRAGMA table_info(workspaces)")).some(
            (column) => column.name === "legacy",
          ),
        );
        assert.deepStrictEqual(
          yield* query(
            storePath,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extra_data'",
          ),
          [],
        );
        const convergenceLog = (yield* logProbe.entries)
          .map((entry) => entry.message)
          .find(Schema.is(LoggedSchemaConvergence));
        if (!convergenceLog) return assert.fail("expected convergence log");
        const changes = convergenceLog[1].changes;
        assert.isTrue(
          changes.some(
            (change) => change.classification === "destructive" && change.statement.includes("extra_data"),
          ),
        );
        assert.isTrue(
          changes.some(
            (change) => change.classification === "destructive" && change.statement.includes("workspaces"),
          ),
        );
      }),
    );
  });

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
