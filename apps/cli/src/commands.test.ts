import {
  type RunId,
  RunId as RunIdSchema,
  type WorkItemId,
  WorkItemId as WorkItemIdSchema,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  formatDaemonLimits,
  formatOperationSettings,
  limitsCommand,
  makeOperationSettingUpdate,
  operationSettingsCommand,
  resolveTarget,
  schedulingActions,
  schedulingCommand,
} from "./commands";

const runId = Schema.decodeSync(RunIdSchema);
const workItemId = Schema.decodeSync(WorkItemIdSchema);
const workspaceId = Schema.decodeSync(WorkspaceId);

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
        operationSettings: [],
      }),
      "global-concurrency: 8\nper-workspace-concurrency: 3\ndaily-budget: 20",
    );
    assert.isDefined(limitsCommand);
  });
});

describe("operation settings", () => {
  it("renders effective values from raw rows with level before Scope", () => {
    assert.strictEqual(
      formatOperationSettings(
        {
          daemonLimits: {
            globalConcurrency: 4,
            perWorkspaceConcurrency: 4,
            dailyBudget: 50,
            revision: 0,
          },
          operationSettings: [
            {
              setting: "model",
              level: { _tag: "Default" },
              scope: { _tag: "SettingsProfile" },
              value: "profile-default",
            },
            {
              setting: "model",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
              value: "operation-model",
            },
          ],
        },
        { workflow: "coding", operation: "implement" },
      ),
      "enabled: unset\nharness: unset\nmodel: operation-model\neffort: unset\npermission-profile: unset\nbindings: unset",
    );
    assert.isDefined(operationSettingsCommand);
  });

  it.effect("maps the set form to a typed Operation setting row", () =>
    Effect.gen(function* () {
      const update = yield* makeOperationSettingUpdate(
        {
          setting: "enabled",
          scope: "overlay",
          level: "workflow",
          workflow: "coding",
          operation: "implement",
          workspace: Option.some("example"),
        },
        Option.some("off"),
      );

      assert.deepStrictEqual(update, {
        _tag: "Set",
        row: {
          setting: "enabled",
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspaceId("example") },
          level: { _tag: "Workflow", workflow: "coding" },
          value: false,
        },
      });
    }),
  );

  it.effect("maps the clear form to an Operation setting cell", () =>
    Effect.gen(function* () {
      const update = yield* makeOperationSettingUpdate(
        {
          setting: "harness",
          scope: "host",
          level: "default",
          workflow: "coding",
          operation: "implement",
          workspace: Option.none(),
        },
        Option.none(),
      );

      assert.deepStrictEqual(update, {
        _tag: "Clear",
        cell: {
          setting: "harness",
          scope: { _tag: "RuntimeHost" },
          level: { _tag: "Default" },
        },
      });
    }),
  );
});

describe("scheduling", () => {
  it("exposes pause and resume actions for the daemon scheduler", () => {
    assert.deepStrictEqual(schedulingActions, { pause: "paused", resume: "running" });
    assert.isDefined(schedulingCommand);
  });
});
