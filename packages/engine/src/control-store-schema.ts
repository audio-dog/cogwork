import { maxSchedulerLimit, type WorkflowActionPlan, type WorkflowDocument } from "@cogwork/contracts";
import { desc, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    check("connections_system", sql`${table.system} IN ('github', 'linear', 'granola')`),
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

export const coordinationItems = sqliteTable("coordination_items", {
  workItem: text("work_item").primaryKey(),
});

export const coordinationSourceRevisions = sqliteTable(
  "coordination_source_revisions",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    workItem: text("work_item").notNull(),
    revision: text("revision").notNull(),
    processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("coordination_source_revisions_item_revision").on(table.workItem, table.revision),
    index("coordination_source_revisions_item_sequence").on(table.workItem, desc(table.sequence)),
    check("coordination_source_revisions_revision", sql`length(trim(${table.revision})) > 0`),
  ],
);

export const triggerAdmissions = sqliteTable(
  "trigger_admissions",
  {
    workItem: text("work_item").notNull(),
    revision: text("revision").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workItem, table.revision] }),
    check("trigger_admissions_payload_json", sql`json_valid(${table.payload})`),
  ],
);

export const triggerSubscriptionCheckpoints = sqliteTable(
  "trigger_subscription_checkpoints",
  {
    workflow: text("workflow").notNull(),
    trigger: text("trigger").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    checkpointMillis: integer("checkpoint_millis").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workflow, table.trigger] }),
    check("trigger_subscription_checkpoints_millis", sql`${table.checkpointMillis} >= 0`),
  ],
);

export const coordinationClaimEvents = sqliteTable(
  "coordination_claim_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    workItem: text("work_item")
      .notNull()
      .references(() => coordinationItems.workItem),
    action: text("action").notNull(),
    by: text("by"),
    claimedAtMillis: integer("claimed_at_millis"),
    workflow: text("workflow"),
    operation: text("operation"),
    lineageRoot: text("lineage_root"),
    lineageParent: text("lineage_parent"),
    lineageHop: integer("lineage_hop"),
    releasedClaimSequence: integer("released_claim_sequence"),
  },
  (table) => [
    index("coordination_claim_events_item_sequence").on(table.workItem, desc(table.sequence)),
    check("coordination_claim_events_action", sql`${table.action} IN ('claim', 'release')`),
    check(
      "coordination_claim_events_shape",
      sql`(${table.action} = 'claim' AND ${table.by} IS NOT NULL AND ${table.claimedAtMillis} IS NOT NULL AND ${table.workflow} IS NOT NULL AND ${table.operation} IS NOT NULL AND ${table.lineageRoot} IS NOT NULL AND ${table.lineageHop} IS NOT NULL AND ${table.releasedClaimSequence} IS NULL) OR (${table.action} = 'release' AND ${table.by} IS NULL AND ${table.claimedAtMillis} IS NULL AND ${table.workflow} IS NULL AND ${table.operation} IS NULL AND ${table.lineageRoot} IS NULL AND ${table.lineageParent} IS NULL AND ${table.lineageHop} IS NULL AND ${table.releasedClaimSequence} IS NOT NULL)`,
    ),
    check("coordination_claim_events_by", sql`${table.by} IS NULL OR length(trim(${table.by})) > 0`),
    check(
      "coordination_claim_events_claimed_at",
      sql`${table.claimedAtMillis} IS NULL OR ${table.claimedAtMillis} >= 0`,
    ),
    check(
      "coordination_claim_events_workflow",
      sql`${table.workflow} IS NULL OR length(trim(${table.workflow})) > 0`,
    ),
    check(
      "coordination_claim_events_operation",
      sql`${table.operation} IS NULL OR length(trim(${table.operation})) > 0`,
    ),
    check(
      "coordination_claim_events_lineage_root",
      sql`${table.lineageRoot} IS NULL OR length(trim(${table.lineageRoot})) > 0`,
    ),
    check(
      "coordination_claim_events_lineage_hop",
      sql`${table.lineageHop} IS NULL OR ${table.lineageHop} >= 0`,
    ),
  ],
);

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    principal: text("principal").notNull(),
    workingCopy: text("working_copy", { mode: "json" }).$type<WorkflowDocument>().notNull(),
    workingRevision: integer("working_revision").notNull(),
    publishedCopy: text("published_copy", { mode: "json" }).$type<WorkflowDocument>(),
    publishedRevision: integer("published_revision"),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [
    check("workflows_working_copy_json", sql`json_valid(${table.workingCopy})`),
    check("workflows_working_revision", sql`${table.workingRevision} >= 1`),
    check(
      "workflows_published_copy_json",
      sql`${table.publishedCopy} IS NULL OR json_valid(${table.publishedCopy})`,
    ),
    check(
      "workflows_published_pair",
      sql`(${table.publishedCopy} IS NULL) = (${table.publishedRevision} IS NULL)`,
    ),
    check(
      "workflows_published_revision",
      sql`${table.publishedRevision} IS NULL OR ${table.publishedRevision} >= 1`,
    ),
  ],
);

export const workflowActionPlans = sqliteTable(
  "workflow_action_plans",
  {
    workItem: text("work_item")
      .notNull()
      .references(() => coordinationItems.workItem),
    workflow: text("workflow").notNull(),
    attempt: text("attempt").notNull(),
    createdAtMillis: integer("created_at_millis").notNull(),
    plan: text("plan", { mode: "json" }).$type<WorkflowActionPlan>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workItem, table.workflow, table.attempt] }),
    index("workflow_action_plans_pending").on(table.workItem, table.workflow, desc(table.createdAtMillis)),
    check("workflow_action_plans_workflow", sql`length(trim(${table.workflow})) > 0`),
    check("workflow_action_plans_attempt", sql`length(trim(${table.attempt})) > 0`),
    check("workflow_action_plans_created_at", sql`${table.createdAtMillis} >= 0`),
    check("workflow_action_plans_plan_json", sql`json_valid(${table.plan})`),
  ],
);

export const coordinationAttempts = sqliteTable(
  "coordination_attempts",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    workItem: text("work_item")
      .notNull()
      .references(() => coordinationItems.workItem),
    workflow: text("workflow").notNull(),
    operation: text("operation").notNull(),
    outcome: text("outcome").notNull(),
    atMillis: integer("at_millis").notNull(),
    lineageRoot: text("lineage_root").notNull(),
    lineageParent: text("lineage_parent"),
    lineageHop: integer("lineage_hop").notNull(),
  },
  (table) => [
    index("coordination_attempts_item_sequence").on(table.workItem, table.sequence),
    check("coordination_attempts_workflow", sql`length(trim(${table.workflow})) > 0`),
    check("coordination_attempts_operation", sql`length(trim(${table.operation})) > 0`),
    check("coordination_attempts_outcome", sql`${table.outcome} IN ('succeeded', 'failed', 'abandoned')`),
    check("coordination_attempts_at", sql`${table.atMillis} >= 0`),
    check("coordination_attempts_lineage_root", sql`length(trim(${table.lineageRoot})) > 0`),
    check("coordination_attempts_lineage_hop", sql`${table.lineageHop} >= 0`),
  ],
);

export const coordinationHandbacks = sqliteTable(
  "coordination_handbacks",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    workItem: text("work_item")
      .notNull()
      .references(() => coordinationItems.workItem),
    by: text("by").notNull(),
    atMillis: integer("at_millis").notNull(),
    note: text("note"),
  },
  (table) => [
    index("coordination_handbacks_item_sequence").on(table.workItem, desc(table.sequence)),
    check("coordination_handbacks_by", sql`length(trim(${table.by})) > 0`),
    check("coordination_handbacks_at", sql`${table.atMillis} >= 0`),
  ],
);

export const coordinationParks = sqliteTable(
  "coordination_parks",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    workItem: text("work_item")
      .notNull()
      .references(() => coordinationItems.workItem),
    reason: text("reason").notNull(),
    atMillis: integer("at_millis").notNull(),
  },
  (table) => [
    index("coordination_parks_item_sequence").on(table.workItem, table.sequence),
    check("coordination_parks_reason", sql`length(trim(${table.reason})) > 0`),
    check("coordination_parks_at", sql`${table.atMillis} >= 0`),
  ],
);

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
    eventsPrunedAt: integer("events_pruned_at"),
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
  lastRepository: text("last_repository"),
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
