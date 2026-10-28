import { DatabaseSync } from "node:sqlite";
import {
  type Connection,
  type ConnectionId,
  Connection as ConnectionSchema,
  type ContributionSettingCell,
  type ContributionSettingRow,
  ContributionSettingRow as ContributionSettingRowSchema,
  ContributionSettingScope,
  ContributionSettingUpdate,
  type ContributionSettingValue,
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  type DaemonLimits,
  DaemonLimits as DaemonLimitsSchema,
  type DaemonLimitUpdate,
  defaultDaemonLimits,
  HarnessEnablement,
  type HarnessName,
  LifecycleStage,
  type OperationSettingCell,
  OperationSettingName,
  type OperationSettingRow,
  OperationSettingRow as OperationSettingRowSchema,
  OperationSettingScope,
  OperationSettingUpdate,
  type PluginInstall,
  PluginInstall as PluginInstallSchema,
  SettingLevel,
  StaleControlStoreWrite,
} from "@cogwork/contracts";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as DrizzleSqlite from "drizzle-kit/payload/sqlite";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import lockfile, { type LockOptions } from "proper-lockfile";
import * as controlStoreSchema from "./control-store-schema";

export const controlStoreWriteGateWaitDuration = Metric.timer(
  "cogwork_control_store_write_gate_wait_duration",
  { description: "Time spent waiting to enter the Control store write gate." },
);

type ControlStoreMutators<Picture> = {
  readonly setDaemonLimit: (
    update: DaemonLimitUpdate,
  ) => Effect.Effect<Picture, ControlStoreFailure | StaleControlStoreWrite>;
  readonly establishConnection: (connection: Connection) => Effect.Effect<Picture, ControlStoreFailure>;
  readonly revokeConnection: (connectionId: ConnectionId) => Effect.Effect<Picture, ControlStoreFailure>;
  readonly removeConnection: (connectionId: ConnectionId) => Effect.Effect<Picture, ControlStoreFailure>;
  readonly setHarnessEnabled: (
    harness: HarnessName,
    enabled: boolean,
  ) => Effect.Effect<Picture, ControlStoreFailure>;
  readonly updateOperationSettings: (
    updates: ReadonlyArray<OperationSettingUpdate>,
  ) => Effect.Effect<Picture, ControlStoreFailure>;
  readonly installPlugin: (
    record: PluginInstall,
    contributionIds: ReadonlyArray<string>,
    mcpServerIds: ReadonlyArray<string>,
  ) => Effect.Effect<Picture, ControlStoreFailure>;
  readonly uninstallPlugin: (pluginId: string) => Effect.Effect<Picture, ControlStoreFailure>;
  readonly updateContributionSetting: (
    update: ContributionSettingUpdate,
  ) => Effect.Effect<Picture, ControlStoreFailure>;
};

export type ControlStoreService = {
  readonly withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
} & (
  | (ControlStoreMutators<ControlStorePicture> & {
      readonly health: "available";
      readonly seed: ControlStorePicture;
      readonly picture: Effect.Effect<ControlStorePicture, ControlStoreFailure>;
    })
  | (ControlStoreMutators<never> & {
      readonly health: "unavailable";
      readonly message: string;
      readonly seed: null;
      readonly picture: Effect.Effect<never, ControlStoreFailure>;
    })
);
export class ControlStoreBootError extends Data.TaggedError("ControlStoreBootError")<{
  readonly message: string;
}> {}
class RenameShapedControlStoreDiff extends Data.TaggedError("RenameShapedControlStoreDiff")<{
  readonly message: string;
}> {}

type ControlStoreSchemaStatements = Effect.Effect<
  ReadonlyArray<string>,
  ControlStoreBootError | RenameShapedControlStoreDiff,
  SqlClient.SqlClient
>;
type ControlStoreSchemaChange = {
  readonly classification: "additive" | "destructive";
  readonly statement: string;
};
type ControlStoreClientOptions = Pick<SqliteClient.SqliteClientConfig, "busyTimeout">;

type WalCheckpoint = {
  readonly busy: number;
  readonly checkpointed: number;
  readonly log: number;
};

type SqliteJournalMode = {
  readonly journal_mode: string;
};

type AutoVacuumMode = {
  readonly auto_vacuum: number;
};

type FreelistPageCount = {
  readonly freelist_count: number;
};

const PageCount = Schema.Struct({ page_count: Schema.Finite });

const walBackupFailure = (error: unknown) =>
  new ControlStoreBootError({
    message: `Control store WAL preparation failed: ${messageOf(error)}`,
  });

const maximumRunEventAge = Duration.days(30);
const maximumRunEventBytes = 256 * 1024 * 1024;
const maximumIncrementalVacuumPages = 4096;
const schemaPreflightLockOptions = {
  realpath: false,
  retries: {
    retries: 200,
    factor: 1,
    minTimeout: 50,
    maxTimeout: 50,
    randomize: true,
  },
  stale: 5_000,
  update: 1_000,
} satisfies LockOptions;
const additiveSchemaStatementPatterns = [
  /^CREATE\s+TABLE\s+/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+/i,
  /^ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+ADD(?:\s+COLUMN)?\s+/i,
];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const databaseFileFailure = (operation: string) => (error: unknown) =>
  new ControlStoreBootError({
    message: `Control store database ${operation} failed: ${messageOf(error)}`,
  });

const withDatabaseFile = <A>(storePath: string, operation: string, use: (database: DatabaseSync) => A) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => new DatabaseSync(storePath),
      catch: databaseFileFailure("open"),
    }),
    (database) =>
      Effect.try({
        try: () => use(database),
        catch: databaseFileFailure(operation),
      }),
    (database) =>
      Effect.try({
        try: () => database.close(),
        catch: databaseFileFailure("close"),
      }),
  );

const runDatabasePragma = Effect.fn("ControlStore.runDatabasePragma")(
  (storePath: string, statement: string) =>
    withDatabaseFile(storePath, "pragma", (database) => database.exec(statement)),
);

const initializeStoreFile = Effect.fn("ControlStore.initializeStoreFile")((storePath: string) =>
  withDatabaseFile(storePath, "initialize", (database) => {
    const { page_count: pageCount } = Schema.decodeUnknownSync(PageCount)(
      database.prepare("PRAGMA page_count;").get(),
    );
    if (pageCount > 0) return;
    database.exec("PRAGMA auto_vacuum=INCREMENTAL;");
  }),
);

const schemaDiffError = (error: unknown) => {
  const message = messageOf(error);
  if (/resolver\([^)]*\) was called without a HintsHandler/.test(message))
    return new RenameShapedControlStoreDiff({ message });
  return new ControlStoreBootError({ message: `Control store schema diff failed: ${message}` });
};

const classifySchemaStatement = (statement: string) =>
  ({
    classification: additiveSchemaStatementPatterns.some((pattern) => pattern.test(statement.trim()))
      ? "additive"
      : "destructive",
    statement,
  }) satisfies ControlStoreSchemaChange;

const isForeignKeysPragma = (statement: string) => /^PRAGMA\s+foreign_keys\s*=/i.test(statement.trim());

const disablesForeignKeys = (statement: string) =>
  /^PRAGMA\s+foreign_keys\s*=\s*OFF\s*;?$/i.test(statement.trim());

const storeFailure = (operation: string) => (error: unknown) =>
  ControlStoreFailure.make({ operation, message: messageOf(error), retryable: true });

const decodeDaemonLimits = Schema.decodeUnknownEffect(DaemonLimitsSchema);
const decodeConnection = Schema.decodeUnknownEffect(ConnectionSchema);
const decodeContributionSettingRow = Schema.decodeUnknownEffect(ContributionSettingRowSchema);
const decodeOperationSettingRow = Schema.decodeUnknownEffect(OperationSettingRowSchema);
const decodePluginInstall = Schema.decodeUnknownEffect(PluginInstallSchema);
const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(JsonValue);
const encodeJson = Schema.encodeUnknownEffect(JsonValue);
const isStaleControlStoreWrite = Schema.is(StaleControlStoreWrite);

const setDaemonLimitFailure = (error: unknown) =>
  isStaleControlStoreWrite(error) ? error : storeFailure("set daemon limit")(error);

const StoredOperationSettingRow = Schema.Struct({
  setting: Schema.String,
  level: Schema.Literals(["default", "workflow", "operation"]),
  workflow: Schema.String,
  operation: Schema.String,
  scope: Schema.Literals(["settings-profile", "runtime-host", "private-workspace-overlay"]),
  workspace: Schema.String,
  value: Schema.String,
});
type StoredOperationSettingRow = typeof StoredOperationSettingRow.Type;

const StoredContributionSettingRow = Schema.Struct({
  contribution: Schema.String,
  scope: Schema.Literals(["settings-profile", "private-workspace-overlay"]),
  workspace: Schema.String,
  enabled: Schema.Literals([0, 1]),
});
type StoredContributionSettingRow = typeof StoredContributionSettingRow.Type;

const decodeStoredContributionSettingRows = Schema.decodeUnknownEffect(
  Schema.Array(StoredContributionSettingRow),
);

const decodeStoredOperationSettingRows = Schema.decodeUnknownEffect(Schema.Array(StoredOperationSettingRow));

const StoredHarnessSetting = Schema.Struct({
  harness: Schema.String,
  enabled: Schema.Literals([0, 1]),
});
type StoredHarnessSetting = typeof StoredHarnessSetting.Type;
const decodeStoredHarnessSettings = Schema.decodeUnknownEffect(Schema.Array(StoredHarnessSetting));
const decodeHarnessSettings = Schema.decodeUnknownEffect(Schema.Array(HarnessEnablement));

const readHarnessSettings = Effect.fn("ControlStore.readHarnessSettings")(function* (
  sql: SqlClient.SqlClient,
) {
  const stored = yield* sql<StoredHarnessSetting>`
    SELECT harness, enabled
    FROM harness_settings
    ORDER BY harness
  `;
  const rows = yield* decodeStoredHarnessSettings(stored);
  return yield* decodeHarnessSettings(
    rows.map((row) => ({ harness: row.harness, enabled: row.enabled === 1 })),
  );
});

const StoredPluginInstall = Schema.Struct({
  pluginId: Schema.String,
  resolvedIdentity: Schema.String,
  principal: Schema.String,
  installedAtMillis: Schema.Finite,
});
type StoredPluginInstall = typeof StoredPluginInstall.Type;
const decodeStoredPluginInstalls = Schema.decodeUnknownEffect(Schema.Array(StoredPluginInstall));

const contributionScopeOf = (row: StoredContributionSettingRow) =>
  row.scope === "settings-profile"
    ? ({ _tag: "SettingsProfile" } satisfies { readonly _tag: "SettingsProfile" })
    : ({
        _tag: "PrivateWorkspaceOverlay",
        workspace: row.workspace,
      } satisfies {
        readonly _tag: "PrivateWorkspaceOverlay";
        readonly workspace: string | null;
      });

const readContributionSettings = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const stored = yield* sql<StoredContributionSettingRow>`
      SELECT contribution, scope, workspace, enabled
      FROM contribution_settings
      ORDER BY contribution, scope, workspace
    `;
    const rows = yield* decodeStoredContributionSettingRows(stored);
    return yield* Effect.forEach(rows, (row) =>
      decodeContributionSettingRow({
        contribution: { id: row.contribution, kind: "mcp-server" },
        scope: contributionScopeOf(row),
        enabled: row.enabled === 1,
      }),
    );
  });

const StoredConnection = Schema.Struct({
  id: Schema.String,
  system: Schema.String,
  account: Schema.String,
  status: Schema.String,
});
type StoredConnection = typeof StoredConnection.Type;
const decodeStoredConnections = Schema.decodeUnknownEffect(Schema.Array(StoredConnection));

const readConnections = Effect.fn("ControlStore.readConnections")(function* (sql: SqlClient.SqlClient) {
  const stored = yield* sql<StoredConnection>`
      SELECT id, system, account, status
      FROM connections
      ORDER BY system, account
    `;
  const rows = yield* decodeStoredConnections(stored);
  return yield* Effect.forEach(rows, (row) => decodeConnection(row));
});

const levelOf = (row: StoredOperationSettingRow) => {
  if (row.level === "default") return { _tag: "Default" };
  if (row.level === "workflow") return { _tag: "Workflow", workflow: row.workflow };
  return { _tag: "Operation", workflow: row.workflow, operation: row.operation };
};

const scopeOf = (row: StoredOperationSettingRow) => {
  if (row.scope === "settings-profile") return { _tag: "SettingsProfile" };
  if (row.scope === "runtime-host") return { _tag: "RuntimeHost" };
  return { _tag: "PrivateWorkspaceOverlay", workspace: row.workspace };
};

const decodeStoredOperationSettingRow = Effect.fn("ControlStore.decodeStoredOperationSettingRow")(function* (
  row: StoredOperationSettingRow,
) {
  if (!Schema.is(OperationSettingName)(row.setting)) {
    yield* Effect.logWarning("ignored stored retired or unknown Operation setting", {
      setting: row.setting,
    });
    return null;
  }
  if (row.level === "operation" && !Schema.is(LifecycleStage)(row.operation)) {
    yield* Effect.logWarning("ignored stored Operation setting for unknown Operation", {
      operation: row.operation,
      setting: row.setting,
    });
    return null;
  }
  const value = yield* decodeJson(row.value);
  return yield* decodeOperationSettingRow({
    setting: row.setting,
    level: levelOf(row),
    scope: scopeOf(row),
    value,
  });
});

const readOperationSettings = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const stored = yield* sql<StoredOperationSettingRow>`
      SELECT setting, level, workflow, operation, scope, workspace, value
      FROM operation_settings
      ORDER BY setting, level, workflow, operation, scope, workspace
    `;
    const rows = yield* decodeStoredOperationSettingRows(stored);
    return yield* Effect.forEach(rows, decodeStoredOperationSettingRow).pipe(
      Effect.map((decoded) => decoded.filter((row) => row !== null)),
    );
  });

const readPluginInstalls = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const stored = yield* sql<StoredPluginInstall>`
      SELECT
        plugin_id AS pluginId,
        resolved_identity AS resolvedIdentity,
        principal,
        installed_at_millis AS installedAtMillis
      FROM plugin_installs
      ORDER BY plugin_id
    `;
    const rows = yield* decodeStoredPluginInstalls(stored);
    return yield* Effect.forEach(rows, (row) => decodePluginInstall(row));
  });

const readPicture = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const [row] = yield* sql<DaemonLimits>`
      SELECT
        global_concurrency AS globalConcurrency,
        per_workspace_concurrency AS perWorkspaceConcurrency,
        daily_budget AS dailyBudget,
        revision
      FROM daemon_limits
      WHERE id = 1
    `;
    const daemonLimits = yield* decodeDaemonLimits(row);
    const [connections, harnessSettings, operationSettings, pluginInstalls, contributionSettings] =
      yield* Effect.all([
        readConnections(sql),
        readHarnessSettings(sql),
        readOperationSettings(sql),
        readPluginInstalls(sql),
        readContributionSettings(sql),
      ]);
    return {
      daemonLimits,
      connections,
      harnessSettings,
      operationSettings,
      pluginInstalls,
      contributionSettings,
    };
  });

const writeHarnessEnabled = Effect.fn("ControlStore.writeHarnessEnabled")(function* (
  sql: SqlClient.SqlClient,
  harness: HarnessName,
  enabled: boolean,
) {
  if (enabled) {
    yield* sql`DELETE FROM harness_settings WHERE harness = ${harness}`;
    return;
  }
  yield* sql`
    INSERT INTO harness_settings (harness, enabled)
    VALUES (${harness}, 0)
    ON CONFLICT (harness)
    DO UPDATE SET enabled = excluded.enabled
  `;
});

const storedContributionScope = (scope: ContributionSettingCell["scope"]) =>
  ContributionSettingScope.match(scope, {
    SettingsProfile: () => ({ scope: "settings-profile", workspace: "" }),
    PrivateWorkspaceOverlay: ({ workspace }) => ({
      scope: "private-workspace-overlay",
      workspace,
    }),
  });

const storedContributionCell = (cell: ContributionSettingCell) => ({
  contribution: cell.contribution.id,
  ...storedContributionScope(cell.scope),
});

const setContributionSetting = Effect.fn("ControlStore.setContributionSetting")(function* (
  sql: SqlClient.SqlClient,
  row: ContributionSettingValue,
) {
  const cell = storedContributionCell(row);
  yield* sql`
    INSERT INTO contribution_settings (contribution, scope, workspace, enabled)
    VALUES (${cell.contribution}, ${cell.scope}, ${cell.workspace}, ${row.enabled ? 1 : 0})
    ON CONFLICT (contribution, scope, workspace)
    DO UPDATE SET enabled = excluded.enabled
  `;
});

const clearContributionSetting = Effect.fn("ControlStore.clearContributionSetting")(function* (
  sql: SqlClient.SqlClient,
  cell: ContributionSettingCell,
) {
  const stored = storedContributionCell(cell);
  yield* sql`
    DELETE FROM contribution_settings
    WHERE contribution = ${stored.contribution}
      AND scope = ${stored.scope}
      AND workspace = ${stored.workspace}
  `;
});

const storedLevel = (level: OperationSettingCell["level"]) =>
  SettingLevel.match(level, {
    Default: () => ({ level: "default", workflow: "", operation: "" }),
    Workflow: ({ workflow }) => ({ level: "workflow", workflow, operation: "" }),
    Operation: ({ workflow, operation }) => ({ level: "operation", workflow, operation }),
  });

const storedScope = (scope: OperationSettingCell["scope"]) =>
  OperationSettingScope.match(scope, {
    SettingsProfile: () => ({ scope: "settings-profile", workspace: "" }),
    RuntimeHost: () => ({ scope: "runtime-host", workspace: "" }),
    PrivateWorkspaceOverlay: ({ workspace }) => ({
      scope: "private-workspace-overlay",
      workspace,
    }),
  });

const storedCell = (cell: OperationSettingCell) => ({
  setting: cell.setting,
  ...storedLevel(cell.level),
  ...storedScope(cell.scope),
});

const setOperationSetting = Effect.fn("ControlStore.setOperationSetting")(function* (
  sql: SqlClient.SqlClient,
  row: OperationSettingRow,
) {
  const cell = storedCell(row);
  const value = yield* encodeJson(row.value);
  yield* sql`
    INSERT INTO operation_settings (setting, level, workflow, operation, scope, workspace, value)
    VALUES (${cell.setting}, ${cell.level}, ${cell.workflow}, ${cell.operation}, ${cell.scope}, ${cell.workspace}, ${value})
    ON CONFLICT (setting, level, workflow, operation, scope, workspace)
    DO UPDATE SET value = excluded.value
  `;
});

const clearOperationSetting = Effect.fn("ControlStore.clearOperationSetting")(function* (
  sql: SqlClient.SqlClient,
  cell: OperationSettingCell,
) {
  const stored = storedCell(cell);
  yield* sql`
    DELETE FROM operation_settings
    WHERE setting = ${stored.setting}
      AND level = ${stored.level}
      AND workflow = ${stored.workflow}
      AND operation = ${stored.operation}
      AND scope = ${stored.scope}
      AND workspace = ${stored.workspace}
  `;
});

const retainedContributionIds = (settings: ReadonlyArray<ContributionSettingRow>, prefix: string) =>
  settings
    .filter((setting) => setting.contribution.id.startsWith(prefix))
    .map((setting) => setting.contribution.id);

const deleteDroppedContributionSettings = Effect.fn("ControlStore.deleteDroppedContributionSettings")(
  function* (sql: SqlClient.SqlClient, pluginId: string, contributionIds: ReadonlyArray<string>) {
    const current = yield* readContributionSettings(sql);
    const retained = new Set(contributionIds);
    const dropped = retainedContributionIds(current, `plugin:${pluginId}/`).filter((id) => !retained.has(id));
    yield* Effect.forEach(
      dropped,
      (id) => sql`DELETE FROM contribution_settings WHERE contribution = ${id}`,
      {
        discard: true,
      },
    );
  },
);

const writePluginInstall = Effect.fn("ControlStore.writePluginInstall")(function* (
  sql: SqlClient.SqlClient,
  record: PluginInstall,
) {
  yield* sql`
    INSERT INTO plugin_installs (plugin_id, resolved_identity, principal, installed_at_millis)
    VALUES (${record.pluginId}, ${record.resolvedIdentity}, ${record.principal}, ${record.installedAtMillis})
    ON CONFLICT (plugin_id) DO UPDATE SET
      resolved_identity = excluded.resolved_identity,
      principal = excluded.principal,
      installed_at_millis = excluded.installed_at_millis
  `;
});

export const readOnlyControlStoreClientLayer = (storePath: string) =>
  SqliteClient.layer({ filename: storePath, readonly: true, disableWAL: true });

export const readControlStore = Effect.fn("ControlStore.read")((storePath: string) =>
  Effect.flatMap(SqlClient.SqlClient, readPicture).pipe(
    Effect.provide(readOnlyControlStoreClientLayer(storePath)),
    Effect.scoped,
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      return Effect.fail(storeFailure("read Control store")(Cause.squash(cause)));
    }),
  ),
);

const updateLimitRevision = (sql: SqlClient.SqlClient, update: DaemonLimitUpdate) => {
  if (update.key === "global-concurrency") {
    return sql<{ readonly revision: number }>`
      UPDATE daemon_limits
      SET global_concurrency = ${update.value}, revision = revision + 1
      WHERE id = 1 AND revision = ${update.expectedRevision}
      RETURNING revision
    `;
  }
  if (update.key === "per-workspace-concurrency") {
    return sql<{ readonly revision: number }>`
      UPDATE daemon_limits
      SET per_workspace_concurrency = ${update.value}, revision = revision + 1
      WHERE id = 1 AND revision = ${update.expectedRevision}
      RETURNING revision
    `;
  }
  return sql<{ readonly revision: number }>`
    UPDATE daemon_limits
    SET daily_budget = ${update.value}, revision = revision + 1
    WHERE id = 1 AND revision = ${update.expectedRevision}
    RETURNING revision
  `;
};

const makeAvailableControlStore = Effect.fn("ControlStore.makeAvailable")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writeGate = Semaphore.makeUnsafe(1);
  const picture = () => readPicture(sql).pipe(Effect.mapError(storeFailure("read Control store")));
  const seed: ControlStorePicture = yield* picture();
  const setDaemonLimit = Effect.fn("ControlStore.setDaemonLimit")(function* (update: DaemonLimitUpdate) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* updateLimitRevision(sql, update);
        if (updated.length > 0) return yield* readPicture(sql);
        const actual = yield* readPicture(sql);
        return yield* StaleControlStoreWrite.make({
          expectedRevision: update.expectedRevision,
          actualRevision: actual.daemonLimits.revision,
        });
      }),
    );
  });
  const establishConnection = Effect.fn("ControlStore.establishConnection")(function* (
    connection: Connection,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO connections (id, system, account, status)
          VALUES (${connection.id}, ${connection.system}, ${connection.account}, 'established')
          ON CONFLICT (id) DO UPDATE SET
            system = excluded.system,
            account = excluded.account,
            status = 'established'
        `;
        return yield* readPicture(sql);
      }),
    );
  });
  const revokeConnection = Effect.fn("ControlStore.revokeConnection")(function* (connectionId: ConnectionId) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE connections SET status = 'revoked' WHERE id = ${connectionId}`;
        return yield* readPicture(sql);
      }),
    );
  });
  const removeConnection = Effect.fn("ControlStore.removeConnection")(function* (connectionId: ConnectionId) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM connections WHERE id = ${connectionId}`;
        return yield* readPicture(sql);
      }),
    );
  });
  const setHarnessEnabled = Effect.fn("ControlStore.setHarnessEnabled")(function* (
    harness: HarnessName,
    enabled: boolean,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* writeHarnessEnabled(sql, harness, enabled);
        return yield* readPicture(sql);
      }),
    );
  });
  const updateOperationSettings = Effect.fn("ControlStore.updateOperationSettings")(function* (
    updates: ReadonlyArray<OperationSettingUpdate>,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* Effect.forEach(
          updates,
          (update) =>
            OperationSettingUpdate.match(update, {
              Set: ({ row }) => setOperationSetting(sql, row),
              Clear: ({ cell }) => clearOperationSetting(sql, cell),
            }),
          { discard: true },
        );
        return yield* readPicture(sql);
      }),
    );
  });
  const installPlugin = Effect.fn("ControlStore.installPlugin")(function* (
    record: PluginInstall,
    contributionIds: ReadonlyArray<string>,
    mcpServerIds: ReadonlyArray<string>,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* readPluginInstalls(sql);
        const prior = current.find((entry) => entry.pluginId === record.pluginId);
        if (prior?.resolvedIdentity === record.resolvedIdentity) return yield* readPicture(sql);
        yield* deleteDroppedContributionSettings(sql, record.pluginId, contributionIds);
        yield* writePluginInstall(sql, record);
        yield* Effect.forEach(
          mcpServerIds,
          (contribution) =>
            sql`
              INSERT OR IGNORE INTO contribution_settings (contribution, scope, workspace, enabled)
              VALUES (${contribution}, 'settings-profile', '', 1)
            `,
          { discard: true },
        );
        return yield* readPicture(sql);
      }),
    );
  });
  const uninstallPlugin = Effect.fn("ControlStore.uninstallPlugin")(function* (pluginId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM plugin_installs WHERE plugin_id = ${pluginId}`;
        yield* sql`DELETE FROM contribution_settings WHERE contribution LIKE ${`plugin:${pluginId}/%`}`;
        return yield* readPicture(sql);
      }),
    );
  });
  const updateContributionSetting = Effect.fn("ControlStore.updateContributionSetting")(function* (
    update: ContributionSettingUpdate,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* ContributionSettingUpdate.match(update, {
          Set: ({ row }) => setContributionSetting(sql, row),
          Clear: ({ cell }) => clearContributionSetting(sql, cell),
        });
        return yield* readPicture(sql);
      }),
    );
  });
  return {
    health: "available" as const,
    seed,
    picture: picture(),
    setDaemonLimit: (update: DaemonLimitUpdate) =>
      setDaemonLimit(update).pipe(Effect.mapError(setDaemonLimitFailure)),
    establishConnection: (connection: Connection) =>
      establishConnection(connection).pipe(Effect.mapError(storeFailure("establish Connection"))),
    revokeConnection: (connectionId: ConnectionId) =>
      revokeConnection(connectionId).pipe(Effect.mapError(storeFailure("revoke Connection"))),
    removeConnection: (connectionId: ConnectionId) =>
      removeConnection(connectionId).pipe(Effect.mapError(storeFailure("remove Connection"))),
    setHarnessEnabled: (harness: HarnessName, enabled: boolean) =>
      setHarnessEnabled(harness, enabled).pipe(Effect.mapError(storeFailure("set Harness enablement"))),
    updateOperationSettings: (updates: ReadonlyArray<OperationSettingUpdate>) =>
      updateOperationSettings(updates).pipe(Effect.mapError(storeFailure("update Operation settings"))),
    installPlugin: (
      record: PluginInstall,
      contributionIds: ReadonlyArray<string>,
      mcpServerIds: ReadonlyArray<string>,
    ) =>
      installPlugin(record, contributionIds, mcpServerIds).pipe(
        Effect.mapError(storeFailure("install Plugin")),
      ),
    uninstallPlugin: (pluginId: string) =>
      uninstallPlugin(pluginId).pipe(Effect.mapError(storeFailure("uninstall Plugin"))),
    updateContributionSetting: (update: ContributionSettingUpdate) =>
      updateContributionSetting(update).pipe(Effect.mapError(storeFailure("update contribution setting"))),
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        writeGate.take(1).pipe(Effect.trackDuration(controlStoreWriteGateWaitDuration)),
        () => effect,
        () => writeGate.release(1),
      ),
  };
});

const controlStoreSchemaStatements = Effect.fn("ControlStore.schemaStatements")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const runPromise = yield* FiberSet.makeRuntimePromise();
      const database = {
        query: <T = never>(query: string, params: ReadonlyArray<unknown> = []) =>
          runPromise(sql.unsafe<T & object>(query, params)).then((rows) => rows.map((row) => row)),
        run: (query: string) => runPromise(sql.unsafe(query)).then(() => undefined),
        batch: (statements: ReadonlyArray<string>) =>
          runPromise(
            Effect.forEach(statements, (statement) => sql.unsafe(statement), {
              discard: true,
            }),
          ).then(() => undefined),
      };
      const result = yield* Effect.tryPromise({
        try: () => DrizzleSqlite.pushSchema(controlStoreSchema, database),
        catch: schemaDiffError,
      });
      return result.sqlStatements;
    }),
  );
});

const convergeSchema = Effect.fn("ControlStore.convergeSchema")(function* (
  schemaStatements: ControlStoreSchemaStatements,
) {
  const sql = yield* SqlClient.SqlClient;
  const statements = yield* schemaStatements;
  if (statements.length === 0) return;
  const changes = statements.map(classifySchemaStatement);
  const transactionStatements = statements.filter((statement) => !isForeignKeysPragma(statement));
  const transaction = sql.withTransaction(
    Effect.gen(function* () {
      yield* Effect.forEach(transactionStatements, (statement) => sql.unsafe(statement), {
        discard: true,
      });
      const remaining = yield* schemaStatements;
      if (remaining.length === 0) return;
      return yield* new ControlStoreBootError({
        message: `Control store schema did not converge. Remaining statements:\n${remaining.join("\n")}`,
      });
    }),
  );
  yield* Effect.logInfo("converging Control store schema", { changes });
  if (!statements.some(disablesForeignKeys)) return yield* transaction;
  return yield* Effect.acquireUseRelease(
    sql.unsafe("PRAGMA foreign_keys=OFF;"),
    () => transaction,
    () => sql.unsafe("PRAGMA foreign_keys=ON;"),
  );
});

export const retainRunEvents = Effect.fn("ControlStore.retainRunEvents")(function* (
  storePath: string,
  byteBudget = maximumRunEventBytes,
  vacuumPageBudget = maximumIncrementalVacuumPages,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const cutoff = now - Duration.toMillis(maximumRunEventAge);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        WITH eligible_runs AS (
          SELECT
            runs.id,
            runs.started_at,
            runs.ended_at,
            sum(length(cast(run_events.data AS blob))) AS event_bytes
          FROM runs
          INNER JOIN sessions
            ON sessions.id = runs.session
            AND sessions.kind = 'opaque-handle'
          INNER JOIN run_events ON run_events.run_id = runs.id
          WHERE runs.status IN ('succeeded', 'declined', 'failed', 'exhausted', 'interrupted', 'crashed')
            AND runs.ended_at IS NOT NULL
          GROUP BY runs.id, runs.started_at, runs.ended_at
        ),
        size_candidates AS (
          SELECT
            id,
            sum(event_bytes) OVER (
              ORDER BY ended_at DESC, started_at DESC, id DESC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS newest_bytes
          FROM eligible_runs
          WHERE ended_at >= ${cutoff}
        ),
        prunable_runs AS (
          SELECT id FROM eligible_runs WHERE ended_at < ${cutoff}
          UNION
          SELECT id FROM size_candidates WHERE newest_bytes > ${byteBudget}
        )
        UPDATE runs
        SET event_count = 0, events_pruned_at = ${now}
        WHERE id IN (SELECT id FROM prunable_runs)
      `;
      yield* sql`
        DELETE FROM run_events
        WHERE run_id IN (
          SELECT id FROM runs WHERE events_pruned_at = ${now}
        )
      `;
    }),
  );
  const [autoVacuum] = yield* sql.unsafe<AutoVacuumMode>("PRAGMA auto_vacuum;");
  if (autoVacuum?.auto_vacuum !== 2) return;
  const [freelist] = yield* sql.unsafe<FreelistPageCount>("PRAGMA freelist_count;");
  if ((freelist?.freelist_count ?? 0) === 0) return;
  yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE);");
  yield* runDatabasePragma(storePath, `PRAGMA incremental_vacuum(${vacuumPageBudget});`);
});

const seedDaemonLimits = Effect.fn("ControlStore.seedDaemonLimits")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO daemon_limits (
      id,
      global_concurrency,
      per_workspace_concurrency,
      daily_budget,
      revision
    ) VALUES (
      1,
      ${defaultDaemonLimits.globalConcurrency},
      ${defaultDaemonLimits.perWorkspaceConcurrency},
      ${defaultDaemonLimits.dailyBudget},
      ${defaultDaemonLimits.revision}
    )
  `;
});

const boot = Effect.fn("ControlStore.boot")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(storePath, 0o600);
  yield* convergeSchema(controlStoreSchemaStatements());
  yield* seedDaemonLimits();
  yield* retainRunEvents(storePath);
});

// The directory has to exist, and be private, before the client opens the file inside it. `mode`
// applies only to a directory `makeDirectory` creates, so an existing one needs the explicit chmod.
const prepareStoreDirectory = Effect.fn("ControlStore.prepareStoreDirectory")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(storePath), { recursive: true, mode: 0o700 });
  yield* fs.chmod(path.dirname(storePath), 0o700);
});

export const controlStoreClientLayer = (storePath: string, options: ControlStoreClientOptions = {}) =>
  Layer.unwrap(
    Effect.map(prepareStoreDirectory(storePath), () =>
      SqliteClient.layer({
        filename: storePath,
        ...(options.busyTimeout === undefined ? {} : { busyTimeout: options.busyTimeout }),
      }),
    ),
  );

const prepareStoreForRenameBackup = Effect.fn("ControlStore.prepareStoreForRenameBackup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [checkpoint] = yield* sql
    .unsafe<WalCheckpoint>("PRAGMA wal_checkpoint(TRUNCATE);")
    .pipe(Effect.mapError(walBackupFailure));
  const checkpointComplete = checkpoint?.busy === 0 && checkpoint.log === checkpoint.checkpointed;
  if (!checkpointComplete) {
    return yield* new ControlStoreBootError({
      message: "Control store WAL checkpoint did not complete before backup",
    });
  }
  const [journalMode] = yield* sql
    .unsafe<SqliteJournalMode>("PRAGMA journal_mode=DELETE;")
    .pipe(Effect.mapError(walBackupFailure));
  if (journalMode?.journal_mode === "delete") return;
  return yield* new ControlStoreBootError({
    message: "Control store WAL journal mode remained active before backup",
  });
});

const ensureWalSidecarsAreAbsent = Effect.fn("ControlStore.ensureWalSidecarsAreAbsent")(function* (
  storePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const sidecars = [`${storePath}-wal`, `${storePath}-shm`];
  const remaining = yield* Effect.filter(sidecars, (path) => fs.exists(path));
  if (remaining.length === 0) return;
  return yield* new ControlStoreBootError({
    message: `Control store WAL sidecars remain before backup: ${remaining.join(", ")}`,
  });
});

const backupRenameShapedStore = Effect.fn("ControlStore.backupRenameShapedStore")(function* (
  storePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* ensureWalSidecarsAreAbsent(storePath);
  const timestamp = yield* Clock.currentTimeMillis;
  const reservationPath = yield* fs.makeTempDirectory({
    directory: path.dirname(storePath),
    prefix: `${path.basename(storePath)}.${timestamp}.`,
  });
  const backupPath = `${reservationPath}.backup`;
  yield* fs.remove(reservationPath, { recursive: true });
  yield* fs.rename(storePath, backupPath);
  yield* Effect.logWarning("backed up rename-shaped Control store", { backupPath });
});

const backupRenameShapedStoreIfRequired = (storePath: string, required: boolean) => {
  if (!required) return Effect.void;
  return backupRenameShapedStore(storePath);
};

const withSchemaPreflightLock = <A, E, R>(storePath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      yield* prepareStoreDirectory(storePath);
      const compromised = yield* Deferred.make<never, ControlStoreBootError>();
      const release = yield* Effect.tryPromise({
        try: () =>
          lockfile.lock(storePath, {
            ...schemaPreflightLockOptions,
            onCompromised: (error) =>
              Deferred.doneUnsafe(
                compromised,
                Effect.fail(
                  new ControlStoreBootError({
                    message: `Control store schema lock was compromised: ${messageOf(error)}`,
                  }),
                ),
              ),
          }),
        catch: (error) =>
          new ControlStoreBootError({
            message: `Control store schema lock failed: ${messageOf(error)}`,
          }),
      });
      return { compromised, release };
    }),
    ({ compromised }) => Effect.raceFirst(effect, Deferred.await(compromised)),
    ({ release }) =>
      Effect.tryPromise({
        try: () => release(),
        catch: (error) =>
          new ControlStoreBootError({
            message: `Control store schema lock release failed: ${messageOf(error)}`,
          }),
      }),
  );

const bootFailureMessage = (cause: Cause.Cause<unknown>) => {
  if (!Cause.hasFails(cause)) return Cause.pretty(cause);
  return messageOf(Cause.squash(cause));
};

const recoverSchemaPreflightFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
  return Effect.succeed(
    new ControlStoreBootError({
      message: `Control store schema preflight failed: ${bootFailureMessage(cause)}`,
    }),
  );
};

const prepareSchemaFallback = Effect.fn("ControlStore.prepareSchemaFallback")(
  (storePath: string, options: ControlStoreClientOptions) =>
    withSchemaPreflightLock(
      storePath,
      Effect.andThen(
        initializeStoreFile(storePath),
        Effect.scoped(
          controlStoreSchemaStatements().pipe(
            Effect.map(() => false),
            Effect.catchTag("RenameShapedControlStoreDiff", () =>
              prepareStoreForRenameBackup().pipe(Effect.map(() => true)),
            ),
            Effect.provide(controlStoreClientLayer(storePath, options)),
          ),
        ).pipe(
          Effect.flatMap((requiresBackup) => backupRenameShapedStoreIfRequired(storePath, requiresBackup)),
          Effect.andThen(initializeStoreFile(storePath)),
          Effect.as<ControlStoreBootError | null>(null),
        ),
      ),
    ).pipe(Effect.catchCause(recoverSchemaPreflightFailure)),
);

const unavailable = (message: string): ControlStoreService => {
  const failure = ControlStoreFailure.make({ operation: "open Control store", message, retryable: true });
  return {
    health: "unavailable",
    message,
    seed: null,
    picture: Effect.fail(failure),
    setDaemonLimit: () => Effect.fail(failure),
    establishConnection: () => Effect.fail(failure),
    revokeConnection: () => Effect.fail(failure),
    removeConnection: () => Effect.fail(failure),
    setHarnessEnabled: () => Effect.fail(failure),
    updateOperationSettings: () => Effect.fail(failure),
    installPlugin: () => Effect.fail(failure),
    uninstallPlugin: () => Effect.fail(failure),
    updateContributionSetting: () => Effect.fail(failure),
    withWrite: (effect) => effect,
  };
};

export const ControlStore = Context.Reference<ControlStoreService>(
  "@cogwork/engine/control-store/ControlStore",
  { defaultValue: () => unavailable("Control store did not boot") },
);

const recoverBootFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
  return Effect.andThen(
    Effect.logError("control store boot failed", { cause: Cause.pretty(cause) }),
    Effect.succeed(unavailable(bootFailureMessage(cause))),
  );
};

const bootControlStore = (storePath: string, preflightError: ControlStoreBootError | null) => {
  if (preflightError) return Effect.succeed(unavailable(preflightError.message));
  return Effect.andThen(boot(storePath), makeAvailableControlStore).pipe(
    Effect.catchCause(recoverBootFailure),
  );
};

export const bootControlStoreLayer = (storePath: string, options: ControlStoreClientOptions = {}) =>
  Layer.unwrap(
    Effect.map(prepareSchemaFallback(storePath, options), (preflightError) => {
      const client = controlStoreClientLayer(storePath, options);
      return Layer.merge(
        Layer.effect(ControlStore, bootControlStore(storePath, preflightError)).pipe(Layer.provide(client)),
        client,
      );
    }),
  );
