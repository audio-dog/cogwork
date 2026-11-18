import {
  BranchName,
  HarnessName,
  RunId,
  RunPlan,
  type RunRecord,
  type Session,
  SessionId,
  sessionHandle,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DaemonEventBus from "./daemon-event-bus";
import {
  layerMemory as memoryLedgerLayer,
  RunLedger,
  RunLedgerError,
  type RunLedgerService,
} from "./run-ledger";
import { LogProbe } from "./testing/log-probe";

const layerMemory = memoryLedgerLayer.pipe(Layer.provide(DaemonEventBus.layer));

const runId = Schema.decodeSync(RunId);
const branchName = Schema.decodeSync(BranchName);
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const otherWorkspace = Schema.decodeSync(WorkspaceId)("other");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const bareWorkItem = Schema.decodeSync(WorkItemId)("7");
const otherWorkItem = Schema.decodeSync(WorkItemId)("#8");
const session = Schema.decodeSync(SessionId)("sess-abc");
const laterSession = Schema.decodeSync(SessionId)("sess-later");

const recordLoggedTransitions = Effect.fn("test.recordLoggedTransitions")(function* (
  ledger: RunLedgerService,
  id: RunId,
) {
  yield* ledger.acceptRun(record(id, 1000), runPlan(id));
  yield* ledger.appendEvent(id, {
    seq: 0,
    type: "RUN_STARTED",
    name: null,
    data: "{}",
    atMillis: 1001,
  });
  yield* ledger.updateRun(id, {
    status: "succeeded",
    usage: null,
    endedAtMillis: 2000,
  });
});
const harness = Schema.decodeSync(HarnessName)("cursor");

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

const runPlan = (id: string) =>
  Schema.decodeSync(RunPlan)({
    id: runId(id),
    operation: "triage",
    harness: { name: harness, model: null, options: {}, profile: "read-only" },
    instructions: [],
    operatingInstructions: {
      name: "triage-agent",
      path: "/operating-instructions/triage-agent",
      resources: [],
    },
    tools: [],
    skills: [],
    mcp: [],
    subagents: [],
    hooks: [],
    middleware: [],
    structuredOutput: null,
    connections: [],
    messages: [{ role: "user", content: "Triage #7" }],
    workContext: {
      reference: { workItem, url: "https://example.test/issues/7" },
      prose: { body: "", comments: [] },
      facts: {
        assignees: [],
        openBlockers: 0,
        claim: null,
        priority: "medium",
      },
      observation: { generation: 3, observedAtMillis: 1000 },
    },
    sandbox: { workspace: "/repo", policy: "read-only" },
    persistence: { sessionKind: "opaque-handle" },
    provenance: {
      resolution: [],
      stamps: [],
      projectedNames: [],
      projection: [],
      observation: { generation: 3, observedAtMillis: 1000 },
    },
  });

const record = (id: string, startedAtMillis: number, over: Partial<RunRecord> = {}): RunRecord => ({
  id: runId(id),
  workspace,
  workItem,
  operation: "triage",
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
    it.effect("returns the most recent resumable run's session for a branch", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const sessionByBranch = (workspace: WorkspaceId, branch: BranchName) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(record("run-1", 1000, { branch: branchName("7-fix-export"), session }));
        yield* ledger.insertRun(record("run-2", 3000, { branch: branchName("9-other") }));
        yield* ledger.updateRun(runId("run-1"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 1500,
        });
        assert.strictEqual(yield* sessionByBranch(workspace, branchName("7-fix-export")), "sess-abc");
        assert.isNull(yield* sessionByBranch(workspace, branchName("9-other")));
        assert.isNull(yield* sessionByBranch(otherWorkspace, branchName("7-fix-export")));
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("prefers the later run when runs share a timestamp", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertSession(sessionRecord({ id: laterSession }));
        yield* ledger.insertRun(record("run-1", 1000, { branch: branchName("7-fix-export"), session }));
        yield* ledger.insertRun(
          record("run-2", 1000, { branch: branchName("7-fix-export"), session: laterSession }),
        );

        assert.strictEqual(
          yield* ledger.sessionForBranch(workspace, branchName("7-fix-export")),
          laterSession,
        );
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("offers an owned-transcript run's session for resume even with no handle", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertSession({
          kind: "owned-transcript",
          id: session,
          workspace,
          harness,
          createdAtMillis: 0,
        });
        yield* ledger.insertRun(record("run-1", 1000, { branch: branchName("7-fix-export"), session }));
        const run = yield* ledger.latestRunByBranch(workspace, branchName("7-fix-export"));
        assert.strictEqual(run?.session, session);
        assert.isNull(sessionHandle(yield* ledger.getSession(session)));
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("does not offer an interrupted run's session for resume", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const sessionByBranch = (branch: BranchName) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(
          record("interrupted", 5000, {
            branch: branchName("7-fix-export"),
            session,
            status: "interrupted",
          }),
        );
        assert.isNull(yield* sessionByBranch(branchName("7-fix-export")));

        yield* ledger.insertRun(
          record("earlier", 1000, { branch: branchName("7-fix-export"), session, status: "failed" }),
        );
        assert.strictEqual(yield* sessionByBranch(branchName("7-fix-export")), "sess-abc");
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("does not offer a crashed run's session for resume", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const sessionByBranch = (branch: BranchName) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(
          record("crashed", 5000, { branch: branchName("7-fix-export"), session, status: "crashed" }),
        );
        assert.isNull(yield* sessionByBranch(branchName("7-fix-export")));

        yield* ledger.insertRun(
          record("earlier", 1000, { branch: branchName("7-fix-export"), session, status: "failed" }),
        );
        assert.strictEqual(yield* sessionByBranch(branchName("7-fix-export")), "sess-abc");
      }),
    );
  });

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

  it.layer(layerMemory)((it) => {
    it.effect("offers a still-running run for resume once its session has a handle", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        const id = runId("run-1");
        yield* ledger.insertSession(sessionRecord({ handle: null }));
        yield* ledger.insertRun(record("run-1", 1000, { branch: branchName("7-fix-export"), session }));

        assert.isNull(yield* ledger.latestRunByBranch(workspace, branchName("7-fix-export")));

        yield* ledger.recordSessionHandle(session, "cursor-abc");
        assert.strictEqual(sessionHandle(yield* ledger.getSession(session)), "cursor-abc");

        const inFlight = yield* ledger.getRun(id);
        assert.strictEqual(inFlight?.session, "sess-abc");
        assert.strictEqual(inFlight?.status, "running");
        assert.isNull(inFlight?.endedAtMillis);

        const byBranch = yield* ledger.latestRunByBranch(workspace, branchName("7-fix-export"));
        assert.strictEqual(byBranch?.id, id);
      }),
    );
  });

  it.layer(layerMemory)((it) => {
    it.effect("groups a branch's runs under one session and folds their events in order", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger;
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(record("first", 1000, { branch: branchName("b"), session }));
        yield* ledger.insertRun(record("second", 2000, { branch: branchName("b"), session }));
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

        assert.strictEqual(yield* ledger.sessionForBranch(workspace, branchName("b")), session);
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
