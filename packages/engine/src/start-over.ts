import { ControlStoreFailure, keyOf, StartOverRefused, type WorkItemRef } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { ControlStore } from "./control-store";
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
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ControlStore;
  const plans = yield* WorkflowActionPlanStore;
  yield* sql<{ readonly action: string }>`
    SELECT action FROM coordination_claim_events
    WHERE work_item = ${key}
    ORDER BY sequence DESC
    LIMIT 1
  `.pipe(
    Effect.filterOrFail(
      (latest) => latest[0]?.action !== "claim",
      () =>
        new StartOverRefused({
          reason: "run-active",
          message: `A Run of ${key} is active. Wait for it to end, then start over.`,
        }),
    ),
    Effect.andThen(
      Effect.forEach(coordinationTables, (table) => sql`DELETE FROM ${sql(table)} WHERE work_item = ${key}`, {
        discard: true,
      }),
    ),
    Effect.andThen(plans.removeItem(key)),
    sql.withTransaction,
    store.withWrite,
    Effect.catchTag("SqlError", (error) => Effect.fail(storeFailure(error))),
  );
});
