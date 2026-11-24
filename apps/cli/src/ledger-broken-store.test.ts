import { DatabaseSync } from "node:sqlite";

import { DaemonEventBus, RunLedger } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  bootedLedgerLayer,
  LedgerLogProbe,
  record,
  runId,
  session,
  TestStorePath,
  workItem,
  workspace,
} from "./ledger-fixtures";

describe("sqlite RunLedger against a broken store", () => {
  const dropTables = (storePath: string) =>
    Effect.acquireUseRelease(
      Effect.sync(() => new DatabaseSync(storePath)),
      (sqlite) =>
        Effect.sync(() =>
          sqlite.exec(
            "DROP TABLE IF EXISTS run_events; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS sessions",
          ),
        ),
      (sqlite) => Effect.sync(() => sqlite.close()),
    );

  layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-ledger-broken-" });
      const storePath = path.join(dir, "control.db");
      const core = bootedLedgerLayer(storePath);
      const published = RunLedger.publishingLayer.pipe(
        Layer.provide(core),
        Layer.provide(DaemonEventBus.layer),
      );
      return Layer.mergeAll(
        core,
        published,
        Layer.succeed(TestStorePath, storePath),
        LedgerLogProbe.captureLayer,
      );
    }).pipe(Layer.unwrap, Layer.provide(NodeServices.layer)),
  )((it) => {
    it.effect("fails when the event head cannot be read", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* dropTables(yield* TestStorePath);

        const error = yield* ledger.latestSeq(runId("broken-head")).pipe(Effect.flip);
        assert.strictEqual(error.operation, RunLedger.readRunEventsOperation);
      }),
    );

    it.effect("fails when a later event page cannot be read", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("broken-pages");
        const storePath = yield* TestStorePath;
        yield* ledger.insertRun(record(id, 1000));
        yield* Effect.forEach(
          Array.from({ length: 257 }, (_, seq) => seq),
          (seq) =>
            ledger.appendEvent(id, {
              seq,
              type: "CUSTOM",
              name: null,
              data: "{}",
              atMillis: 1001 + seq,
            }),
          { discard: true },
        );

        const error = yield* ledger.events(id).pipe(
          Stream.tap((item) => (item.seq === 0 ? dropTables(storePath) : Effect.void)),
          Stream.runCollect,
          Effect.flip,
        );
        assert.strictEqual(error.operation, RunLedger.readRunEventsOperation);
      }),
    );

    it.effect("does not log transitions for writes whose tables are gone", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        const logs = yield* LedgerLogProbe;
        yield* dropTables(yield* TestStorePath);
        const before = (yield* logs.entries).length;

        yield* ledger.insertRun(record("broken-1", 1000));
        yield* ledger.appendEvent(runId("broken-1"), {
          seq: 0,
          type: "RUN_STARTED",
          name: null,
          data: "{}",
          atMillis: 1000,
        });
        yield* ledger.updateRun(runId("broken-1"), {
          status: "failed",
          usage: null,
          endedAtMillis: 1001,
        });

        const transitionLogs = (yield* logs.entries)
          .slice(before)
          .filter((message) =>
            ["appended Run event", "settled Run"].some((transition) =>
              JSON.stringify(message).includes(transition),
            ),
          );
        assert.deepStrictEqual(transitionLogs, []);
      }),
    );

    it.effect("degrades non-event reads whose tables are gone to empty", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* dropTables(yield* TestStorePath);

        assert.deepStrictEqual(yield* ledger.listRuns(10), []);
        assert.deepStrictEqual(yield* ledger.runningRuns, []);
        assert.isNull(yield* ledger.getRun(runId("broken-1")));
        assert.isNull(yield* ledger.getSession(session));
        assert.strictEqual(yield* ledger.consecutiveCrashes(workspace, workItem, 0), 0);
      }),
    );
  });
});
