import {
  DaemonEvent,
  DaemonRpcs,
  keyOf,
  RunId,
  type RunRecord,
  WorkflowActionPlan,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { harnessName, testLayer } from "./daemon-composition-fixtures";
import * as RunLedger from "./run-ledger";
import { RunRecorder } from "./run-recorder";

const issue = {
  _tag: "Issue",
  workspace: WorkspaceId.make("github"),
  id: WorkItemId.make("#1"),
} as const;

const run = {
  id: RunId.make("action-plan"),
  workspace: issue.workspace,
  workItem: WorkItemId.make(keyOf(issue)),
  operation: "implement",
  harness: harnessName,
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis: 1,
  endedAtMillis: null,
} satisfies RunRecord;

const planJson = {
  item: keyOf(issue),
  workflow: "coding",
  attempt: "action-plan",
  operation: "implement",
  revision: "1",
  createdAtMillis: 1,
  consumedHandbackAtMillis: 0,
  digest: "plan-digest",
  workflowRevision: 0,
  summary: "Ready for review",
  answers: {},
  inputs: {},
  workspace: null,
  lineage: { root: keyOf(issue), parent: null, hop: 0 },
  handOff: null,
  steps: [],
};

const actionPlanEvent = {
  type: "CUSTOM",
  name: "workflow.action-plan",
  value: { object: Schema.decodeSync(Schema.toCodecJson(WorkflowActionPlan))(planJson), raw: "plan" },
} as const;

describe("daemon composition WatchEvents", () => {
  it.effect("delivers a recorded Action plan to a WatchEvents subscriber without failing its stream", () =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient.make(DaemonRpcs);
      yield* (yield* RunLedger.RunLedger).insertRun(run);
      const seeded = yield* Deferred.make<void>();
      const watcher = yield* rpc.WatchEvents().pipe(
        Stream.tap((event) =>
          DaemonEvent.guards.SeedEnd(event) ? Deferred.succeed(seeded, undefined) : Effect.void,
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
        Option.some({ ...actionPlanEvent, value: { object: planJson, raw: "plan" } }),
      );
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );
});
