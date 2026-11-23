import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RunLedger } from "./run-ledger";
import {
  layerMemory,
  otherWorkItem,
  record,
  runId,
  session,
  workItem,
  workspace,
} from "./run-ledger-fixtures";
import { LogProbe } from "./testing/log-probe";

describe("RunLedger (memory)", () => {
  it.layer(Layer.merge(layerMemory, LogProbe.captureLayer))((it) => {
    it.effect("keeps a settled Run's status and end time when asked to change them", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const logs = yield* LogProbe;
        yield* ledger.insertRun(record("settled", 1000));
        yield* ledger.crashRunning(workspace, workItem, 2000);
        const before = (yield* logs.entries).length;

        yield* ledger.updateRun(runId("settled"), { status: "succeeded", usage: null, endedAtMillis: 3000 });

        assert.deepInclude(yield* ledger.getRun(runId("settled")), {
          status: "crashed",
          endedAtMillis: 2000,
        });
        assert.deepStrictEqual(
          (yield* logs.entries).slice(before).map(({ message }) => message),
          [["refused a status change to a Run that is not running", { requested: "succeeded" }]],
        );
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("marks only the item's running runs as crashed", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("crash-running", 4000));
        yield* ledger.insertRun(record("crash-done", 4100));
        yield* ledger.updateRun(runId("crash-done"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 4200,
        });

        yield* ledger.crashRunning(workspace, workItem, 5000);

        const statuses = yield* Effect.forEach(["crash-running", "crash-done"], (id) =>
          Effect.map(ledger.getRun(runId(id)), (run) => [run?.status, run?.endedAtMillis]),
        );
        assert.deepStrictEqual(statuses, [
          ["crashed", 5000],
          ["succeeded", 4200],
        ]);
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect(
      "closes only the item's running run as failed, stamping the end time and keeping the session",
      () =>
        Effect.gen(function* () {
          const ledger = yield* RunLedger;
          yield* ledger.insertRun(record("running", 4000, { session, usage: { inputTokens: 9 } }));
          yield* ledger.insertRun(record("other-running", 4050, { workItem: otherWorkItem }));
          yield* ledger.insertRun(record("done", 4100, { session }));
          yield* ledger.updateRun(runId("done"), {
            status: "succeeded",
            usage: null,
            endedAtMillis: 4200,
          });

          yield* ledger.closeRunning(workspace, workItem, 5000);

          const state = yield* Effect.forEach(["running", "other-running", "done"], (id) =>
            Effect.map(ledger.getRun(runId(id)), (run) => [
              run?.status,
              run?.endedAtMillis,
              run?.session,
              run?.usage,
            ]),
          );
          assert.deepStrictEqual(state, [
            ["failed", 5000, session, null],
            ["running", null, null, null],
            ["succeeded", 4200, session, null],
          ]);
        }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("counts consecutive crashes and resets the count after a success", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const crashes = () => ledger.consecutiveCrashes(workspace, workItem, 0);
        yield* ledger.insertRun(record("c1", 1000, { status: "crashed" }));
        yield* ledger.insertRun(record("c2", 2000, { status: "crashed" }));
        assert.strictEqual(yield* crashes(), 2);

        yield* ledger.insertRun(record("ok", 3000, { status: "succeeded" }));
        assert.strictEqual(yield* crashes(), 0);

        yield* ledger.insertRun(record("c3", 4000, { status: "crashed" }));
        assert.strictEqual(yield* crashes(), 1);
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("resets the crash streak on any completed run between crashes", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const crashes = () => ledger.consecutiveCrashes(workspace, workItem, 0);
        yield* ledger.insertRun(record("c1", 1000, { status: "crashed" }));
        yield* ledger.insertRun(record("failed", 2000, { status: "failed" }));
        yield* ledger.insertRun(record("c2", 3000, { status: "crashed" }));
        assert.strictEqual(yield* crashes(), 1);
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("counts only crashes from runs started after a handback", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("before", 1000, { status: "crashed" }));
        yield* ledger.insertRun(record("at-barrier", 2000, { status: "crashed" }));
        yield* ledger.insertRun(record("after", 3000, { status: "crashed" }));

        assert.strictEqual(yield* ledger.consecutiveCrashes(workspace, workItem, 2000), 1);
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("interrupts runs this daemon started and leaves older or finished ones alone", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("stale", 3900));
        yield* ledger.insertRun(record("in-flight", 4000));
        yield* ledger.insertRun(record("done", 4100));
        yield* ledger.updateRun(runId("done"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 4200,
        });

        yield* ledger.interruptRunning(4000, 5000);

        const statuses = yield* Effect.forEach(["stale", "in-flight", "done"], (id) =>
          Effect.map(ledger.getRun(runId(id)), (run) => [run?.status, run?.endedAtMillis]),
        );
        assert.deepStrictEqual(statuses, [
          ["running", null],
          ["interrupted", 5000],
          ["succeeded", 4200],
        ]);
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("interrupts runs left running by an earlier daemon and spares this daemon's own", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("orphan", 3900));
        yield* ledger.insertRun(record("fresh", 4100));
        yield* ledger.insertRun(record("done", 3800));
        yield* ledger.updateRun(runId("done"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 3850,
        });

        yield* ledger.interruptRunningBefore(4000, 5000);

        const statuses = yield* Effect.forEach(["orphan", "fresh", "done"], (id) =>
          Effect.map(ledger.getRun(runId(id)), (run) => [run?.status, run?.endedAtMillis]),
        );
        assert.deepStrictEqual(statuses, [
          ["interrupted", 5000],
          ["running", null],
          ["succeeded", 3850],
        ]);
      }),
    );
  });
});
