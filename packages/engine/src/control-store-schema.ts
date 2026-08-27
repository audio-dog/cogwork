import { desc } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  },
  (table) => [index("runs_started_at").on(desc(table.startedAt))],
);
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
  checkoutPath: text("checkout_path").notNull(),
  gitRemote: text("git_remote"),
  issueTracker: text("issue_tracker").notNull(),
  sourceControl: text("source_control"),
  linearHistory: integer("linear_history", { mode: "boolean" }).notNull(),
  worktreeRoot: text("worktree_root"),
  worktreeRemote: text("worktree_remote"),
  worktreeBaseBranch: text("worktree_base_branch"),
  worktreeReapAfterMillis: integer("worktree_reap_after_millis"),
  concurrency: integer("concurrency"),
});
