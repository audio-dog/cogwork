import { WorkflowActionPlan, WorkflowActionPlanStep, WorkflowCatalogKey } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { Coordination } from "./coordination";
import { TriggerObservationStore } from "./trigger-observation-store";
import { executeWorkflowActionPlan } from "./workflow-action-plan";
import {
  ActionPlanProbe,
  admission,
  decodeNode,
  decodeRun,
  failingArtifacts,
  item,
  linearConfig,
  plan,
  pullRequestWrites,
  requirements,
  sourceStep,
  step,
} from "./workflow-action-plan-fixtures";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";

describe("Workflow action plan", () => {
  it.effect("withdraws the pending approval for this item", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
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
      yield* executeWorkflowActionPlan(waiting, admission);

      const result = yield* executeWorkflowActionPlan(withdrawing, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.isEmpty(yield* store.list);
      assert.isEmpty(yield* observationStore.admissions);
      assert.strictEqual(yield* Ref.get(probe.barrier), 100);
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

  it.effect("scopes an approval park to the waiting Operation", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const waiting = plan([step(0, "cogwork.wait-for-approval")]);

      const result = yield* executeWorkflowActionPlan(waiting, admission);
      const [park] = yield* Ref.get(probe.parks);

      assert.strictEqual(result._tag, "AwaitingApproval");
      assert.deepStrictEqual(park?.operation, {
        workflow: waiting.workflow,
        operation: waiting.operation,
      });
    }).pipe(Effect.provide(requirements)),
  );

  it.effect.each([
    {
      failure: "tracker write",
      initial: plan([step(0, "github.comment-this-item", "retry")]),
      environment: requirements,
      error: "retry",
      writes: Effect.flatMap(ActionPlanProbe, (probe) => Ref.get(probe.calls)),
      expectedWrites: ["retry:write-0", "retry:write-0", "retry:write-0"],
    },
    {
      failure: "artifact record",
      initial: plan([sourceStep("github.push-to-this-pull-request")]),
      environment: pullRequestWrites({ artifacts: failingArtifacts }),
      error: "database is locked",
      writes: Effect.flatMap(ActionPlanProbe, (probe) => Ref.get(probe.pushOrigins)).pipe(
        Effect.map((origins) => origins.map(({ writeKey }) => writeKey)),
      ),
      expectedWrites: ["write-0", "write-0", "write-0"],
    },
  ])(
    "parks the third retryable $failure failure with one stable write key",
    ({ initial, environment, error, writes, expectedWrites }) =>
      Effect.gen(function* () {
        const probe = yield* ActionPlanProbe;
        const store = yield* WorkflowActionPlanStore;
        yield* store.create(initial);

        const first = yield* executeWorkflowActionPlan(initial, admission);
        const afterFirst = yield* store.pending(initial.item, initial.workflow);
        const second = yield* executeWorkflowActionPlan(afterFirst ?? initial, admission);
        const afterSecond = yield* store.pending(initial.item, initial.workflow);
        const third = yield* executeWorkflowActionPlan(afterSecond ?? initial, admission);
        const saved = yield* store.pending(initial.item, initial.workflow);

        assert.deepStrictEqual([first._tag, second._tag, third._tag], ["Retry", "Retry", "Parked"]);
        assert.deepStrictEqual(yield* writes, expectedWrites);
        assert.deepInclude(afterFirst?.steps[0], { status: "pending", failures: 1 });
        assert.deepInclude(saved?.steps[0], { status: "failed", failures: 3 });
        assert.deepInclude((yield* Ref.get(probe.parks))[0]?.reason, {
          _tag: "WriteFailed",
          step: initial.steps[0]?.entry,
          error,
        });
      }).pipe(Effect.provide(environment), Effect.scoped),
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
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["first:write-0", "fail:write-1", "close"]);
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
      const parked = (yield* Ref.get(probe.parks))[0]?.reason;

      assert.strictEqual(result._tag, "Parked");
      assert.isEmpty(yield* Ref.get(probe.calls));
      assert.strictEqual(parked?._tag, "NoWorkspaceRecognized");
      if (parked?._tag !== "NoWorkspaceRecognized") return;
      const parkedPlan = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            summary: Schema.String,
            steps: Schema.Array(Schema.Struct({ position: Schema.Finite, entry: WorkflowCatalogKey })),
          }),
        ),
      )(parked.plan);
      assert.deepStrictEqual(
        parkedPlan.steps.map(({ entry }) => entry),
        ["github.comment-this-item", "github.close-this-issue"],
      );
      assert.notInclude(parked.plan, "first");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses an action whose frozen app does not match its entry", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const mismatched = WorkflowActionPlanStep.make({
        ...step(0, "github.close-this-issue"),
        target: {
          _tag: "CurrentIssue",
          workspace: linearConfig.id,
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
      assert.strictEqual((yield* Ref.get(probe.parks))[0]?.reason._tag, "WriteFailed");
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
      assert.deepInclude((yield* Ref.get(probe.parks))[0]?.reason, {
        _tag: "WriteFailed",
        step: "github.add-label",
        error: "Action github.add-label has an invalid target",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
