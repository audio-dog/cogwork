import { DaemonEvent, DaemonRpcs, keyOf, WorkflowActionPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { crashedIssue, issueRun, testLayer } from "./daemon-composition-fixtures";
import * as RunLedger from "./run-ledger";
import { RunRecorder } from "./run-recorder";

const actionPlanCodec = Schema.fromJsonString(WorkflowActionPlan);
const actionPlan = Schema.decodeSync(actionPlanCodec)(
  JSON.stringify({
    item: keyOf(crashedIssue),
    workflow: "coding",
    attempt: "action-plan",
    operation: "implement",
    revision: "1",
    createdAtMillis: 1,
    digest: "plan-digest",
    summary: "Ready for review",
    answers: {},
    lineage: { root: keyOf(crashedIssue), parent: null, hop: 0 },
    handOff: null,
    steps: [],
  }),
);
const actionPlanRaw = Schema.encodeSync(actionPlanCodec)(actionPlan);
const actionPlanJson = Schema.encodeSync(Schema.toCodecJson(WorkflowActionPlan))(actionPlan);

const actionPlanEvent = {
  type: "CUSTOM",
  name: "workflow.action-plan",
  value: { object: actionPlan, raw: actionPlanRaw },
} as const;

describe("daemon composition WatchEvents", () => {
  it.effect("delivers a recorded Action plan to a WatchEvents subscriber without failing its stream", () =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient.make(DaemonRpcs);
      const run = issueRun("action-plan", "running", 1);
      yield* (yield* RunLedger.RunLedger).insertRun(run);
      const seeded = yield* Deferred.make<void>();
      const watcher = yield* rpc.WatchEvents().pipe(
        Stream.tap((event) =>
          Effect.when(Deferred.succeed(seeded, undefined), Effect.succeed(DaemonEvent.guards.SeedEnd(event))),
        ),
        Stream.filter(DaemonEvent.guards.RunActivity),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Deferred.await(seeded);

      yield* (yield* RunRecorder).record(run, actionPlanEvent);

      const delivered = yield* Fiber.join(watcher);
      assert.deepStrictEqual(
        delivered.pipe(Option.map(({ activity }) => activity.event)),
        Option.some({ ...actionPlanEvent, value: { object: actionPlanJson, raw: actionPlanRaw } }),
      );
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );
});
