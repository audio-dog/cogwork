import {
  keyOf,
  LineageId,
  WorkflowActionPlan,
  WorkItemId,
  type WorkItemRef,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { makeControlStoreCoordination } from "./coordination-control-store";
import { startOver } from "./start-over";
import { temporaryControlStoreLayer } from "./testing/temporary-control-store";
import { plan } from "./workflow-action-plan-fixtures";
import {
  controlStoreLayer as actionPlanStoreLayer,
  WorkflowActionPlanStore,
} from "./workflow-action-plan-store";

const workspace = WorkspaceId.make("workspace");
const issue = { _tag: "Issue", workspace, id: WorkItemId.make("#1") } as const satisfies WorkItemRef;
const otherIssue = { _tag: "Issue", workspace, id: WorkItemId.make("#2") } as const satisfies WorkItemRef;
const pullRequest = { _tag: "PullRequest", workspace, number: 3 } as const satisfies WorkItemRef;
const slackMessage = {
  _tag: "SlackMessage",
  team: "T1",
  channel: "C1",
  ts: "1.2",
} as const satisfies WorkItemRef;
const operation = { workflow: "workflow", operation: "implement" };

const coordinationTables = [
  "trigger_admissions",
  "coordination_source_revisions",
  "coordination_claim_events",
  "coordination_attempts",
  "coordination_parks",
  "coordination_handbacks",
  "coordination_items",
];
const itemTables = [...coordinationTables, "workflow_action_plans"];

const testLayer = actionPlanStoreLayer.pipe(Layer.provideMerge(temporaryControlStoreLayer));

const lineageOf = (ref: WorkItemRef) => ({ root: LineageId.make(keyOf(ref)), parent: null, hop: 0 });

const seed = Effect.fn("test.seed")(function* (ref: WorkItemRef) {
  const sql = yield* SqlClient.SqlClient;
  const coordination = yield* makeControlStoreCoordination;
  const plans = yield* WorkflowActionPlanStore;
  const key = keyOf(ref);
  const lineage = lineageOf(ref);
  yield* coordination.observe(ref, "revision-1", { _tag: "Unknown" });
  const claim = yield* coordination.claim(ref, { operation, lineage });
  yield* coordination.recordAttempt(ref, { operation, outcome: "failed", lineage });
  yield* coordination.release(ref, claim);
  yield* coordination.park(ref, { _tag: "Stuck", summary: "blocked" }, operation);
  yield* coordination.handBack(ref, { by: "person" });
  yield* sql`
    INSERT INTO trigger_admissions (work_item, revision, payload)
    VALUES (${key}, 'revision-1', '{"subscription":{"workflow":"workflow","trigger":"label"}}')
  `;
  yield* plans.create(WorkflowActionPlan.make({ ...plan([]), item: key }));
});

const rowCounts = Effect.fn("test.rowCounts")(function* (
  ref: WorkItemRef,
  tables: ReadonlyArray<string> = itemTables,
) {
  const sql = yield* SqlClient.SqlClient;
  const counts = yield* Effect.forEach(tables, (table) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM ${sql(table)} WHERE work_item = ${keyOf(ref)}
    `.pipe(Effect.map((rows) => [table, rows[0]?.count ?? 0] as const)),
  );
  return Object.fromEntries(counts);
});

const seededCoordinationCounts = {
  trigger_admissions: 1,
  coordination_source_revisions: 1,
  coordination_claim_events: 2,
  coordination_attempts: 1,
  coordination_parks: 1,
  coordination_handbacks: 1,
  coordination_items: 1,
};
const seededCounts = { ...seededCoordinationCounts, workflow_action_plans: 1 };
const refusalOf = (item: WorkItemRef) =>
  startOver({ item }).pipe(
    Effect.flip,
    Effect.orElseSucceed(() => null),
  );

const emptyCounts = Object.fromEntries(itemTables.map((table) => [table, 0]));

describe("startOver", () => {
  it.effect.each([issue, pullRequest])(
    "deletes the $_tag's coordination records and action plans and keeps other items",
    (item) =>
      Effect.gen(function* () {
        yield* seed(item);
        yield* seed(otherIssue);

        yield* startOver({ item });

        assert.deepStrictEqual(yield* rowCounts(item), emptyCounts);
        assert.deepStrictEqual(yield* rowCounts(otherIssue), seededCounts);
        const coordination = yield* makeControlStoreCoordination;
        assert.strictEqual(yield* coordination.observe(item, "revision-1", { _tag: "Unknown" }), "moved");
        assert.strictEqual((yield* coordination.read(item)).gate(operation)._tag, "Open");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses an item that is not a tracker issue or pull request and deletes nothing", () =>
    Effect.gen(function* () {
      yield* seed(slackMessage);

      const error = yield* refusalOf(slackMessage);

      assert.strictEqual(error?._tag === "StartOverRefused" && error.reason, "not-a-tracker-item");
      assert.deepStrictEqual(yield* rowCounts(slackMessage), seededCounts);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses while a Run holds the item's claim and deletes nothing", () =>
    Effect.gen(function* () {
      yield* seed(issue);
      const coordination = yield* makeControlStoreCoordination;
      yield* coordination.claim(issue, { operation, lineage: lineageOf(issue) });

      const error = yield* refusalOf(issue);

      assert.strictEqual(error?._tag === "StartOverRefused" && error.reason, "run-active");
      assert.deepStrictEqual(yield* rowCounts(issue), { ...seededCounts, coordination_claim_events: 3 });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deletes no coordination record when the action plans cannot be deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(issue);
      yield* sql`DROP TABLE workflow_action_plans`;

      const error = yield* Effect.flip(startOver({ item: issue }));

      assert.strictEqual(error._tag, "ControlStoreFailure");
      assert.deepStrictEqual(yield* rowCounts(issue, coordinationTables), seededCoordinationCounts);
    }).pipe(Effect.provide(testLayer)),
  );
});
