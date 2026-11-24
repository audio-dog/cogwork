import { RunLedger } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  bootedLedgerLayer,
  crashItem,
  LedgerLogProbe,
  record,
  runId,
  TestStorePath,
  workspace,
} from "./ledger-fixtures";

describe("sqlite RunLedger", () => {
  layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-ledger-" });
      const storePath = path.join(dir, "control.db");
      return Layer.mergeAll(
        bootedLedgerLayer(storePath),
        Layer.succeed(TestStorePath, storePath),
        LedgerLogProbe.captureLayer,
      );
    }).pipe(Layer.unwrap, Layer.provide(NodeServices.layer)),
  )((it) => {
    it.effect("interrupts runs this daemon started and leaves older or finished ones alone", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertRun(record("interrupt-stale", 3900));
        yield* ledger.insertRun(record("interrupt-running", 4000));
        yield* ledger.insertRun(record("interrupt-done", 4100));
        yield* ledger.updateRun(runId("interrupt-done"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 4200,
        });

        yield* ledger.interruptRunning(4000, 5000);

        const statuses = yield* Effect.forEach(
          ["interrupt-stale", "interrupt-running", "interrupt-done"],
          (id) => Effect.map(ledger.getRun(runId(id)), (run) => [run?.status, run?.endedAtMillis]),
        );
        assert.deepStrictEqual(statuses, [
          ["running", null],
          ["interrupted", 5000],
          ["succeeded", 4200],
        ]);
      }),
    );

    it.effect("interrupts runs left running before a cutoff and spares later ones", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertRun(record("before-orphan", 3900));
        yield* ledger.insertRun(record("before-fresh", 4100));
        yield* ledger.insertRun(record("before-done", 3800));
        yield* ledger.updateRun(runId("before-done"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 3850,
        });

        yield* ledger.interruptRunningBefore(4000, 5000);

        const statuses = yield* Effect.forEach(["before-orphan", "before-fresh", "before-done"], (id) =>
          Effect.map(ledger.getRun(runId(id)), (run) => [run?.status, run?.endedAtMillis]),
        );
        assert.deepStrictEqual(statuses, [
          ["interrupted", 5000],
          ["running", null],
          ["succeeded", 3850],
        ]);
      }),
    );

    it.effect("keeps a settled Run's status and end time when asked to change them", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const logs = yield* LedgerLogProbe;
        yield* ledger.insertRun(record("settled", 1000, { status: "crashed", endedAtMillis: 2000 }));
        const before = (yield* logs.entries).length;

        yield* ledger.updateRun(runId("settled"), { status: "succeeded", usage: null, endedAtMillis: 3000 });

        assert.deepInclude(yield* ledger.getRun(runId("settled")), {
          status: "crashed",
          endedAtMillis: 2000,
        });
        assert.deepStrictEqual((yield* logs.entries).slice(before), [
          ["refused a status change to a Run that is not running", { requested: "succeeded" }],
        ]);
      }),
    );

    it.effect("crashes the item's running runs and counts crashes until a success resets them", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertRun(record("crash-c1", 1000, { workItem: crashItem, status: "crashed" }));
        yield* ledger.insertRun(record("crash-running", 2000, { workItem: crashItem }));
        yield* ledger.crashRunning(workspace, crashItem, 2500);

        assert.strictEqual((yield* ledger.getRun(runId("crash-running")))?.status, "crashed");
        assert.strictEqual(yield* ledger.consecutiveCrashes(workspace, crashItem, 0), 2);
        assert.strictEqual(yield* ledger.consecutiveCrashes(workspace, crashItem, 1500), 1);

        yield* ledger.insertRun(record("crash-ok", 3000, { workItem: crashItem, status: "succeeded" }));
        assert.strictEqual(yield* ledger.consecutiveCrashes(workspace, crashItem, 0), 0);
      }),
    );
  });
});
