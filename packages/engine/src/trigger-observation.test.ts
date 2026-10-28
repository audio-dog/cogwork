import {
  localOwnerId,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { clockEntries } from "./clock-source";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { makeScriptedSource } from "./scripted-source";
import { make, matchTriggerEvent } from "./trigger-observation";
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

const subscription: TriggerSubscription = {
  workflow: workflowId,
  trigger: triggerId,
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

const coordinationService = (processed: Ref.Ref<string | null>): CoordinationService => ({
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
  observe: () => Effect.succeed("moved"),
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
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed)),
        Effect.provideService(TriggerSources, [scripted.source]),
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
      assert.lengthOf(yield* scripted.subscriptions, 1);

      yield* Ref.set(current, record(false));
      yield* observation.refresh;

      assert.deepStrictEqual(yield* observation.eligible, []);
      assert.deepStrictEqual(yield* scripted.subscriptions, []);
    }).pipe(Effect.scoped),
  );
});
