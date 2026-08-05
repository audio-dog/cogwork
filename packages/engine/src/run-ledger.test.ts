import {
  HarnessName,
  RunId,
  type RunRecord,
  SessionId,
  WorkItemId,
  WorkspaceId,
} from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { layerMemory, RunLedger } from "./run-ledger";

const runId = Schema.decodeSync(RunId);
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const session = Schema.decodeSync(SessionId)("sess-abc");
const harness = Schema.decodeSync(HarnessName)("cursor");

const record = (id: string, startedAtMillis: number, over: Partial<RunRecord> = {}): RunRecord => ({
  id: runId(id),
  workspace,
  workItem,
  stage: "triage",
  harness,
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis,
  endedAtMillis: null,
  ...over,
});

describe("RunLedger (memory)", () => {
  it.effect("persists a run, its events, and reports summaries with an event count", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      const id = runId("run-1");
      yield* ledger.insertRun(record("run-1", 1000));
      yield* ledger.appendEvent(id, { seq: 0, type: "RUN_STARTED", name: null, data: "{}", atMillis: 1001 });
      yield* ledger.appendEvent(id, {
        seq: 1,
        type: "TEXT_MESSAGE_CONTENT",
        name: null,
        data: '{"delta":"hi"}',
        atMillis: 1002,
      });
      yield* ledger.updateRun(id, {
        status: "succeeded",
        session,
        usage: { inputTokens: 5 },
        endedAtMillis: 2000,
      });

      const summaries = yield* ledger.listRuns(10);
      assert.strictEqual(summaries.length, 1);
      assert.strictEqual(summaries[0]?.status, "succeeded");
      assert.strictEqual(summaries[0]?.eventCount, 2);
      assert.strictEqual(summaries[0]?.session, "sess-abc");
      assert.strictEqual(summaries[0]?.usage?.inputTokens, 5);

      const events = yield* ledger.events(id);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["RUN_STARTED", "TEXT_MESSAGE_CONTENT"],
      );
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("returns the most recent session handle for a branch", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      const sessionByBranch = (workspace: string, branch: string) =>
        Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
      yield* ledger.insertRun(record("run-1", 1000, { branch: "7-fix-export" }));
      yield* ledger.insertRun(record("run-2", 3000, { branch: "9-other" }));
      yield* ledger.updateRun(runId("run-1"), {
        status: "succeeded",
        session,
        usage: null,
        endedAtMillis: 1500,
      });
      assert.strictEqual(yield* sessionByBranch("gh", "7-fix-export"), "sess-abc");
      assert.isNull(yield* sessionByBranch("gh", "9-other"));
      assert.isNull(yield* sessionByBranch("other", "7-fix-export"));
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("does not offer an interrupted run's session for resume", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      const sessionByBranch = (branch: string) =>
        Effect.map(ledger.latestRunByBranch("gh", branch), (run) => run?.session ?? null);
      yield* ledger.insertRun(
        record("interrupted", 5000, { branch: "7-fix-export", session, status: "interrupted" }),
      );
      assert.isNull(yield* sessionByBranch("7-fix-export"));

      yield* ledger.insertRun(record("earlier", 1000, { branch: "7-fix-export", session, status: "failed" }));
      assert.strictEqual(yield* sessionByBranch("7-fix-export"), "sess-abc");
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("does not offer a crashed run's session for resume", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      const sessionByBranch = (branch: string) =>
        Effect.map(ledger.latestRunByBranch("gh", branch), (run) => run?.session ?? null);
      yield* ledger.insertRun(
        record("crashed", 5000, { branch: "7-fix-export", session, status: "crashed" }),
      );
      assert.isNull(yield* sessionByBranch("7-fix-export"));

      yield* ledger.insertRun(record("earlier", 1000, { branch: "7-fix-export", session, status: "failed" }));
      assert.strictEqual(yield* sessionByBranch("7-fix-export"), "sess-abc");
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("marks only the item's running runs as crashed", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun(record("crash-running", 4000));
      yield* ledger.insertRun(record("crash-done", 4100));
      yield* ledger.updateRun(runId("crash-done"), {
        status: "succeeded",
        session,
        usage: null,
        endedAtMillis: 4200,
      });

      yield* ledger.crashRunning("gh", "#7", 5000);

      const statuses = yield* Effect.forEach(["crash-running", "crash-done"], (id) =>
        Effect.map(ledger.getRun(runId(id)), (run) => [run?.status, run?.endedAtMillis]),
      );
      assert.deepStrictEqual(statuses, [
        ["crashed", 5000],
        ["succeeded", 4200],
      ]);
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("counts consecutive crashes and resets the count after a success", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      const crashes = () => ledger.consecutiveCrashes("gh", "#7");
      yield* ledger.insertRun(record("c1", 1000, { status: "crashed" }));
      yield* ledger.insertRun(record("c2", 2000, { status: "crashed" }));
      assert.strictEqual(yield* crashes(), 2);

      yield* ledger.insertRun(record("ok", 3000, { status: "succeeded" }));
      assert.strictEqual(yield* crashes(), 0);

      yield* ledger.insertRun(record("c3", 4000, { status: "crashed" }));
      assert.strictEqual(yield* crashes(), 1);
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("resets the crash streak on any completed run between crashes", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      const crashes = () => ledger.consecutiveCrashes("gh", "#7");
      yield* ledger.insertRun(record("c1", 1000, { status: "crashed" }));
      yield* ledger.insertRun(record("failed", 2000, { status: "failed" }));
      yield* ledger.insertRun(record("c2", 3000, { status: "crashed" }));
      assert.strictEqual(yield* crashes(), 1);
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("interrupts runs this daemon started and leaves older or finished ones alone", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun(record("stale", 3900));
      yield* ledger.insertRun(record("in-flight", 4000));
      yield* ledger.insertRun(record("done", 4100));
      yield* ledger.updateRun(runId("done"), {
        status: "succeeded",
        session,
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
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("records a session on a run that has not reached a terminal status", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      const id = runId("run-1");
      yield* ledger.insertRun(record("run-1", 1000, { branch: "7-fix-export" }));
      yield* ledger.recordSession(id, session);

      const inFlight = yield* ledger.getRun(id);
      assert.strictEqual(inFlight?.session, "sess-abc");
      assert.strictEqual(inFlight?.status, "running");
      assert.isNull(inFlight?.endedAtMillis);

      const byBranch = yield* ledger.latestRunByBranch("gh", "7-fix-export");
      assert.strictEqual(byBranch?.id, id);
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

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
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );
});

describe("RunLedger resolveWatchTarget (memory)", () => {
  const otherItem = Schema.decodeSync(WorkItemId)("#999");
  const targetId = (workItem: string) =>
    Effect.flatMap(RunLedger, (ledger) => ledger.resolveWatchTarget(workItem)).pipe(
      Effect.map((run) => run?.id ?? null),
    );

  it.effect("prefers a running run over a more recent completed run", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun(record("running", 1000, { status: "running" }));
      yield* ledger.insertRun(record("newer-done", 5000, { status: "succeeded", endedAtMillis: 5500 }));
      assert.strictEqual(yield* targetId("#7"), "running");
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("falls back to the most recent run when nothing is running", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun(record("old-done", 1000, { status: "failed", endedAtMillis: 1500 }));
      yield* ledger.insertRun(record("new-done", 5000, { status: "succeeded", endedAtMillis: 5500 }));
      assert.strictEqual(yield* targetId("#7"), "new-done");
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

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
      assert.strictEqual(yield* targetId("#7"), "target");
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("resolves the same run for the #-prefixed and bare forms", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun(record("only", 1000, { status: "running" }));
      assert.strictEqual(yield* targetId("#7"), "only");
      assert.strictEqual(yield* targetId("7"), "only");
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );

  it.effect("returns null when the item has never run", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun(record("other", 1000, { workItem: otherItem }));
      assert.isNull(yield* targetId("#7"));
    }).pipe(Effect.provide(layerMemory), Effect.scoped),
  );
});
