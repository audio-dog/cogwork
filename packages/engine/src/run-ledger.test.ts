import type { BranchName, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { RunLedger, RunLedgerError, type RunLedgerService } from "./run-ledger";
import {
  layerMemory,
  otherWorkItem,
  record,
  recordLoggedTransitions,
  runId,
  runPlan,
  session,
  workItem,
  workspace,
} from "./run-ledger-fixtures";
import { LogProbe } from "./testing/log-probe";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _CrashRunningArgs = Expect<
  Equal<Parameters<RunLedgerService["crashRunning"]>, [WorkspaceId, WorkItemId, number]>
>;
type _CloseRunningArgs = Expect<
  Equal<Parameters<RunLedgerService["closeRunning"]>, [WorkspaceId, WorkItemId, number]>
>;
type _LatestRunForItemArgs = Expect<
  Equal<Parameters<RunLedgerService["latestRunForItem"]>, [WorkspaceId, WorkItemId]>
>;
type _LatestRunByBranchArgs = Expect<
  Equal<Parameters<RunLedgerService["latestRunByBranch"]>, [WorkspaceId, BranchName]>
>;
type _SessionForBranchArgs = Expect<
  Equal<Parameters<RunLedgerService["sessionForBranch"]>, [WorkspaceId, BranchName]>
>;
type _ResolveWatchTargetArgs = Expect<
  Equal<Parameters<RunLedgerService["resolveWatchTarget"]>, [WorkItemId]>
>;

describe("RunLedgerError", () => {
  it("rejects unsupported operations", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(RunLedgerError)({
        _tag: "RunLedgerError",
        operation: "unsupported",
        message: "failure",
        retryable: false,
      }),
    );
  });
});

describe("accepted Run Plan", () => {
  it.layer(layerMemory)((it) => {
    it.effect("accepts one immutable Plan with its Run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const accepted = runPlan("accepted");
        yield* ledger.acceptRun(record("accepted", 1000), accepted);

        assert.isTrue(Reflect.set(accepted.messages[0] ?? {}, "content", "changed after acceptance"));
        const stored = yield* ledger.getRunPlan(accepted.id);

        assert.strictEqual(stored?.messages[0]?.content, "Triage #7");
        assert.isTrue(Object.isFrozen(stored));
        assert.isTrue(Object.isFrozen(stored?.messages));
        const error = yield* Effect.flip(ledger.acceptRun(record("accepted", 2000), runPlan("accepted")));
        assert.strictEqual(error._tag, "RunLedgerError");
        assert.isFalse(error.retryable);
      }),
    );
  });

  it.layer(Layer.merge(layerMemory, LogProbe.captureLayer))((it) => {
    it.effect("logs accepted, appended, and settled Run transitions once", () => {
      const id = runId("logged-transitions");

      return Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const logs = yield* LogProbe;
        yield* recordLoggedTransitions(ledger, id).pipe(Effect.annotateLogs({ runId: id }));
        yield* ledger.insertRun(record("batch-first", 2001));
        yield* ledger.insertRun(record("batch-second", 2002));
        yield* ledger.interruptRunning(0, 3000).pipe(Effect.annotateLogs({ phase: "recovery" }));

        assert.deepStrictEqual(yield* logs.entries, [
          {
            annotations: { runId: id },
            message: ["accepted Run", { harness: "cursor", branch: null }],
          },
          {
            annotations: { runId: id },
            message: ["appended Run event", { seq: 0 }],
          },
          {
            annotations: { runId: id },
            message: ["settled Run", { status: "succeeded" }],
          },
          {
            annotations: { phase: "recovery" },
            message: ["settled Run", { status: "interrupted" }],
          },
          {
            annotations: { phase: "recovery" },
            message: ["settled Run", { status: "interrupted" }],
          },
        ]);
      });
    });
  });
});

describe("RunLedger (memory)", () => {
  it.layer(layerMemory)((it) => {
    it.effect("persists a run, its events, and reports summaries with an event count", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const id = runId("run-1");
        yield* ledger.insertRun(record("run-1", 1000, { session }));
        yield* ledger.appendEvent(id, {
          seq: 0,
          type: "RUN_STARTED",
          name: null,
          data: "{}",
          atMillis: 1001,
        });
        yield* ledger.appendEvent(id, {
          seq: 1,
          type: "TEXT_MESSAGE_CONTENT",
          name: null,
          data: '{"delta":"hi"}',
          atMillis: 1002,
        });
        yield* ledger.updateRun(id, {
          status: "succeeded",
          usage: { inputTokens: 5 },
          endedAtMillis: 2000,
        });

        assert.strictEqual(yield* ledger.latestSeq(id), 1);

        const summaries = yield* ledger.listRuns(10);
        assert.strictEqual(summaries.length, 1);
        assert.strictEqual(summaries[0]?.status, "succeeded");
        assert.strictEqual(summaries[0]?.eventCount, 2);
        assert.strictEqual(summaries[0]?.session, "sess-abc");
        assert.strictEqual(summaries[0]?.usage?.inputTokens, 5);

        const events = yield* ledger.events(id).pipe(Stream.runCollect);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["RUN_STARTED", "TEXT_MESSAGE_CONTENT"],
        );
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("reports only running runs, newest first, with their event counts", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("older-running", 1000));
        yield* ledger.insertRun(record("newer-running", 3000));
        yield* ledger.insertRun(record("done", 2000));
        yield* ledger.updateRun(runId("done"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 2500,
        });
        yield* ledger.appendEvent(runId("newer-running"), {
          seq: 0,
          type: "RUN_STARTED",
          name: null,
          data: "{}",
          atMillis: 3001,
        });

        const running = yield* ledger.runningRuns;
        assert.deepStrictEqual(
          running.map((run) => run.id),
          [runId("newer-running"), runId("older-running")],
        );
        assert.strictEqual(running[0]?.eventCount, 1);
      }),
    );
  });
  it.layer(layerMemory)((it) => {
    it.effect("orders runs newest first", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("older", 1000));
        yield* ledger.insertRun(record("newer", 5000));
        const summaries = yield* ledger.listRuns(10);
        assert.deepStrictEqual(
          summaries.map((summary) => summary.id),
          ["newer", "older"],
        );
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("resolves the latest run for an item by recency, whatever its status", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("running-older", 1000, { status: "running" }));
        yield* ledger.insertRun(record("failed-latest", 5000, { status: "failed", endedAtMillis: 5500 }));
        yield* ledger.insertRun(record("other-newest", 6000, { workItem: otherWorkItem, status: "running" }));

        const latest = yield* ledger.latestRunForItem(workspace, workItem);
        assert.strictEqual(latest?.id, "failed-latest");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("returns null when the item has never run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("other", 1000, { workItem: otherWorkItem }));
        assert.isNull(yield* ledger.latestRunForItem(workspace, workItem));
      }),
    );
  });
});
