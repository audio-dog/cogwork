import {
  HarnessName,
  keyOf,
  LineageId,
  localOwnerId,
  RunId,
  WorkflowActionPlan,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { layer as daemonEventBusLayer } from "./daemon-event-bus";
import { RunLedger, layerMemory as runLedgerLayer } from "./run-ledger";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation-store";
import { Workflows, type WorkflowsService } from "./workflow";
import {
  WorkflowActionPlanStore,
  memoryLayer as workflowActionPlanStoreLayer,
} from "./workflow-action-plan-store";
import { make } from "./workflow-attention";

const workflow = Schema.decodeSync(WorkflowId)("touchpoints");
const trigger = Schema.decodeSync(WorkflowNodeId)("issue-changed");
const operation = Schema.decodeSync(WorkflowNodeId)("review");
const entry = Schema.decodeSync(WorkflowCatalogKey)("github.issue-changed");
const workspace = Schema.decodeSync(WorkspaceId)("cogwork");
const item = Schema.decodeSync(WorkItemId)("#814");
const attempt = Schema.decodeSync(RunId)("run-814");
const ref = { _tag: "Issue", workspace, id: item } as const;
const forgottenRef = { ...ref, id: Schema.decodeSync(WorkItemId)("#815") };
const parentRun = {
  id: Schema.decodeSync(RunId)("run-parent"),
  workspace,
  workItem: item,
  workflow,
  operation: "implement",
  harness: Schema.decodeSync(HarnessName)("codex"),
  branch: null,
  session: null,
  usage: null,
  status: "succeeded",
  startedAtMillis: 1_700_000_000_000,
  endedAtMillis: 1_700_000_060_000,
} as const;
const document = Schema.decodeSync(WorkflowDocument)({
  name: "Touchpoints",
  workspaces: { _tag: "Every" },
  triggers: [],
  operations: [],
});
const admission = (
  revision: string,
  atMillis: number,
  key: typeof ref = ref,
  parent: string | null = null,
): TriggerAdmission => ({
  event: {
    key,
    revision,
    cause: { _tag: "Unknown" },
    atMillis,
    entry,
    workspace,
  },
  subscription: {
    workflow,
    trigger,
    operation,
    entry,
    parameters: [],
    filters: [],
    workspaces: [workspace],
    catchUp: { since: 0 },
  },
  lineage: {
    root: LineageId.make(keyOf(key)),
    parent: parent === null ? null : LineageId.make(parent),
    hop: parent === null ? 0 : 1,
  },
});

const coordinationView = fold(
  {
    claim: null,
    attempts: [],
    handbacks: [],
    parks: [{ reason: { _tag: "Stuck", summary: "Needs a decision" }, atMillis: 2 }],
    revision: { observed: "2", processed: null },
  },
  "cogwork",
);
const coordinationLayer = Layer.succeed(Coordination, {
  fold,
  read: () => Effect.succeed(coordinationView),
  claim: () => Effect.die("unused"),
  release: () => Effect.die("unused"),
  recordAttempt: () => Effect.die("unused"),
  park: () => Effect.die("unused"),
  handBack: () => Effect.die("unused"),
  observe: () => Effect.die("unused"),
  markProcessed: () => Effect.die("unused"),
} satisfies CoordinationService);
const workflowService = {
  create: () => Effect.die("unused"),
  edit: () => Effect.die("unused"),
  publish: () => Effect.die("unused"),
  switch: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: Effect.succeed({
    workflows: [
      {
        id: workflow,
        principal: localOwnerId,
        workingCopy: document,
        workingRevision: 3,
        publishedCopy: document,
        publishedRevision: 3,
        enabled: true,
        diagnostics: [],
        readiness: [],
      },
    ],
    unreadable: [],
  }),
  get: () => Effect.die("unused"),
  validate: () => Effect.succeed([]),
  catalog: Effect.succeed({
    catalog: { entries: [], instructionPackages: [], harnesses: [] },
    machine: {
      workspaces: [],
      connections: [],
      harnesses: [],
      defaultHarness: Schema.decodeSync(HarnessName)("codex"),
      readyNeeds: [],
    },
  }),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
} satisfies WorkflowsService;
const observationLayer = Layer.effect(TriggerObservationStore, makeMemoryTriggerObservationStore);
const requirements = Layer.mergeAll(
  coordinationLayer,
  observationLayer,
  workflowActionPlanStoreLayer,
  Layer.succeed(Workflows, workflowService),
  runLedgerLayer.pipe(Layer.provide(daemonEventBusLayer)),
);

it.effect("lists an item that no longer matched its Trigger as a skipped event", () =>
  Effect.gen(function* () {
    const observationStore = yield* TriggerObservationStore;
    const skipped = {
      ...admission("0", 0),
      event: {
        ...admission("0", 0).event,
        payload: { _tag: "NoLongerMatches", reason: "#7 is closed" } as const,
      },
    };
    yield* observationStore.putAll([skipped]);
    yield* observationStore.complete(skipped, Effect.void);

    const result = yield* (yield* make).list;

    assert.deepStrictEqual(result.skipped, [
      { workflow, steps: [], events: [{ summary: entry, reason: "#7 is closed", atMillis: 0 }] },
    ]);
  }).pipe(Effect.provide(requirements)),
);

it.effect("lists one parked item and marks a later source revision", () =>
  Effect.gen(function* () {
    const observationStore = yield* TriggerObservationStore;
    const rejected = {
      ...admission("0", 0),
      event: {
        ...admission("0", 0).event,
        payload: { _tag: "GranolaNoteRejected", reason: "Granola note has no transcript" } as const,
      },
    };
    yield* observationStore.putAll([rejected]);
    yield* observationStore.complete(rejected, Effect.void);
    yield* observationStore.putAll([admission("1", 1), admission("2", 3)]);
    const frozenPlan = WorkflowActionPlan.make({
      item: keyOf(ref),
      workflow,
      attempt,
      operation,
      revision: "1",
      createdAtMillis: 1,
      consumedHandbackAtMillis: 0,
      digest: "plan-digest",
      workflowRevision: 3,
      summary: "Needs a decision",
      answers: {},
      inputs: {},
      workspace,
      lineage: admission("1", 1).lineage,
      handOff: null,
      steps: [],
    });
    yield* (yield* WorkflowActionPlanStore).create(frozenPlan);

    const attention = yield* make;
    const result = yield* attention.list;

    assert.lengthOf(result.parks, 1);
    assert.deepStrictEqual(result.parks[0], {
      item: ref,
      workflow,
      publishedRevision: 3,
      operation,
      lineage: admission("1", 1).lineage,
      parentRun: null,
      summary: "Needs a decision",
      changedSinceParked: true,
      commands: ["hand-back"],
      reason: { _tag: "Stuck", summary: "Needs a decision" },
      attempt: frozenPlan.attempt,
      parkedAtMillis: 2,
      plan: frozenPlan,
    });
    assert.deepStrictEqual(result.skipped, [
      {
        workflow,
        steps: [],
        events: [{ summary: entry, reason: "Granola note has no transcript", atMillis: 0 }],
      },
    ]);
  }).pipe(Effect.provide(requirements)),
);

it.effect(
  "labels a parked item's parent Run from the Run ledger, and leaves it null once the ledger has no row",
  () =>
    Effect.gen(function* () {
      yield* (yield* RunLedger).insertRun(parentRun);
      yield* (yield* TriggerObservationStore).putAll([
        admission("1", 1, ref, "run-parent"),
        admission("1", 2, forgottenRef, "run-pruned"),
      ]);

      const result = yield* (yield* make).list;

      assert.deepStrictEqual(
        result.parks.map((park) => [keyOf(park.item), park.parentRun]),
        [
          [keyOf(ref), { operation: "implement", startedAtMillis: 1_700_000_000_000 }],
          [keyOf(forgottenRef), null],
        ],
      );
    }).pipe(Effect.provide(requirements)),
);
