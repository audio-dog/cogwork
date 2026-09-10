import { DatabaseSync } from "node:sqlite";
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
import { bootControlStoreLayer, DaemonEventBus, RunLedger } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as GenericSqlClient from "effect/unstable/sql/SqlClient";
import { layer as ledgerLayer, runLedgerAppendDuration } from "./ledger";

class TestStorePath extends Context.Service<TestStorePath, string>()(
  "@cogwork/cli/ledger.test/TestStorePath",
) {}

interface LedgerLogProbeService {
  readonly capture: (entry: unknown) => void;
  readonly entries: Effect.Effect<ReadonlyArray<unknown>>;
}

class LedgerLogProbe extends Context.Service<LedgerLogProbe, LedgerLogProbeService>()(
  "@cogwork/cli/ledger.test/LedgerLogProbe",
) {
  static readonly layer = Layer.sync(LedgerLogProbe, () => {
    const entries = MutableRef.make<ReadonlyArray<unknown>>([]);
    return {
      capture: (entry) => MutableRef.update(entries, (current) => [...current, entry]),
      entries: Effect.sync(() => MutableRef.get(entries)),
    };
  });
  static readonly captureLayer = Logger.layer([
    Effect.map(LedgerLogProbe, (probe) =>
      Logger.make<unknown, void>(({ message }) => probe.capture(message)),
    ),
  ]).pipe(Layer.provideMerge(LedgerLogProbe.layer));
}

const bootedLedgerLayer = (storePath: string) =>
  ledgerLayer.pipe(Layer.provideMerge(bootControlStoreLayer(storePath, { busyTimeout: "25 millis" })));

const runRow = (run: RunRecord) =>
  [
    run.id,
    run.workspace,
    run.workItem,
    run.stage,
    run.harness,
    run.branch,
    run.session,
    run.usage?.inputTokens ?? null,
    run.usage?.outputTokens ?? null,
    run.usage?.totalTokens ?? null,
    run.status,
    run.startedAtMillis,
    run.endedAtMillis,
  ] as const;

const insertRunsBulk = (storePath: string, records: ReadonlyArray<RunRecord>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (sqlite) =>
      Effect.sync(() => {
        sqlite.exec("BEGIN");
        const insert = sqlite.prepare(`
          INSERT INTO runs (
            id, workspace, work_item, stage, harness, branch, session,
            input_tokens, output_tokens, total_tokens, status, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const run of records) {
          insert.run(...runRow(run));
        }
        sqlite.exec("COMMIT");
      }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );

const runId = Schema.decodeSync(RunId);
const branchName = Schema.decodeSync(BranchName);
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const otherWorkspace = Schema.decodeSync(WorkspaceId)("other");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const crashItem = Schema.decodeSync(WorkItemId)("#101");
const resolveItem = Schema.decodeSync(WorkItemId)("#202");
const bareResolveItem = Schema.decodeSync(WorkItemId)("202");
const resolveOther = Schema.decodeSync(WorkItemId)("#303");
const missingResolveItem = Schema.decodeSync(WorkItemId)("#404");
const session = Schema.decodeSync(SessionId)("sess-abc");
const replacementSession = Schema.decodeSync(SessionId)("sess-replaced");
const midSession = Schema.decodeSync(SessionId)("sess-mid");
const foldSession = Schema.decodeSync(SessionId)("sess-fold");
const ownedSession = Schema.decodeSync(SessionId)("sess-owned");
const harness = Schema.decodeSync(HarnessName)("cursor");

const runPlan = (id: string, message = "Triage #7") =>
  Schema.decodeSync(RunPlan)({
    id: runId(id),
    operation: "triage",
    harness: { name: harness, model: null, effort: null, profile: "read-only" },
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
    commands: [],
    hooks: [],
    middleware: [],
    structuredOutput: null,
    connections: [],
    messages: [{ role: "user", content: message }],
    workContext: {
      reference: { workItem, url: "https://example.test/issues/7" },
      facts: {
        roles: ["needs-triage"],
        assignees: [],
        openBlockers: 0,
        claim: null,
        priority: "medium",
        pr: null,
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

const record = (id: string, startedAtMillis: number, overrides: Partial<RunRecord> = {}): RunRecord => ({
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
  ...overrides,
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
    it.effect("persists one immutable Plan when accepting a Run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const accepted = runPlan("accepted");
        yield* ledger.acceptRun(record("accepted", 1000), accepted);

        assert.deepStrictEqual(yield* ledger.getRunPlan(accepted.id), accepted);
        const error = yield* Effect.flip(
          ledger.acceptRun(record("accepted", 2000), runPlan("accepted", "Changed")),
        );
        assert.strictEqual(error._tag, "RunLedgerError");
        assert.isFalse(error.retryable);
        assert.deepStrictEqual(yield* ledger.getRunPlan(accepted.id), accepted);
      }),
    );

    it.effect("logs successful Run persistence transitions once", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const logs = yield* LedgerLogProbe;
        const before = (yield* logs.entries).length;
        const id = runId("logged-sqlite-transitions");
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

        assert.deepStrictEqual((yield* logs.entries).slice(before), [
          ["accepted Run", { harness: "cursor", branch: null }],
          ["appended Run event", { seq: 0 }],
          ["settled Run", { status: "succeeded" }],
        ]);
      }),
    );

    it.effect("marks store write failures retryable", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const storePath = yield* TestStorePath;
        const sqlite = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(storePath)),
          (database) => Effect.sync(() => database.close()),
        );
        yield* Effect.sync(() => sqlite.exec("BEGIN EXCLUSIVE"));

        const error = yield* Effect.flip(ledger.acceptRun(record("locked", 1000), runPlan("locked")));

        assert.strictEqual(error._tag, "RunLedgerError");
        assert.isTrue(error.retryable);
      }),
    );

    it.effect("persists a run, its events, and reports a summary with event count", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("happy-1");
        yield* ledger.insertRun(record("happy-1", 1000, { session }));
        const before = (yield* Metric.value(runLedgerAppendDuration)).count;
        yield* ledger.appendEvent(id, {
          seq: 1,
          type: "TEXT_MESSAGE_CONTENT",
          name: null,
          data: '{"delta":"hi"}',
          atMillis: 1002,
        });
        yield* ledger.appendEvent(id, {
          seq: 0,
          type: "RUN_STARTED",
          name: null,
          data: "{}",
          atMillis: 1001,
        });
        assert.strictEqual((yield* Metric.value(runLedgerAppendDuration)).count, before + 2);
        yield* ledger.setRunSession(id, replacementSession);
        yield* ledger.updateRun(id, {
          status: "succeeded",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          endedAtMillis: 2000,
        });

        assert.strictEqual(yield* ledger.latestSeq(id), 1);

        const summaries = yield* ledger.listRuns(10);
        const storedSummary = yield* ledger.getRunSummary(id);
        const summary = summaries.find((row) => row.id === id);
        assert.isDefined(summary);
        assert.strictEqual(storedSummary?.eventCount, 2);
        assert.strictEqual(summary?.status, "succeeded");
        assert.strictEqual(summary?.eventCount, 2);
        assert.strictEqual(summary?.session, "sess-replaced");
        assert.deepStrictEqual(summary?.usage, {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
        });

        const events = yield* ledger.events(id).pipe(Stream.runCollect);
        assert.deepStrictEqual(
          events.map((event) => event.seq),
          [0, 1],
        );
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["RUN_STARTED", "TEXT_MESSAGE_CONTENT"],
        );
      }),
    );

    it.effect("pages event reads by UTF-8 payload bytes", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("byte-pages");
        const data = "é".repeat(300_000);
        yield* ledger.insertRun(record(id, 1000));
        yield* Effect.forEach([0, 1], (seq) =>
          ledger.appendEvent(id, {
            seq,
            type: "CUSTOM",
            name: null,
            data,
            atMillis: 1001 + seq,
          }),
        );

        const chunks = yield* ledger.events(id).pipe(Stream.chunks, Stream.runCollect);

        assert.deepStrictEqual(
          chunks.map((chunk) => chunk.length),
          [1, 1],
        );
      }),
    );

    it.effect("persists a held claim disposition", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("held-claim");
        yield* ledger.insertRun(record(id, 1000));
        yield* ledger.updateRun(id, {
          status: "failed",
          usage: null,
          endedAtMillis: 2000,
          claimDisposition: "hold",
        });

        const stored = yield* ledger.getRun(id);

        assert.strictEqual(stored?.claimDisposition, "hold");
      }),
    );

    it.effect("warns with the operation and row id before ignoring corrupt stored values", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const storePath = yield* TestStorePath;
        const run = runId("corrupt-run");
        const plan = runId("corrupt-plan");
        const sessionReference = runId("corrupt-session-reference");
        yield* ledger.insertRun(record(run, 1000));
        yield* ledger.acceptRun(record(plan, 2000), runPlan(plan));
        yield* ledger.insertRun(
          record(sessionReference, 3000, { branch: branchName("corrupt-session-branch"), session }),
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new DatabaseSync(storePath)),
          (sqlite) =>
            Effect.sync(() => {
              sqlite.prepare("UPDATE runs SET status = 'unknown' WHERE id = ?").run(run);
              sqlite.prepare("UPDATE run_plans SET plan = '' WHERE run_id = ?").run(plan);
              sqlite.prepare("UPDATE runs SET session = '' WHERE id = ?").run(sessionReference);
            }),
          (sqlite) => Effect.sync(() => sqlite.close()),
        );
        const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = [];
        const logger = Logger.make<unknown, void>(({ fiber, message }) => {
          logs.push({ message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } });
        });

        const [storedRun, storedPlan, storedSession] = yield* Effect.all([
          ledger.getRun(run),
          ledger.getRunPlan(plan),
          ledger.sessionForBranch(workspace, branchName("corrupt-session-branch")),
        ]).pipe(Effect.withLogger(logger));
        assert.isNull(storedRun);
        assert.isNull(storedPlan);
        assert.isNull(storedSession);

        const warnings = logs
          .filter(({ message }) => String(message).includes("stored row decode failed"))
          .map(({ annotations }) => annotations);
        assert.deepStrictEqual(warnings, [
          { operation: "getRun", rowId: run },
          { operation: "getRunPlan", rowId: plan },
          { operation: "sessionForBranch", rowId: sessionReference },
        ]);
      }),
    );

    it.effect("orders runs newest first", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertRun(record("order-older", 1000));
        yield* ledger.insertRun(record("order-newer", 5000));
        const summaries = yield* ledger.listRuns(10);
        const ids = summaries
          .map((summary) => summary.id)
          .filter((id) => id === "order-older" || id === "order-newer");
        assert.deepStrictEqual(ids, ["order-newer", "order-older"]);
      }),
    );

    it.effect("reports only running runs, newest first, with their event counts", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertRun(record("run-older", 1000));
        yield* ledger.insertRun(record("run-newer", 3000));
        yield* ledger.insertRun(record("run-done", 2000));
        yield* ledger.updateRun(runId("run-done"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 2500,
        });
        yield* ledger.appendEvent(runId("run-newer"), {
          seq: 0,
          type: "RUN_STARTED",
          name: null,
          data: "{}",
          atMillis: 3001,
        });

        const running = yield* ledger.runningRuns;
        const ids = running
          .map((run) => run.id)
          .filter((id) => id === "run-older" || id === "run-newer" || id === "run-done");
        assert.deepStrictEqual(ids, ["run-newer", "run-older"]);
        assert.strictEqual(running.find((run) => run.id === "run-newer")?.eventCount, 1);
      }),
    );

    it.effect("returns the most recent resumable run's session for a branch", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const sessionByBranch = (workspace: WorkspaceId, branch: BranchName) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(record("branch-1", 1000, { branch: branchName("7-fix-export"), session }));
        yield* ledger.insertRun(record("branch-2", 3000, { branch: branchName("9-other") }));
        yield* ledger.updateRun(runId("branch-1"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 1500,
        });
        assert.strictEqual(yield* sessionByBranch(workspace, branchName("7-fix-export")), "sess-abc");
        assert.isNull(yield* sessionByBranch(workspace, branchName("9-other")));
        assert.isNull(yield* sessionByBranch(otherWorkspace, branchName("7-fix-export")));
      }),
    );

    it.effect("breaks equal branch-run timestamps by insertion order", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const branch = branchName("16-timestamp-tie");
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertSession(sessionRecord({ id: replacementSession, handle: "cursor-replaced" }));
        yield* ledger.insertRun(record("tie-earlier", 1000, { branch, session }));
        yield* ledger.insertRun(record("tie-later", 1000, { branch, session: replacementSession }));

        assert.strictEqual(yield* ledger.sessionForBranch(workspace, branch), replacementSession);
        assert.strictEqual((yield* ledger.latestRunByBranch(workspace, branch))?.session, replacementSession);
      }),
    );

    it.effect("offers an owned-transcript run's session for resume even with no handle", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertSession({
          kind: "owned-transcript",
          id: ownedSession,
          workspace,
          harness,
          createdAtMillis: 0,
        });
        const branch = branchName("15-owned");
        yield* ledger.insertRun(record("owned-branch", 1000, { branch, session: ownedSession }));
        const run = yield* ledger.latestRunByBranch(workspace, branch);
        assert.strictEqual(run?.session, ownedSession);
        assert.isNull(sessionHandle(yield* ledger.getSession(ownedSession)));
      }),
    );

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

    it.effect("does not offer a crashed run's session for resume", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const sessionByBranch = (branch: BranchName) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        const branch = branchName("13-crash");
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(record("crashed-branch", 5000, { branch, session, status: "crashed" }));
        assert.isNull(yield* sessionByBranch(branch));

        yield* ledger.insertRun(record("crashed-earlier", 1000, { branch, session, status: "failed" }));
        assert.strictEqual(yield* sessionByBranch(branch), "sess-abc");
      }),
    );

    it.effect("offers a still-running run for resume once its session has a handle", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("in-flight");
        yield* ledger.insertSession(sessionRecord({ id: midSession, handle: null }));
        const branch = branchName("11-mid-run");
        yield* ledger.insertRun(record("in-flight", 7000, { branch, session: midSession }));

        assert.isNull(yield* ledger.latestRunByBranch(workspace, branch));

        yield* ledger.recordSessionHandle(midSession, "cursor-mid");
        assert.strictEqual(sessionHandle(yield* ledger.getSession(midSession)), "cursor-mid");

        const inFlight = yield* ledger.getRun(id);
        assert.strictEqual(inFlight?.session, "sess-mid");
        assert.strictEqual(inFlight?.status, "running");
        assert.isNull(inFlight?.endedAtMillis);

        const byBranch = yield* ledger.latestRunByBranch(workspace, branch);
        assert.strictEqual(byBranch?.id, id);
      }),
    );

    it.effect("folds a session's events across every run that shares it", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertSession(sessionRecord({ id: foldSession }));
        const branch = branchName("22-two-runs");
        yield* ledger.insertRun(record("sess-first", 8000, { branch, session: foldSession }));
        yield* ledger.insertRun(record("sess-second", 9000, { branch, session: foldSession }));
        yield* ledger.appendEvent(runId("sess-second"), {
          seq: 0,
          type: "TEXT_MESSAGE_CONTENT",
          name: null,
          data: '{"delta":"world"}',
          atMillis: 9100,
        });
        yield* ledger.appendEvent(runId("sess-first"), {
          seq: 0,
          type: "RUN_STARTED",
          name: null,
          data: "{}",
          atMillis: 8100,
        });

        assert.strictEqual(yield* ledger.sessionForBranch(workspace, branch), foldSession);
        const events = yield* ledger.sessionEvents(foldSession);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["RUN_STARTED", "TEXT_MESSAGE_CONTENT"],
        );
      }),
    );

    it.effect("collapses absent token usage fields to omitted keys", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("usage-partial");
        yield* ledger.insertRun(record("usage-partial", 9000));
        yield* ledger.updateRun(id, {
          status: "succeeded",
          usage: { inputTokens: 5 },
          endedAtMillis: 9100,
        });

        const summaries = yield* ledger.listRuns(10);
        const summary = summaries.find((row) => row.id === id);
        assert.isDefined(summary);
        assert.deepStrictEqual(summary?.usage, { inputTokens: 5 });
      }),
    );

    it.effect("round-trips the estimated flag on a best-guess usage", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("usage-estimated");
        yield* ledger.insertRun(record("usage-estimated", 9500));
        yield* ledger.updateRun(id, {
          status: "succeeded",
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, estimated: true },
          endedAtMillis: 9600,
        });

        const summaries = yield* ledger.listRuns(10);
        const summary = summaries.find((row) => row.id === id);
        assert.isDefined(summary);
        assert.deepStrictEqual(summary?.usage, {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          estimated: true,
        });
      }),
    );

    it.effect("resolves a watch target by work item, running-first, past the recent-runs window", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const storePath = yield* TestStorePath;
        yield* ledger.insertRun(
          record("resolve-old-done", 1000, {
            workItem: resolveItem,
            status: "succeeded",
            endedAtMillis: 1500,
          }),
        );
        yield* ledger.insertRun(record("resolve-running", 2000, { workItem: resolveItem }));
        yield* insertRunsBulk(
          storePath,
          Array.from({ length: 60 }, (_, index) =>
            record(`resolve-other-${index}`, 3000 + index, {
              workItem: resolveOther,
              status: "succeeded",
              endedAtMillis: 3001 + index,
            }),
          ),
        );

        const byHash = yield* ledger.resolveWatchTarget(resolveItem);
        const byBare = yield* ledger.resolveWatchTarget(bareResolveItem);
        assert.strictEqual(byHash?.id, "resolve-running");
        assert.strictEqual(byBare?.id, "resolve-running");
      }),
    );

    it.effect("resolves nothing for a work item that has never run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        assert.isNull(yield* ledger.resolveWatchTarget(missingResolveItem));
      }),
    );
  });
});

describe("published sqlite RunLedger mutations", () => {
  class BaseSqliteClient extends Context.Service<
    BaseSqliteClient,
    typeof SqliteClient.SqliteClient.Service
  >()("@cogwork/cli/ledger.test/BaseSqliteClient") {}

  class StatementLog extends Context.Service<StatementLog, Ref.Ref<ReadonlyArray<string>>>()(
    "@cogwork/cli/ledger.test/StatementLog",
  ) {
    static readonly layer = Layer.effect(StatementLog, Ref.make<ReadonlyArray<string>>([]));
  }

  const countingClientLayer = (storePath: string) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const client = yield* BaseSqliteClient;
        const statements = yield* StatementLog;
        const countedClient = new Proxy(client, {
          get(target, property, receiver) {
            if (property !== "unsafe") return Reflect.get(target, property, receiver);
            return (query: string, params?: ReadonlyArray<unknown>) => {
              MutableRef.update(statements.ref, (entries) => [...entries, query]);
              return target.unsafe(query, params);
            };
          },
        });
        return Context.make(SqliteClient.SqliteClient, countedClient).pipe(
          Context.add(GenericSqlClient.SqlClient, countedClient),
        );
      }),
    ).pipe(
      Layer.provide(
        Layer.effect(BaseSqliteClient, SqliteClient.SqliteClient).pipe(
          Layer.provide(SqliteClient.layer({ filename: storePath, busyTimeout: "25 millis" })),
        ),
      ),
      Layer.provideMerge(StatementLog.layer),
    );

  layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-ledger-statements-" });
      const storePath = path.join(dir, "control.db");
      return RunLedger.publishingLayer.pipe(
        Layer.provideMerge(
          Layer.merge(ledgerLayer, bootControlStoreLayer(storePath)).pipe(
            Layer.provideMerge(countingClientLayer(storePath)),
          ),
        ),
        Layer.provide(DaemonEventBus.layer),
      );
    }).pipe(Layer.unwrap, Layer.provide(NodeServices.layer)),
  )((it) => {
    it.effect("publishes with two statements and never selects event payloads", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        const statements = yield* StatementLog;
        const id = runId("statement-count");
        yield* ledger.insertRun(record(id, 1000));
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, seq) => seq),
          (seq) =>
            ledger.appendEvent(id, {
              seq,
              type: "TEXT_MESSAGE_CONTENT",
              name: null,
              data: '{"delta":"x"}',
              atMillis: 1001 + seq,
            }),
          { discard: true },
        );
        const mutationStart = (yield* Ref.get(statements)).length;

        yield* ledger.updateRun(id, {
          status: "succeeded",
          usage: null,
          endedAtMillis: 2000,
        });

        const mutationStatements = (yield* Ref.get(statements)).slice(mutationStart);
        assert.strictEqual(mutationStatements.length, 2);
        assert.isFalse(mutationStatements.some((statement) => statement.includes("run_events")));
      }),
    );
  });
});

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
