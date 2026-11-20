import { keyOf, LineageId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { bootControlStoreLayer } from "./control-store";
import { makeControlStoreCoordination } from "./coordination-control-store";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { event, lineage, otherWorkflowId, subscription, workflowId } from "./trigger-observation-fixtures";
import { makeControlStoreTriggerObservationStore } from "./trigger-observation-store";

const exerciseFailedLastAdmissionFinish = (storePath: string, admission: TriggerAdmission) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* makeControlStoreTriggerObservationStore;
    const coordination = yield* makeControlStoreCoordination;
    yield* coordination.observe(event.key, event.revision, event.cause);
    yield* store.putAll([admission]);
    yield* sql`
      CREATE TRIGGER fail_trigger_admission_finish
      BEFORE UPDATE OF processed ON trigger_admissions
      WHEN NEW.processed = 1
      BEGIN
        SELECT RAISE(ABORT, 'finish failed');
      END
    `;
    const failure = yield* Effect.flip(
      store.complete(admission, coordination.markProcessed(event.key, event.revision)),
    );
    const failedView = yield* coordination.read(event.key);
    const pending = yield* store.admissions;
    yield* sql`DROP TRIGGER fail_trigger_admission_finish`;
    yield* store.complete(admission, coordination.markProcessed(event.key, event.revision));
    const completedView = yield* coordination.read(event.key);
    const remaining = yield* store.admissions;
    return { failure, failedView, pending, completedView, remaining };
  }).pipe(Effect.provide(bootControlStoreLayer(storePath)));

const exerciseFailedFanOutFinish = Effect.fn("TriggerObservationTest.exerciseFailedFanOutFinish")(function* (
  parent: TriggerAdmission,
  child: TriggerAdmission,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeControlStoreTriggerObservationStore;
  yield* store.putAll([parent]);
  yield* sql`
      CREATE TRIGGER fail_fan_out_parent_finish
      BEFORE UPDATE OF processed ON trigger_admissions
      WHEN NEW.processed = 1
      BEGIN
        SELECT RAISE(ABORT, 'finish failed');
      END
    `;
  const failure = yield* Effect.flip(store.fanOut(parent, [child], Effect.void));
  return { failure, pending: yield* store.admissions };
});

layer(NodeServices.layer)((it) => {
  it.effect("persists and completes every matching Workflow admission for one revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-admissions-" });
      const storePath = path.join(directory, "control.db");
      const sourceEvent = {
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      } as const;
      const sourceLineageRoot = yield* Schema.decodeEffect(LineageId)(keyOf(sourceEvent.key));
      const sourceLineage = {
        root: sourceLineageRoot,
        parent: null,
        hop: 0,
      } as const;
      const first = { event: sourceEvent, subscription, lineage: sourceLineage };
      const second = {
        event: sourceEvent,
        subscription: { ...subscription, workflow: otherWorkflowId },
        lineage: sourceLineage,
      };
      const closed = yield* Ref.make(0);
      const closeRevision = Ref.update(closed, (count) => count + 1);
      const result = yield* makeControlStoreTriggerObservationStore.pipe(
        Effect.flatMap((store) =>
          Effect.all([
            store.putAll([first, second]),
            store.admissions,
            store.complete(first, closeRevision),
            Ref.get(closed),
            store.admissions,
            store.complete(second, closeRevision),
            Ref.get(closed),
            store.admissions,
          ]).pipe(
            Effect.map(([, stored, , closedAfterFirst, afterFirst, , closedAfterSecond, remaining]) => ({
              stored,
              closedAfterFirst,
              afterFirst,
              closedAfterSecond,
              remaining,
            })),
          ),
        ),
        Effect.provide(bootControlStoreLayer(storePath)),
      );

      assert.deepStrictEqual(
        result.stored.map(({ subscription }) => subscription.workflow).toSorted(),
        [workflowId, otherWorkflowId].toSorted(),
      );
      assert.deepStrictEqual(
        result.afterFirst.map(({ subscription }) => subscription.workflow),
        [otherWorkflowId],
      );
      assert.strictEqual(result.closedAfterFirst, 0);
      assert.strictEqual(result.closedAfterSecond, 1);
      assert.deepStrictEqual(result.remaining, []);
    }),
  );

  it.effect("rolls back revision close when finishing the last admission fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-admissions-" });
      const storePath = path.join(directory, "control.db");
      const admission = { event, subscription, lineage } as const;
      const result = yield* exerciseFailedLastAdmissionFinish(storePath, admission);

      assert.strictEqual(result.failure._tag, "TriggerObservationStoreError");
      assert.deepStrictEqual(result.failedView.revision, { observed: event.revision, processed: null });
      assert.deepStrictEqual(result.pending, [admission]);
      assert.deepStrictEqual(result.completedView.revision, {
        observed: event.revision,
        processed: event.revision,
      });
      assert.deepStrictEqual(result.remaining, []);
    }),
  );

  it.effect("rolls back fan-out children when finishing the parent fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-admissions-" });
      const storePath = path.join(directory, "control.db");
      const parent = { event, subscription, lineage } as const;
      const child = {
        ...parent,
        event: {
          ...event,
          key: { ...event.key, instantMillis: event.key.instantMillis + 1 },
          revision: String(event.key.instantMillis + 1),
        },
      };
      const result = yield* exerciseFailedFanOutFinish(parent, child).pipe(
        Effect.provide(bootControlStoreLayer(storePath)),
      );

      assert.strictEqual(result.failure._tag, "TriggerObservationStoreError");
      assert.deepStrictEqual(result.pending, [parent]);
    }),
  );

  it.effect("persists admissions and skips time spent switched off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-observation-" });
      const storePath = path.join(directory, "control.db");
      const admission = {
        event,
        subscription,
        lineage,
      } as const;
      const useStore = <A, E, R>(
        use: (
          store: Effect.Success<typeof makeControlStoreTriggerObservationStore>,
        ) => Effect.Effect<A, E, R>,
      ) =>
        Effect.flatMap(makeControlStoreTriggerObservationStore, use).pipe(
          Effect.provide(bootControlStoreLayer(storePath)),
        );

      yield* useStore((store) =>
        store
          .activate([subscription], 1_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          ),
      );
      yield* useStore((store) =>
        store
          .activate([subscription], 2_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          ),
      );
      yield* useStore((store) =>
        store.activate([subscription], 3_000).pipe(
          Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          Effect.andThen(
            store.putAll([
              {
                ...admission,
                event: {
                  ...admission.event,
                  key: { ...admission.event.key, instantMillis: 1_500 },
                  revision: "1500",
                  atMillis: 1_500,
                },
              },
            ]),
          ),
        ),
      );
      yield* useStore((store) =>
        Effect.all([store.admissions, store.activate([subscription], 4_000)]).pipe(
          Effect.tap(([admissions, active]) =>
            Effect.sync(() => {
              assert.strictEqual(admissions[0]?.event.revision, "1500");
              assert.strictEqual(active[0]?.catchUp?.since, 1_500);
            }),
          ),
          Effect.andThen(store.activate([], 5_000)),
        ),
      );
      yield* useStore((store) =>
        store
          .activate([subscription], 6_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 6_000))),
          ),
      );
    }),
  );
});
