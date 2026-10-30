import {
  ControlStoreFailure,
  type RunId,
  WorkflowActionPlan,
  type WorkflowId,
  type WorkItemKey,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ControlStore } from "./control-store";

export interface WorkflowActionPlanStoreService {
  readonly list: Effect.Effect<ReadonlyArray<WorkflowActionPlan>, ControlStoreFailure>;
  readonly find: (
    item: WorkItemKey,
    attempt: RunId,
  ) => Effect.Effect<WorkflowActionPlan | null, ControlStoreFailure>;
  readonly pending: (
    item: WorkItemKey,
    workflow: WorkflowId,
  ) => Effect.Effect<WorkflowActionPlan | null, ControlStoreFailure>;
  readonly create: (plan: WorkflowActionPlan) => Effect.Effect<WorkflowActionPlan, ControlStoreFailure>;
  readonly save: (plan: WorkflowActionPlan) => Effect.Effect<void, ControlStoreFailure>;
  readonly remove: (
    item: WorkItemKey,
    workflow: WorkflowId,
    attempt: RunId,
  ) => Effect.Effect<void, ControlStoreFailure>;
}

export class WorkflowActionPlanStore extends Context.Service<
  WorkflowActionPlanStore,
  WorkflowActionPlanStoreService
>()("@cogwork/engine/workflow-action-plan-store/WorkflowActionPlanStore") {}

const planKey = (plan: WorkflowActionPlan) => `${plan.item}:${plan.workflow}:${plan.attempt}`;
const snapshotPlan = (plan: WorkflowActionPlan) =>
  Schema.encodeEffect(WorkflowActionPlan)(plan).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowActionPlan)),
    Effect.mapError((error) =>
      ControlStoreFailure.make({
        operation: "snapshot Workflow action plan",
        message: String(error),
        retryable: false,
      }),
    ),
  );

export const makeMemory = Effect.gen(function* () {
  const plans = yield* Ref.make<ReadonlyMap<string, WorkflowActionPlan>>(new Map());
  return {
    list: Ref.get(plans).pipe(Effect.map((current) => [...current.values()])),
    find: (item, attempt) =>
      Ref.get(plans).pipe(
        Effect.map(
          (current) =>
            [...current.values()].find((plan) => plan.item === item && plan.attempt === attempt) ?? null,
        ),
      ),
    pending: (item, workflow) =>
      Ref.get(plans).pipe(
        Effect.map(
          (current) =>
            [...current.values()]
              .filter((plan) => plan.item === item && plan.workflow === workflow)
              .toSorted((left, right) => right.createdAtMillis - left.createdAtMillis)
              .at(0) ?? null,
        ),
      ),
    create: (plan) =>
      snapshotPlan(plan).pipe(
        Effect.tap((stored) => Ref.update(plans, (current) => new Map(current).set(planKey(stored), stored))),
      ),
    save: (plan) =>
      snapshotPlan(plan).pipe(
        Effect.flatMap((stored) =>
          Ref.update(plans, (current) => new Map(current).set(planKey(stored), stored)),
        ),
      ),
    remove: (item, workflow, attempt) =>
      Ref.update(plans, (current) => {
        const next = new Map(current);
        next.delete(`${item}:${workflow}:${attempt}`);
        return next;
      }),
  } satisfies WorkflowActionPlanStoreService;
});

export const memoryLayer = Layer.effect(WorkflowActionPlanStore, makeMemory);

const StoredPlan = Schema.Struct({ plan: Schema.String });
type StoredPlan = typeof StoredPlan.Type;
const decodeStoredPlans = Schema.decodeUnknownEffect(Schema.Array(StoredPlan));
const PlanJson = Schema.fromJsonString(WorkflowActionPlan);
const decodePlan = Schema.decodeUnknownEffect(PlanJson);
const encodePlan = Schema.encodeEffect(PlanJson);

const failure = (operation: string) => (error: unknown) =>
  ControlStoreFailure.make({
    operation,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });

const encodeStoredPlan = (operation: string, plan: WorkflowActionPlan) =>
  encodePlan(plan).pipe(Effect.mapError(failure(operation)));

export const makeControlStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ControlStore;
  const write = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    store.withWrite(effect).pipe(Effect.mapError(failure(operation)));
  return {
    list: sql<StoredPlan>`SELECT plan FROM workflow_action_plans`.pipe(
      Effect.flatMap(decodeStoredPlans),
      Effect.flatMap((rows) => Effect.forEach(rows, ({ plan }) => decodePlan(plan))),
      Effect.mapError(failure("list Workflow action plans")),
    ),
    find: (item, attempt) =>
      sql<StoredPlan>`
        SELECT plan
        FROM workflow_action_plans
        WHERE work_item = ${item} AND attempt = ${attempt}
        LIMIT 1
      `.pipe(
        Effect.flatMap(decodeStoredPlans),
        Effect.flatMap((rows) => {
          const row = rows.at(0);
          return row ? Effect.map(decodePlan(row.plan), (plan) => plan) : Effect.succeed(null);
        }),
        Effect.mapError(failure("find Workflow action plan")),
      ),
    pending: (item, workflow) =>
      sql<StoredPlan>`
        SELECT plan
        FROM workflow_action_plans
        WHERE work_item = ${item} AND workflow = ${workflow}
        ORDER BY created_at_millis DESC
        LIMIT 1
      `.pipe(
        Effect.flatMap(decodeStoredPlans),
        Effect.flatMap((rows) => {
          const row = rows.at(0);
          return row ? Effect.map(decodePlan(row.plan), (plan) => plan) : Effect.succeed(null);
        }),
        Effect.mapError(failure("read Workflow action plan")),
      ),
    create: (plan) =>
      snapshotPlan(plan).pipe(
        Effect.flatMap((stored) =>
          encodeStoredPlan("encode Workflow action plan", stored).pipe(
            Effect.flatMap((encoded) =>
              write(
                "create Workflow action plan",
                sql`
                  INSERT INTO workflow_action_plans (
                    work_item, workflow, attempt, created_at_millis, plan
                  ) VALUES (
                    ${stored.item}, ${stored.workflow}, ${stored.attempt},
                    ${stored.createdAtMillis}, ${encoded}
                  )
                `,
              ),
            ),
            Effect.map(() => stored),
          ),
        ),
      ),
    save: (plan) =>
      encodeStoredPlan("encode Workflow action plan", plan).pipe(
        Effect.flatMap((encoded) =>
          write(
            "update Workflow action plan",
            sql`
              UPDATE workflow_action_plans
              SET plan = ${encoded}
              WHERE work_item = ${plan.item}
                AND workflow = ${plan.workflow}
                AND attempt = ${plan.attempt}
            `,
          ),
        ),
        Effect.asVoid,
      ),
    remove: (item, workflow, attempt) =>
      write(
        "remove Workflow action plan",
        sql`
          DELETE FROM workflow_action_plans
          WHERE work_item = ${item} AND workflow = ${workflow} AND attempt = ${attempt}
        `,
      ).pipe(Effect.asVoid),
  } satisfies WorkflowActionPlanStoreService;
});

export const controlStoreLayer = Layer.effect(WorkflowActionPlanStore, makeControlStore);
