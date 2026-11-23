import { WorkItemId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RunLedger } from "./run-ledger";
import { bareWorkItem, layerMemory, record, workItem } from "./run-ledger-fixtures";

describe("RunLedger resolveWatchTarget (memory)", () => {
  const otherItem = Schema.decodeSync(WorkItemId)("#999");
  const targetId = (workItem: WorkItemId) =>
    Effect.flatMap(RunLedger, (ledger) => ledger.resolveWatchTarget(workItem)).pipe(
      Effect.map((run) => run?.id ?? null),
    );

  it.layer(layerMemory)((it) => {
    it.effect("prefers a running run over a more recent completed run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("running", 1000, { status: "running" }));
        yield* ledger.insertRun(record("newer-done", 5000, { status: "succeeded", endedAtMillis: 5500 }));
        assert.strictEqual(yield* targetId(workItem), "running");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("falls back to the most recent run when nothing is running", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("old-done", 1000, { status: "failed", endedAtMillis: 1500 }));
        yield* ledger.insertRun(record("new-done", 5000, { status: "succeeded", endedAtMillis: 5500 }));
        assert.strictEqual(yield* targetId(workItem), "new-done");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("finds the item's run even when 50+ other items have started more recently", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("target", 1000, { status: "succeeded", endedAtMillis: 1500 }));
        yield* Effect.forEach(
          Array.from({ length: 60 }, (_, index) => index),
          (index) =>
            ledger.insertRun(
              record(`other-${index}`, 2000 + index, {
                workItem: otherItem,
                status: "succeeded",
                endedAtMillis: 2001 + index,
              }),
            ),
        );
        assert.strictEqual(yield* targetId(workItem), "target");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("resolves the same run for the #-prefixed and bare forms", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("only", 1000, { status: "running" }));
        assert.strictEqual(yield* targetId(workItem), "only");
        assert.strictEqual(yield* targetId(bareWorkItem), "only");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("returns null when the item has never run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("other", 1000, { workItem: otherItem }));
        assert.isNull(yield* targetId(workItem));
      }),
    );
  });
});
