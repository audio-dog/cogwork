import {
  ControlStoreFailure,
  keyOf,
  StartOverRefused,
  WorkItemId,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { ControlStore } from "./control-store";
import { RunLedger } from "./run-ledger";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";

const coordinationTables = [
  "trigger_admissions",
  "coordination_source_revisions",
  "coordination_claim_events",
  "coordination_attempts",
  "coordination_parks",
  "coordination_handbacks",
  "coordination_items",
] as const;

const trackerItemTags = new Set<WorkItemRef["_tag"]>(["Issue", "PullRequest"]);

const storeFailure = (error: SqlError) =>
  ControlStoreFailure.make({ operation: "start over a work item", message: error.message, retryable: true });

export const startOver = Effect.fn("Daemon.StartOver")(function* (payload: { readonly item: WorkItemRef }) {
  const key = keyOf(payload.item);
  if (!trackerItemTags.has(payload.item._tag)) {
    return yield* new StartOverRefused({
      reason: "not-a-tracker-item",
      message: `${key} is not a GitHub or Linear issue or pull request.`,
    });
  }
  const running = yield* (yield* RunLedger).runningRuns;
  const runItem = WorkItemId.make(key);
  if (running.some((run) => run.workItem === runItem)) {
    return yield* new StartOverRefused({
      reason: "run-active",
      message: `A Run of ${key} is active. Wait for it to end, then start over.`,
    });
  }
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ControlStore;
  const plans = yield* WorkflowActionPlanStore;
  yield* Effect.forEach(
    coordinationTables,
    (table) => sql`DELETE FROM ${sql(table)} WHERE work_item = ${key}`,
    { discard: true },
  ).pipe(
    Effect.andThen(plans.removeItem(key)),
    sql.withTransaction,
    store.withWrite,
    Effect.catchTag("SqlError", (error) => Effect.fail(storeFailure(error))),
  );
});
