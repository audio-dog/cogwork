import {
  keyOf,
  LineageId,
  localOwnerId,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { clockEntries } from "./clock-source";
import { bootControlStoreLayer } from "./control-store";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { makeScriptedSource } from "./scripted-source";
import {
  make,
  makeControlStoreTriggerObservationStore,
  makeMemoryTriggerObservationStore,
  matchTriggerEvent,
  TriggerObservationStore,
} from "./trigger-observation";
import { TriggerSources, type TriggerSubscription } from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";

const workflowId = Schema.decodeSync(WorkflowId)("daily-summary");
const triggerId = Schema.decodeSync(WorkflowNodeId)("schedule");
const entry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
const document = Schema.decodeSync(WorkflowDocument)({
  name: "Daily summary",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: [{ id: triggerId, entry, parameters: [], start: Schema.decodeSync(WorkflowNodeId)("summarize") }],
  operations: [],
});

const record = (enabled: boolean): WorkflowRecord => ({
  id: workflowId,
  principal: localOwnerId,
  workingCopy: document,
  workingRevision: 1,
  publishedCopy: document,
  publishedRevision: 1,
  enabled,
  diagnostics: [],
  readiness: [],
});

const workItem = { _tag: "ScheduleInstant", workflow: workflowId, instantMillis: 1_000 } as const;
const event = {
  key: workItem,
  revision: "1000",
  cause: { _tag: "Unknown" },
  atMillis: 1_000,
  entry,
  workspace: null,
} as const;
const lineage = { root: Schema.decodeSync(LineageId)(keyOf(workItem)), parent: null, hop: 0 } as const;

const subscription: TriggerSubscription = {
  workflow: workflowId,
  trigger: triggerId,
  operation: Schema.decodeSync(WorkflowNodeId)("summarize"),
  entry,
  parameters: [],
  workspaces: [],
  catchUp: { since: 0 },
};

const workflowService = (current: Ref.Ref<WorkflowRecord>): WorkflowsService => ({
  create: () => Effect.die("unused"),
  edit: () => Effect.die("unused"),
  publish: () => Effect.die("unused"),
  switch: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: Effect.map(Ref.get(current), (workflow) => ({ workflows: [workflow], unreadable: [] })),
  get: () => Effect.die("unused"),
  validate: () => Effect.succeed([]),
  catalog: Effect.die("unused"),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
});

const coordinationService = (
  processed: Ref.Ref<string | null>,
  observed: Ref.Ref<number>,
): CoordinationService => ({
  fold,
  read: () =>
    Effect.map(Ref.get(processed), (revision) =>
      fold(
        {
          claim: null,
          attempts: [],
          handbacks: [],
          parks: [],
          revision: { observed: event.revision, processed: revision },
        },
        "cogwork",
      ),
    ),
  claim: () => Effect.die("unused"),
  release: () => Effect.die("unused"),
  recordAttempt: () => Effect.die("unused"),
  park: () => Effect.die("unused"),
  handBack: () => Effect.die("unused"),
  observe: () => Ref.update(observed, (count) => count + 1).pipe(Effect.map(() => "moved" as const)),
  markProcessed: (_ref, revision) => Ref.set(processed, revision),
});

describe("TriggerObservation", () => {
  it("matches the schedule event only to its Workflow", () => {
    const other = { ...subscription, workflow: Schema.decodeSync(WorkflowId)("other") };

    assert.deepStrictEqual(matchTriggerEvent([subscription, other], event), [subscription]);
  });

  it.effect("admits once and stops the source after switch-off", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
      );
      yield* observation.refresh;
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* Fiber.join(changed);

      assert.lengthOf(yield* observation.eligible, 1);
      assert.strictEqual(yield* Ref.get(observed), 1);
      assert.lengthOf(yield* scripted.subscriptions, 1);

      yield* Ref.set(current, record(false));
      yield* observation.refresh;

      assert.deepStrictEqual(yield* observation.eligible, []);
      assert.deepStrictEqual(yield* scripted.subscriptions, []);
    }).pipe(Effect.scoped),
  );
});

layer(NodeServices.layer)((it) => {
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
        store.put(admission).pipe(
          Effect.andThen(store.activate([subscription], 1_000)),
          Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
        ),
      );
      yield* useStore((store) =>
        Effect.all([store.admissions, store.activate([subscription], 2_000)]).pipe(
          Effect.tap(([admissions, active]) =>
            Effect.sync(() => {
              assert.deepStrictEqual(admissions, [admission]);
              assert.strictEqual(active[0]?.catchUp?.since, 1_000);
            }),
          ),
          Effect.andThen(store.activate([], 3_000)),
        ),
      );
      yield* useStore((store) =>
        store
          .activate([subscription], 4_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 4_000))),
          ),
      );
    }),
  );
});
