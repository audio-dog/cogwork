import {
  HarnessName,
  keyOf,
  LineageId,
  localOwnerId,
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
import {
  makeMemoryTriggerObservationStore,
  type TriggerAdmission,
  TriggerObservationStore,
} from "./trigger-observation";
import { Workflows, type WorkflowsService } from "./workflow";
import { memoryLayer as workflowActionPlanStoreLayer } from "./workflow-action-plan-store";
import { make } from "./workflow-attention";

const workflow = Schema.decodeSync(WorkflowId)("touchpoints");
const trigger = Schema.decodeSync(WorkflowNodeId)("issue-changed");
const operation = Schema.decodeSync(WorkflowNodeId)("review");
const entry = Schema.decodeSync(WorkflowCatalogKey)("github.issue-changed");
const workspace = Schema.decodeSync(WorkspaceId)("cogwork");
const item = Schema.decodeSync(WorkItemId)("#814");
const ref = { _tag: "Issue", workspace, id: item } as const;
const document = Schema.decodeSync(WorkflowDocument)({
  name: "Touchpoints",
  workspaces: { _tag: "Every" },
  triggers: [],
  operations: [],
});
const admission = (revision: string, atMillis: number): TriggerAdmission => ({
  event: {
    key: ref,
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
    workspaces: [workspace],
    catchUp: { since: 0 },
  },
  lineage: { root: LineageId.make(keyOf(ref)), parent: null, hop: 0 },
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

    const attention = yield* make;
    const result = yield* attention.list;

    assert.lengthOf(result.parks, 1);
    assert.deepStrictEqual(result.parks[0], {
      item: ref,
      workflow,
      publishedRevision: 3,
      operation,
      lineage: admission("1", 1).lineage,
      summary: "Needs a decision",
      changedSinceParked: true,
      commands: ["hand-back"],
      reason: { _tag: "Stuck", summary: "Needs a decision" },
      attempt: null,
    });
    assert.deepStrictEqual(result.skipped, [
      {
        workflow,
        steps: [],
        events: [{ summary: entry, reason: "Granola note has no transcript" }],
      },
    ]);
  }).pipe(Effect.provide(requirements)),
);
