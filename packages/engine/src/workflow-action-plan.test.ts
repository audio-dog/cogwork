import {
  keyOf,
  type ParkReason,
  RunId,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { IssueTracker, IssueTrackerError, makeEmpty } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { engineTestLayer } from "./testing/engine-test-layer";
import {
  makeMemoryTriggerObservationStore,
  type TriggerAdmission,
  TriggerObservationStore,
} from "./trigger-observation";
import { executeWorkflowActionPlan } from "./workflow-action-plan";
import {
  WorkflowActionPlanStore,
  memoryLayer as workflowActionPlanStoreLayer,
} from "./workflow-action-plan-store";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
const decodeNode = Schema.decodeSync(WorkflowNodeId);
const decodeRun = Schema.decodeSync(RunId);
const decodeItem = Schema.decodeSync(WorkItemId);
const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const workflow = decodeWorkflow("issue-writes");
const operation = decodeNode("write");
const trigger = decodeNode("issue-changed");
const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "repo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
  }),
};
const item = decodeItem("#811");
const linearConfig = Schema.decodeSync(WorkspaceConfig)({
  name: "linear",
  checkoutPath: "/linear",
  issueTracker: { type: "linear", teams: ["CGW"] },
});
const ref = { _tag: "Issue", workspace: workspace.config.name, id: item } as const;
const admission: TriggerAdmission = {
  event: {
    key: ref,
    revision: "1",
    cause: { _tag: "Unknown" },
    atMillis: 1,
    entry: decodeEntry("github.issue-changed"),
    workspace: workspace.config.name,
  },
  subscription: {
    workflow,
    trigger,
    operation,
    entry: decodeEntry("github.issue-changed"),
    parameters: [],
    workspaces: [workspace.config.name],
    catchUp: { since: 0 },
  },
  lineage: {
    root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))(keyOf(ref)),
    parent: null,
    hop: 0,
  },
};

const plan = (steps: ReadonlyArray<WorkflowActionPlanStep>) =>
  WorkflowActionPlan.make({
    item: keyOf(ref),
    workflow,
    attempt: decodeRun("plan-attempt"),
    operation,
    revision: "1",
    createdAtMillis: 10,
    consumedHandbackAtMillis: 0,
    digest: "plan-digest",
    summary: "write",
    answers: {},
    handOff: null,
    steps,
  });

const step = (position: number, entry: string, comment = "") =>
  WorkflowActionPlanStep.make({
    position,
    entry: decodeEntry(entry),
    parameters: [],
    inputs: comment === "" ? {} : { comment },
    target: {
      _tag: "CurrentIssue",
      workspace: workspace.config.name,
      app: workspace.config.issueTracker.type,
      issueTracker: workspace.config.issueTracker,
      repository: null,
      issue: item,
    },
    writeKey: `write-${position}`,
    status: "pending",
    failures: 0,
    artifact: null,
  });

class ActionPlanProbe extends Context.Service<
  ActionPlanProbe,
  {
    readonly calls: Ref.Ref<ReadonlyArray<string>>;
    readonly barrier: Ref.Ref<number>;
    readonly parks: Ref.Ref<ReadonlyArray<ParkReason>>;
  }
>()("@cogwork/engine/workflow-action-plan.test/ActionPlanProbe") {
  static readonly layer = Layer.effect(
    ActionPlanProbe,
    Effect.all({
      calls: Ref.make<ReadonlyArray<string>>([]),
      barrier: Ref.make(0),
      parks: Ref.make<ReadonlyArray<ParkReason>>([]),
    }),
  );
}

const viewAt = (barrierAtMillis: number) => ({
  ...fold({ claim: null, attempts: [], handbacks: [], parks: [], revision: null }, "cogwork"),
  barrierAtMillis,
});

const coordinationLayer = Layer.effect(
  Coordination,
  Effect.map(
    ActionPlanProbe,
    (probe) =>
      ({
        fold,
        read: () => Ref.get(probe.barrier).pipe(Effect.map(viewAt)),
        claim: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
        recordAttempt: () => Effect.die("unused"),
        park: (_ref, reason) =>
          Ref.update(probe.parks, (current) => [...current, reason]).pipe(
            Effect.andThen(Ref.get(probe.barrier)),
            Effect.map(viewAt),
          ),
        handBack: () =>
          Ref.update(probe.barrier, (current) => current + 100).pipe(
            Effect.andThen(Ref.get(probe.barrier)),
            Effect.map(viewAt),
          ),
        observe: () => Effect.die("unused"),
        markProcessed: () => Effect.void,
      }) satisfies CoordinationService,
  ),
);

const trackerFailures = new Map<string, () => Effect.Effect<void, IssueTrackerError>>([
  [
    "retry",
    () => Effect.fail(new IssueTrackerError({ reason: "unavailable", retryable: true, message: "retry" })),
  ],
  [
    "fail",
    () =>
      Effect.fail(new IssueTrackerError({ reason: "unavailable", retryable: false, message: "permanent" })),
  ],
]);

const trackerResult = (body: string) => trackerFailures.get(body)?.() ?? Effect.void;

const trackerLayer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const probe = yield* ActionPlanProbe;
    const base = yield* makeEmpty;
    return {
      ...base,
      commentIssue: (_workspace, _item, body, writeKey) =>
        Ref.update(probe.calls, (current) => [...current, `${body}:${writeKey}`]).pipe(
          Effect.andThen(trackerResult(body)),
        ),
      addLabels: (_workspace, _item, labels, writeKey) =>
        Ref.update(probe.calls, (current) => [...current, `${labels.join(",")}:${writeKey}`]),
      closeIssue: (_workspace, _item, writeKey) =>
        Ref.update(probe.calls, (current) => [...current, `close:${writeKey}`]),
    };
  }),
);

const adapterLayers = Layer.merge(coordinationLayer, trackerLayer).pipe(
  Layer.provideMerge(ActionPlanProbe.layer),
);

const triggerObservationStoreLayer = Layer.effect(TriggerObservationStore, makeMemoryTriggerObservationStore);
const requirements = Layer.mergeAll(
  engineTestLayer(),
  workflowActionPlanStoreLayer,
  triggerObservationStoreLayer,
  adapterLayers,
);

describe("Workflow action plan", () => {
  it.effect("withdraws the pending approval for this item", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowActionPlanStore;
      const observationStore = yield* TriggerObservationStore;
      const waiting = WorkflowActionPlan.make({
        ...plan([step(0, "cogwork.wait-for-approval")]),
        attempt: decodeRun("waiting-attempt"),
      });
      const withdrawing = plan([step(0, "cogwork.withdraw-pending-approval")]);
      yield* store.create(waiting);
      yield* store.create(withdrawing);
      yield* observationStore.putAll([admission]);

      const result = yield* executeWorkflowActionPlan(withdrawing, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.isEmpty(yield* store.list);
      assert.isEmpty(yield* observationStore.admissions);
    }).pipe(Effect.provide(requirements)),
  );

  it.effect("a completed stop clears the hand-off", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowActionPlanStore;
      const initial = WorkflowActionPlan.make({
        ...plan([step(0, "cogwork.stop")]),
        handOff: decodeNode("next"),
      });
      yield* store.create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
    }).pipe(Effect.provide(requirements)),
  );

  it.effect("parks the third retryable write failure with one stable write key", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([step(0, "github.comment-this-item", "retry")]);
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, admission);
      const afterFirst = yield* store.pending(initial.item, initial.workflow);
      const second = yield* executeWorkflowActionPlan(afterFirst ?? initial, admission);
      const afterSecond = yield* store.pending(initial.item, initial.workflow);
      const third = yield* executeWorkflowActionPlan(afterSecond ?? initial, admission);
      const saved = yield* store.pending(initial.item, initial.workflow);

      assert.strictEqual(first._tag, "Retry");
      assert.strictEqual(second._tag, "Retry");
      assert.strictEqual(third._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "retry:write-0",
        "retry:write-0",
        "retry:write-0",
      ]);
      assert.deepInclude(saved?.steps[0], { status: "failed", failures: 3 });
      assert.deepInclude((yield* Ref.get(probe.parks))[0], {
        _tag: "WriteFailed",
        step: "github.comment-this-item",
        error: "retry",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("a handback skips completed and failed writes, then runs the rest in order", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([
        step(0, "github.comment-this-item", "first"),
        step(1, "github.comment-this-item", "fail"),
        step(2, "github.close-this-issue"),
      ]);
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const parked = yield* executeWorkflowActionPlan(initial, admission);
      const saved = yield* store.pending(initial.item, initial.workflow);
      const stillParked = yield* executeWorkflowActionPlan(saved ?? initial, admission);
      const callsBeforeHandback = yield* Ref.get(probe.calls);
      yield* (yield* Coordination).handBack(admission.event.key, { by: "Taylor" });
      const completed = yield* executeWorkflowActionPlan(saved ?? initial, admission);

      assert.strictEqual(parked._tag, "Parked");
      assert.strictEqual(stillParked._tag, "Parked");
      assert.deepStrictEqual(callsBeforeHandback, ["first:write-0", "fail:write-1"]);
      assert.strictEqual(completed._tag, "Complete");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["first:write-0", "fail:write-1", "close:write-2"]);
      assert.isNull(yield* store.pending(initial.item, initial.workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("preserves retry budget until resumed writes park again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([
        step(0, "github.comment-this-item", "fail"),
        step(1, "github.comment-this-item", "retry"),
      ]);
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, admission);
      const firstSaved = yield* store.pending(initial.item, initial.workflow);
      yield* (yield* Coordination).handBack(admission.event.key, { by: "Taylor" });
      const firstRetry = yield* executeWorkflowActionPlan(firstSaved ?? initial, admission);
      const firstRetrySaved = yield* store.pending(initial.item, initial.workflow);
      const secondRetry = yield* executeWorkflowActionPlan(firstRetrySaved ?? initial, admission);
      const secondRetrySaved = yield* store.pending(initial.item, initial.workflow);
      const parkedAgain = yield* executeWorkflowActionPlan(secondRetrySaved ?? initial, admission);
      const parkedAgainSaved = yield* store.pending(initial.item, initial.workflow);
      const staleResume = yield* executeWorkflowActionPlan(parkedAgainSaved ?? initial, admission);

      assert.strictEqual(first._tag, "Parked");
      assert.strictEqual(firstRetry._tag, "Retry");
      assert.strictEqual(secondRetry._tag, "Retry");
      assert.strictEqual(parkedAgain._tag, "Parked");
      assert.strictEqual(staleResume._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "fail:write-0",
        "retry:write-1",
        "retry:write-1",
        "retry:write-1",
      ]);
      assert.isNotNull(yield* store.pending(initial.item, initial.workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks before every write when the plan has no recognized Workspace", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const missingWorkspace = WorkflowActionPlanStep.make({
        ...step(1, "github.close-this-issue"),
        target: { _tag: "NoWorkspace" },
      });
      const initial = plan([step(0, "github.comment-this-item", "first"), missingWorkspace]);
      yield* (yield* WorkflowActionPlanStore).create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.strictEqual(result._tag, "Parked");
      assert.isEmpty(yield* Ref.get(probe.calls));
      assert.deepInclude((yield* Ref.get(probe.parks))[0], {
        _tag: "NoWorkspaceRecognized",
        plan: initial.digest,
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses an action whose frozen app does not match its entry", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const mismatched = WorkflowActionPlanStep.make({
        ...step(0, "github.close-this-issue"),
        target: {
          _tag: "CurrentIssue",
          workspace: linearConfig.name,
          app: linearConfig.issueTracker.type,
          issueTracker: linearConfig.issueTracker,
          repository: null,
          issue: item,
        },
      });
      const initial = plan([mismatched]);
      yield* (yield* WorkflowActionPlanStore).create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.strictEqual(result._tag, "Parked");
      assert.isEmpty(yield* Ref.get(probe.calls));
      assert.strictEqual((yield* Ref.get(probe.parks))[0]?._tag, "WriteFailed");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks add-label with no labels before writing", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([step(0, "github.add-label")]);
      yield* (yield* WorkflowActionPlanStore).create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.strictEqual(result._tag, "Parked");
      assert.isEmpty(yield* Ref.get(probe.calls));
      assert.deepInclude((yield* Ref.get(probe.parks))[0], {
        _tag: "WriteFailed",
        step: "github.add-label",
        error: "Action github.add-label has an invalid target",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
