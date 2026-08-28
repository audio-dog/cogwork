import {
  type ContributionSettingCell,
  type ContributionSettingRow,
  ContributionSettingRow as ContributionSettingRowSchema,
  type ContributionSettingUpdate,
  type ContributionSettingValue,
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  type DaemonLimits,
  DaemonLimits as DaemonLimitsSchema,
  type DaemonLimitUpdate,
  defaultDaemonLimits,
  type OperationSettingCell,
  type OperationSettingRow,
  OperationSettingRow as OperationSettingRowSchema,
  type OperationSettingUpdate,
  type PluginInstall,
  PluginInstall as PluginInstallSchema,
  StaleControlStoreWrite,
} from "@cogwork/contracts";

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createStatements } from "./control-store-create.gen";

export type ControlStoreService =
  | {
      readonly health: "available";
      readonly seed: ControlStorePicture;
      readonly picture: Effect.Effect<ControlStorePicture, ControlStoreFailure>;
      readonly setDaemonLimit: (
        update: DaemonLimitUpdate,
      ) => Effect.Effect<ControlStorePicture, ControlStoreFailure | StaleControlStoreWrite>;
      readonly updateOperationSetting: (
        update: OperationSettingUpdate,
      ) => Effect.Effect<ControlStorePicture, ControlStoreFailure>;
      readonly installPlugin: (
        record: PluginInstall,
        contributionIds: ReadonlyArray<string>,
        mcpServerIds: ReadonlyArray<string>,
      ) => Effect.Effect<ControlStorePicture, ControlStoreFailure>;
      readonly uninstallPlugin: (pluginId: string) => Effect.Effect<ControlStorePicture, ControlStoreFailure>;
      readonly updateContributionSetting: (
        update: ContributionSettingUpdate,
      ) => Effect.Effect<ControlStorePicture, ControlStoreFailure>;
      readonly withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    }
  | {
      readonly health: "unavailable";
      readonly message: string;
      readonly seed: null;
      readonly picture: Effect.Effect<never, ControlStoreFailure>;
      readonly setDaemonLimit: (
        update: DaemonLimitUpdate,
      ) => Effect.Effect<never, ControlStoreFailure | StaleControlStoreWrite>;
      readonly updateOperationSetting: (
        update: OperationSettingUpdate,
      ) => Effect.Effect<never, ControlStoreFailure>;
      readonly installPlugin: (
        record: PluginInstall,
        contributionIds: ReadonlyArray<string>,
        mcpServerIds: ReadonlyArray<string>,
      ) => Effect.Effect<never, ControlStoreFailure>;
      readonly uninstallPlugin: (pluginId: string) => Effect.Effect<never, ControlStoreFailure>;
      readonly updateContributionSetting: (
        update: ContributionSettingUpdate,
      ) => Effect.Effect<never, ControlStoreFailure>;
      readonly withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    };
export class ControlStoreBootError extends Data.TaggedError("ControlStoreBootError")<{
  readonly message: string;
}> {}

const maximumRunEventAgeMillis = 1000 * 60 * 60 * 24 * 30;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const storeFailure = (operation: string) => (error: unknown) =>
  ControlStoreFailure.make({ operation, message: messageOf(error) });

const decodeDaemonLimits = Schema.decodeUnknownEffect(DaemonLimitsSchema);
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

const readOperationSettings = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const stored = yield* sql<StoredOperationSettingRow>`
      SELECT setting, level, workflow, operation, scope, workspace, value
      FROM operation_settings
      ORDER BY setting, level, workflow, operation, scope, workspace
    `;
    const rows = yield* decodeStoredOperationSettingRows(stored);
    return yield* Effect.forEach(rows, (row) =>
      Effect.flatMap(decodeJson(row.value), (value) =>
        decodeOperationSettingRow({
          setting: row.setting,
          level: levelOf(row),
          scope: scopeOf(row),
          value,
        }),
      ),
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
    const [operationSettings, pluginInstalls, contributionSettings] = yield* Effect.all([
      readOperationSettings(sql),
      readPluginInstalls(sql),
      readContributionSettings(sql),
    ]);
    return { daemonLimits, operationSettings, pluginInstalls, contributionSettings };
  });

const storedContributionScope = (scope: ContributionSettingCell["scope"]) =>
  scope._tag === "SettingsProfile"
    ? { scope: "settings-profile", workspace: "" }
    : { scope: "private-workspace-overlay", workspace: scope.workspace };

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

const storedLevel = (level: OperationSettingCell["level"]) => {
  if (level._tag === "Default") return { level: "default", workflow: "", operation: "" };
  if (level._tag === "Workflow") return { level: "workflow", workflow: level.workflow, operation: "" };
  return { level: "operation", workflow: level.workflow, operation: level.operation };
};

const storedScope = (scope: OperationSettingCell["scope"]) => {
  if (scope._tag === "SettingsProfile") return { scope: "settings-profile", workspace: "" };
  if (scope._tag === "RuntimeHost") return { scope: "runtime-host", workspace: "" };
  return { scope: "private-workspace-overlay", workspace: scope.workspace };
};

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
  const updateOperationSetting = Effect.fn("ControlStore.updateOperationSetting")(function* (
    update: OperationSettingUpdate,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (update._tag === "Set") yield* setOperationSetting(sql, update.row);
        else yield* clearOperationSetting(sql, update.cell);
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
        if (update._tag === "Set") yield* setContributionSetting(sql, update.row);
        else yield* clearContributionSetting(sql, update.cell);
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
    updateOperationSetting: (update: OperationSettingUpdate) =>
      updateOperationSetting(update).pipe(Effect.mapError(storeFailure("update Operation setting"))),
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
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => writeGate.withPermits(1)(effect),
  };
});

const schemaFingerprint = Effect.fn("ControlStore.schemaFingerprint")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
  }>`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name LIKE 'sqlite_autoindex_%' ORDER BY type, name`;
  return rows.map((row) => `${row.type}:${row.name}:${row.sql ?? ""}`).join("\n");
});

const createSchema = Effect.fn("ControlStore.createSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of createStatements) yield* sql.unsafe(statement);
});

const expectedSchemaFingerprint = Effect.fn("ControlStore.expectedSchemaFingerprint")(function* () {
  return yield* Effect.gen(function* () {
    yield* createSchema();
    return yield* schemaFingerprint();
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })));
});

const retainRunEvents = Effect.fn("ControlStore.retainRunEvents")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM run_events WHERE at < ${now - maximumRunEventAgeMillis}`;
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

// cogwork has no released version to migrate anyone from, so a store is created once and replaced
// whenever the schema moves. The comparison is exact because both sides run the same statements.
const boot = Effect.fn("ControlStore.boot")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(storePath, 0o600);
  const found = yield* schemaFingerprint();
  if (found === "") yield* createSchema();
  else if (found !== (yield* expectedSchemaFingerprint()))
    return yield* new ControlStoreBootError({
      message: `Control store schema does not match this build. Delete ${storePath} and start again.`,
    });
  yield* seedDaemonLimits();
  yield* retainRunEvents();
});

// The directory has to exist, and be private, before the client opens the file inside it. `mode`
// applies only to a directory `makeDirectory` creates, so an existing one needs the explicit chmod.
const prepareStoreDirectory = Effect.fn("ControlStore.prepareStoreDirectory")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(storePath), { recursive: true, mode: 0o700 });
  yield* fs.chmod(path.dirname(storePath), 0o700);
});

export const controlStoreClientLayer = (storePath: string) =>
  Layer.unwrap(
    Effect.map(prepareStoreDirectory(storePath), () => SqliteClient.layer({ filename: storePath })),
  );

const unavailable = (message: string): ControlStoreService => {
  const failure = ControlStoreFailure.make({ operation: "open Control store", message });
  return {
    health: "unavailable",
    message,
    seed: null,
    picture: Effect.fail(failure),
    setDaemonLimit: () => Effect.fail(failure),
    updateOperationSetting: () => Effect.fail(failure),
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

export const bootControlStoreLayer = (storePath: string) =>
  Layer.effect(
    ControlStore,
    Effect.andThen(boot(storePath), makeAvailableControlStore).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.andThen(
          Effect.logError("control store boot failed", { cause: Cause.pretty(cause) }),
          Effect.succeed(
            unavailable(Cause.hasFails(cause) ? messageOf(Cause.squash(cause)) : Cause.pretty(cause)),
          ),
        );
      }),
    ),
  );
