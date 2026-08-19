import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
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
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);
