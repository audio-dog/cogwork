import { maxSchedulerLimit } from "@cogwork/contracts";
import { desc, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const daemonLimits = sqliteTable(
  "daemon_limits",
  {
    id: integer("id").primaryKey(),
    globalConcurrency: integer("global_concurrency").notNull(),
    perWorkspaceConcurrency: integer("per_workspace_concurrency").notNull(),
    dailyBudget: integer("daily_budget").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    check("daemon_limits_single_row", sql`${table.id} = 1`),
    check(
      "daemon_limits_global_concurrency",
      sql`${table.globalConcurrency} BETWEEN 1 AND ${sql.raw(String(maxSchedulerLimit))}`,
    ),
    check(
      "daemon_limits_per_workspace_concurrency",
      sql`${table.perWorkspaceConcurrency} BETWEEN 1 AND ${sql.raw(String(maxSchedulerLimit))}`,
    ),
    check(
      "daemon_limits_daily_budget",
      sql`${table.dailyBudget} BETWEEN 1 AND ${sql.raw(String(maxSchedulerLimit))}`,
    ),
    check("daemon_limits_revision", sql`${table.revision} >= 0`),
  ],
);

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    system: text("system").notNull(),
    account: text("account").notNull(),
    status: text("status").notNull(),
  },
  (table) => [
    check("connections_system", sql`${table.system} IN ('github', 'linear')`),
    check("connections_status", sql`${table.status} IN ('established', 'revoked')`),
  ],
);

export const contributionSettings = sqliteTable(
  "contribution_settings",
  {
    contribution: text("contribution").notNull(),
    scope: text("scope").notNull(),
    workspace: text("workspace").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [
    // Storage tags deliberately duplicate ContributionSettingScope; update both together.
    primaryKey({ columns: [table.contribution, table.scope, table.workspace] }),
    check(
      "contribution_settings_scope",
      sql`(${table.scope} = 'settings-profile' AND ${table.workspace} = '') OR (${table.scope} = 'private-workspace-overlay' AND ${table.workspace} <> '')`,
    ),
  ],
);

export const harnessSettings = sqliteTable("harness_settings", {
  harness: text("harness").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
});

export const operationSettings = sqliteTable(
  "operation_settings",
  {
    setting: text("setting").notNull(),
    level: text("level").notNull(),
    workflow: text("workflow").notNull(),
    operation: text("operation").notNull(),
    scope: text("scope").notNull(),
    workspace: text("workspace").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    // Storage tags deliberately duplicate SettingLevel and OperationSettingScope; update both together.
    primaryKey({
      columns: [table.setting, table.level, table.workflow, table.operation, table.scope, table.workspace],
    }),
    check(
      "operation_settings_level",
      sql`(${table.level} = 'default' AND ${table.workflow} = '' AND ${table.operation} = '') OR (${table.level} = 'workflow' AND ${table.workflow} <> '' AND ${table.operation} = '') OR (${table.level} = 'operation' AND ${table.workflow} <> '' AND ${table.operation} <> '')`,
    ),
    check(
      "operation_settings_scope",
      sql`(${table.scope} IN ('settings-profile', 'runtime-host') AND ${table.workspace} = '') OR (${table.scope} = 'private-workspace-overlay' AND ${table.workspace} <> '')`,
    ),
    check(
      "operation_settings_runtime_host",
      sql`${table.scope} <> 'runtime-host' OR ${table.setting} = 'harness'`,
    ),
  ],
);

export const pluginInstalls = sqliteTable("plugin_installs", {
  pluginId: text("plugin_id").primaryKey(),
  resolvedIdentity: text("resolved_identity").notNull(),
  principal: text("principal").notNull(),
  installedAtMillis: integer("installed_at_millis").notNull(),
});

// Effect's `Migrator` creates and owns its own bookkeeping table, so it is deliberately absent
// here: including it would make drizzle-kit generate a rival definition of the same table.
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspace: text("workspace").notNull(),
    workItem: text("work_item").notNull(),
    stage: text("stage").notNull(),
    harness: text("harness").notNull(),
    branch: text("branch"),
    session: text("session"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    estimated: integer("estimated", { mode: "boolean" }),
    status: text("status").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    eventCount: integer("event_count").notNull().default(0),
  },
  (table) => [index("runs_started_at").on(desc(table.startedAt))],
);
export const runPlans = sqliteTable("run_plans", {
  runId: text("run_id").primaryKey(),
  plan: text("plan").notNull(),
});
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  workspace: text("workspace").notNull(),
  harness: text("harness").notNull(),
  kind: text("kind").notNull(),
  handle: text("handle"),
  createdAt: integer("created_at").notNull(),
});
export const runEvents = sqliteTable(
  "run_events",
  {
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    name: text("name"),
    data: text("data").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] }), index("run_events_at").on(table.at)],
);
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  checkoutPath: text("checkout_path").notNull().unique(),
  gitRemote: text("git_remote"),
  issueTracker: text("issue_tracker").notNull(),
  sourceControl: text("source_control"),
  mcpSkills: text("mcp_skills"),
  linearHistory: integer("linear_history", { mode: "boolean" }).notNull(),
  worktreeRoot: text("worktree_root"),
  worktreeRemote: text("worktree_remote"),
  worktreeBaseBranch: text("worktree_base_branch"),
  worktreeLinkPaths: text("worktree_link_paths"),
  worktreeSetup: text("worktree_setup"),
  worktreeReapAfterMillis: integer("worktree_reap_after_millis"),
  concurrency: integer("concurrency"),
});
