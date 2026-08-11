import {
  HarnessName,
  RunId,
  type RunRecord,
  type Session,
  SessionId,
  sessionHandle,
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
const otherWorkItem = Schema.decodeSync(WorkItemId)("#8");
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

const sessionRecord = (over: Partial<Session> = {}): Session => ({
  kind: "opaque-handle",
  id: session,
  workspace,
  harness,
  createdAtMillis: 0,
  handle: "cursor-abc",
  ...over,
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
    it.effect("returns the most recent resumable run's session for a branch", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const sessionByBranch = (workspace: string, branch: string) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(record("run-1", 1000, { branch: "7-fix-export", session }));
        yield* ledger.insertRun(record("run-2", 3000, { branch: "9-other" }));
        yield* ledger.updateRun(runId("run-1"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 1500,
        });
        assert.strictEqual(yield* sessionByBranch("gh", "7-fix-export"), "sess-abc");
        assert.isNull(yield* sessionByBranch("gh", "9-other"));
        assert.isNull(yield* sessionByBranch("other", "7-fix-export"));
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("does not offer an interrupted run's session for resume", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const sessionByBranch = (branch: string) =>
          Effect.map(ledger.latestRunByBranch("gh", branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(
          record("interrupted", 5000, { branch: "7-fix-export", session, status: "interrupted" }),
        );
        assert.isNull(yield* sessionByBranch("7-fix-export"));

        yield* ledger.insertRun(
          record("earlier", 1000, { branch: "7-fix-export", session, status: "failed" }),
        );
        assert.strictEqual(yield* sessionByBranch("7-fix-export"), "sess-abc");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("does not offer a crashed run's session for resume", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const sessionByBranch = (branch: string) =>
          Effect.map(ledger.latestRunByBranch("gh", branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(
          record("crashed", 5000, { branch: "7-fix-export", session, status: "crashed" }),
        );
        assert.isNull(yield* sessionByBranch("7-fix-export"));

        yield* ledger.insertRun(
          record("earlier", 1000, { branch: "7-fix-export", session, status: "failed" }),
        );
        assert.strictEqual(yield* sessionByBranch("7-fix-export"), "sess-abc");
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

        yield* ledger.crashRunning("gh", "#7", 5000);

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

          yield* ledger.closeRunning("gh", "#7", 5000);

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
        const crashes = () => ledger.consecutiveCrashes("gh", "#7");
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
        const crashes = () => ledger.consecutiveCrashes("gh", "#7");
        yield* ledger.insertRun(record("c1", 1000, { status: "crashed" }));
        yield* ledger.insertRun(record("failed", 2000, { status: "failed" }));
        yield* ledger.insertRun(record("c2", 3000, { status: "crashed" }));
        assert.strictEqual(yield* crashes(), 1);
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
    it.effect("offers a still-running run for resume once its session has a handle", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const id = runId("run-1");
        yield* ledger.insertSession(sessionRecord({ handle: null }));
        yield* ledger.insertRun(record("run-1", 1000, { branch: "7-fix-export", session }));

        assert.isNull(yield* ledger.latestRunByBranch("gh", "7-fix-export"));

        yield* ledger.recordSessionHandle(session, "cursor-abc");
        assert.strictEqual(sessionHandle(yield* ledger.getSession(session)), "cursor-abc");

        const inFlight = yield* ledger.getRun(id);
        assert.strictEqual(inFlight?.session, "sess-abc");
        assert.strictEqual(inFlight?.status, "running");
        assert.isNull(inFlight?.endedAtMillis);

        const byBranch = yield* ledger.latestRunByBranch("gh", "7-fix-export");
        assert.strictEqual(byBranch?.id, id);
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("groups a branch's runs under one session and folds their events in order", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(record("first", 1000, { branch: "b", session }));
        yield* ledger.insertRun(record("second", 2000, { branch: "b", session }));
        yield* ledger.appendEvent(runId("second"), {
          seq: 0,
          type: "TEXT_MESSAGE_CONTENT",
          name: null,
          data: '{"delta":"world"}',
          atMillis: 2100,
        });
        yield* ledger.appendEvent(runId("first"), {
          seq: 0,
          type: "RUN_STARTED",
          name: null,
          data: "{}",
          atMillis: 1100,
        });

        assert.strictEqual(yield* ledger.sessionForBranch("gh", "b"), session);
        const events = yield* ledger.sessionEvents(session);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["RUN_STARTED", "TEXT_MESSAGE_CONTENT"],
        );
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

        const latest = yield* ledger.latestRunForItem("gh", "#7");
        assert.strictEqual(latest?.id, "failed-latest");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("returns null when the item has never run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("other", 1000, { workItem: otherWorkItem }));
        assert.isNull(yield* ledger.latestRunForItem("gh", "#7"));
      }),
    );
  });
});

describe("RunLedger resolveWatchTarget (memory)", () => {
  const otherItem = Schema.decodeSync(WorkItemId)("#999");
  const targetId = (workItem: string) =>
    Effect.flatMap(RunLedger, (ledger) => ledger.resolveWatchTarget(workItem)).pipe(
      Effect.map((run) => run?.id ?? null),
    );

  it.layer(layerMemory)((it) => {
    it.effect("prefers a running run over a more recent completed run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("running", 1000, { status: "running" }));
        yield* ledger.insertRun(record("newer-done", 5000, { status: "succeeded", endedAtMillis: 5500 }));
        assert.strictEqual(yield* targetId("#7"), "running");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("falls back to the most recent run when nothing is running", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("old-done", 1000, { status: "failed", endedAtMillis: 1500 }));
        yield* ledger.insertRun(record("new-done", 5000, { status: "succeeded", endedAtMillis: 5500 }));
        assert.strictEqual(yield* targetId("#7"), "new-done");
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
        assert.strictEqual(yield* targetId("#7"), "target");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("resolves the same run for the #-prefixed and bare forms", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("only", 1000, { status: "running" }));
        assert.strictEqual(yield* targetId("#7"), "only");
        assert.strictEqual(yield* targetId("7"), "only");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("returns null when the item has never run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertRun(record("other", 1000, { workItem: otherItem }));
        assert.isNull(yield* targetId("#7"));
      }),
    );
  });
});
