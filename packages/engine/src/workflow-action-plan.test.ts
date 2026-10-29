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
import { readOnlyRegistry, WorkspaceRegistry } from "./registry";
import { engineTestLayer } from "./testing/engine-test-layer";
import type { TriggerAdmission } from "./trigger-observation";
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
    target: { _tag: "CurrentIssue", workspace: workspace.config.name, issue: item },
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
        handBack: () => Effect.die("unused"),
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
      closeIssue: (_workspace, _item, writeKey) =>
        Ref.update(probe.calls, (current) => [...current, `close:${writeKey}`]),
    };
  }),
);

const adapterLayers = Layer.merge(coordinationLayer, trackerLayer).pipe(
  Layer.provideMerge(ActionPlanProbe.layer),
);

const requirements = Layer.mergeAll(
  engineTestLayer(),
  workflowActionPlanStoreLayer,
  adapterLayers,
  Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces: [workspace], failures: [] })),
);

describe("Workflow action plan", () => {
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
      yield* Ref.set(probe.barrier, initial.createdAtMillis + 1);
      const completed = yield* executeWorkflowActionPlan(saved ?? initial, admission);

      assert.strictEqual(parked._tag, "Parked");
      assert.strictEqual(completed._tag, "Complete");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["first:write-0", "fail:write-1", "close:write-2"]);
      assert.isNull(yield* store.pending(initial.item, initial.workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
