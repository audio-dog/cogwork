import {
  type RunId,
  RunId as RunIdSchema,
  type WorkItemId,
  WorkItemId as WorkItemIdSchema,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  formatDaemonLimits,
  limitsCommand,
  resolveTarget,
  schedulingActions,
  schedulingCommand,
} from "./commands";

const runId = Schema.decodeSync(RunIdSchema);
const workItemId = Schema.decodeSync(WorkItemIdSchema);

const constResolver = (result: RunId | null) => () => Effect.succeed(result);

describe("resolveTarget", () => {
  it.effect("uses an explicit run id and never resolves a work item", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const resolve = () => Ref.update(calls, (n) => n + 1).pipe(Effect.as<RunId | null>(null));
      const target = yield* resolveTarget(resolve, Option.some("run-42"), Option.some("#7"));
      assert.deepStrictEqual(Option.getOrNull(target), { id: runId("run-42") });
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );

  it.effect("resolves to none when neither id nor work item is given", () =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(constResolver(null), Option.none(), Option.none());
      assert.isTrue(Option.isNone(target));
    }),
  );

  it.effect("maps a resolved work item to its run id and forwards the raw form", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<WorkItemId>>([]);
      const resolve = (workItem: WorkItemId) =>
        Ref.update(seen, (items) => [...items, workItem]).pipe(Effect.as<RunId | null>(runId("run-9")));
      const target = yield* resolveTarget(resolve, Option.none(), Option.some("7"));
      assert.deepStrictEqual(Option.getOrNull(target), { id: runId("run-9") });
      assert.deepStrictEqual(yield* Ref.get(seen), [workItemId("7")]);
    }),
  );

  it.effect("resolves to none when the work item has no run", () =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(constResolver(null), Option.none(), Option.some("#7"));
      assert.isTrue(Option.isNone(target));
    }),
  );
});

describe("limits", () => {
  it("formats the durable rows in their store order", () => {
    assert.strictEqual(
      formatDaemonLimits({
        daemonLimits: {
          globalConcurrency: 8,
          perWorkspaceConcurrency: 3,
          dailyBudget: 20,
          revision: 2,
        },
      }),
      "global-concurrency: 8\nper-workspace-concurrency: 3\ndaily-budget: 20",
    );
    assert.isDefined(limitsCommand);
  });
});

describe("scheduling", () => {
  it("exposes pause and resume actions for the daemon scheduler", () => {
    assert.deepStrictEqual(schedulingActions, { pause: "paused", resume: "running" });
    assert.isDefined(schedulingCommand);
  });
});
