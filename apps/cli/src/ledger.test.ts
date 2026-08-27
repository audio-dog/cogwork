import { DatabaseSync } from "node:sqlite";
import {
  HarnessName,
  RunId,
  type RunRecord,
  type Session,
  SessionId,
  sessionHandle,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { migrate, RunLedger } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { layer as ledgerLayer } from "./ledger";

class TestLedgerPath extends Context.Service<TestLedgerPath, string>()(
  "@cogwork/cli/ledger.test/TestLedgerPath",
) {}

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

const insertRunsBulk = (ledgerPath: string, records: ReadonlyArray<RunRecord>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(ledgerPath)),
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
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const crashItem = Schema.decodeSync(WorkItemId)("#101");
const resolveItem = Schema.decodeSync(WorkItemId)("#202");
const resolveOther = Schema.decodeSync(WorkItemId)("#303");
const session = Schema.decodeSync(SessionId)("sess-abc");
const replacementSession = Schema.decodeSync(SessionId)("sess-replaced");
const midSession = Schema.decodeSync(SessionId)("sess-mid");
const foldSession = Schema.decodeSync(SessionId)("sess-fold");
const ownedSession = Schema.decodeSync(SessionId)("sess-owned");
const harness = Schema.decodeSync(HarnessName)("cursor");

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

const sqliteLedgerLayer = ledgerLayer;

const insertRunAt = (ledgerPath: string, run: RunRecord) =>
  migrate(ledgerPath).pipe(
    Effect.andThen(Effect.flatMap(RunLedger.CoreRunLedger, (ledger) => ledger.insertRun(run))),
    Effect.provide(sqliteLedgerLayer(ledgerPath)),
  );

const listRunsAt = (ledgerPath: string) =>
  migrate(ledgerPath).pipe(
    Effect.andThen(Effect.flatMap(RunLedger.CoreRunLedger, (ledger) => ledger.listRuns(10))),
    Effect.provide(sqliteLedgerLayer(ledgerPath)),
  );

const writeRetiredStatus = (ledgerPath: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(ledgerPath)),
    (sqlite) =>
      Effect.sync(() => sqlite.exec("UPDATE runs SET status = 'blocked'; DELETE FROM control_migrations")),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );

describe("sqlite RunLedger", () => {
  layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-ledger-" });
      const ledgerPath = path.join(dir, "runs.db");
      yield* migrate(ledgerPath);
      return Layer.merge(sqliteLedgerLayer(ledgerPath), Layer.succeed(TestLedgerPath, ledgerPath));
    }).pipe(Layer.unwrap, Layer.provide(NodeServices.layer)),
  )((it) => {
    it.effect("persists a run, its events, and reports a summary with event count", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("happy-1");
        yield* ledger.insertRun(record("happy-1", 1000, { session }));
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
        yield* ledger.setRunSession(id, replacementSession);
        yield* ledger.updateRun(id, {
          status: "succeeded",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          endedAtMillis: 2000,
        });

        const summaries = yield* ledger.listRuns(10);
        const summary = summaries.find((row) => row.id === id);
        assert.isDefined(summary);
        assert.strictEqual(summary?.status, "succeeded");
        assert.strictEqual(summary?.eventCount, 2);
        assert.strictEqual(summary?.session, "sess-replaced");
        assert.deepStrictEqual(summary?.usage, {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
        });

        const events = yield* ledger.events(id);
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
        const sessionByBranch = (workspace: string, branch: string) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(record("branch-1", 1000, { branch: "7-fix-export", session }));
        yield* ledger.insertRun(record("branch-2", 3000, { branch: "9-other" }));
        yield* ledger.updateRun(runId("branch-1"), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 1500,
        });
        assert.strictEqual(yield* sessionByBranch("gh", "7-fix-export"), "sess-abc");
        assert.isNull(yield* sessionByBranch("gh", "9-other"));
        assert.isNull(yield* sessionByBranch("other", "7-fix-export"));
      }),
    );

    it.effect("breaks equal branch-run timestamps by insertion order", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const branch = "16-timestamp-tie";
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertSession(sessionRecord({ id: replacementSession, handle: "cursor-replaced" }));
        yield* ledger.insertRun(record("tie-earlier", 1000, { branch, session }));
        yield* ledger.insertRun(record("tie-later", 1000, { branch, session: replacementSession }));

        assert.strictEqual(yield* ledger.sessionForBranch("gh", branch), replacementSession);
        assert.strictEqual((yield* ledger.latestRunByBranch("gh", branch))?.session, replacementSession);
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
        yield* ledger.insertRun(record("owned-branch", 1000, { branch: "15-owned", session: ownedSession }));
        const run = yield* ledger.latestRunByBranch("gh", "15-owned");
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
        yield* ledger.crashRunning("gh", "#101", 2500);

        assert.strictEqual((yield* ledger.getRun(runId("crash-running")))?.status, "crashed");
        assert.strictEqual(yield* ledger.consecutiveCrashes("gh", "#101"), 2);

        yield* ledger.insertRun(record("crash-ok", 3000, { workItem: crashItem, status: "succeeded" }));
        assert.strictEqual(yield* ledger.consecutiveCrashes("gh", "#101"), 0);
      }),
    );

    it.effect("does not offer a crashed run's session for resume", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const sessionByBranch = (branch: string) =>
          Effect.map(ledger.latestRunByBranch("gh", branch), (run) => run?.session ?? null);
        yield* ledger.insertSession(sessionRecord());
        yield* ledger.insertRun(
          record("crashed-branch", 5000, { branch: "13-crash", session, status: "crashed" }),
        );
        assert.isNull(yield* sessionByBranch("13-crash"));

        yield* ledger.insertRun(
          record("crashed-earlier", 1000, { branch: "13-crash", session, status: "failed" }),
        );
        assert.strictEqual(yield* sessionByBranch("13-crash"), "sess-abc");
      }),
    );

    it.effect("offers a still-running run for resume once its session has a handle", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const id = runId("in-flight");
        yield* ledger.insertSession(sessionRecord({ id: midSession, handle: null }));
        yield* ledger.insertRun(record("in-flight", 7000, { branch: "11-mid-run", session: midSession }));

        assert.isNull(yield* ledger.latestRunByBranch("gh", "11-mid-run"));

        yield* ledger.recordSessionHandle(midSession, "cursor-mid");
        assert.strictEqual(sessionHandle(yield* ledger.getSession(midSession)), "cursor-mid");

        const inFlight = yield* ledger.getRun(id);
        assert.strictEqual(inFlight?.session, "sess-mid");
        assert.strictEqual(inFlight?.status, "running");
        assert.isNull(inFlight?.endedAtMillis);

        const byBranch = yield* ledger.latestRunByBranch("gh", "11-mid-run");
        assert.strictEqual(byBranch?.id, id);
      }),
    );

    it.effect("folds a session's events across every run that shares it", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        yield* ledger.insertSession(sessionRecord({ id: foldSession }));
        yield* ledger.insertRun(record("sess-first", 8000, { branch: "22-two-runs", session: foldSession }));
        yield* ledger.insertRun(record("sess-second", 9000, { branch: "22-two-runs", session: foldSession }));
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

        assert.strictEqual(yield* ledger.sessionForBranch("gh", "22-two-runs"), foldSession);
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
        const ledgerPath = yield* TestLedgerPath;
        yield* ledger.insertRun(
          record("resolve-old-done", 1000, {
            workItem: resolveItem,
            status: "succeeded",
            endedAtMillis: 1500,
          }),
        );
        yield* ledger.insertRun(record("resolve-running", 2000, { workItem: resolveItem }));
        yield* insertRunsBulk(
          ledgerPath,
          Array.from({ length: 60 }, (_, index) =>
            record(`resolve-other-${index}`, 3000 + index, {
              workItem: resolveOther,
              status: "succeeded",
              endedAtMillis: 3001 + index,
            }),
          ),
        );

        const byHash = yield* ledger.resolveWatchTarget("#202");
        const byBare = yield* ledger.resolveWatchTarget("202");
        assert.strictEqual(byHash?.id, "resolve-running");
        assert.strictEqual(byBare?.id, "resolve-running");
      }),
    );

    it.effect("resolves nothing for a work item that has never run", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        assert.isNull(yield* ledger.resolveWatchTarget("#404"));
      }),
    );
  });
});

describe("sqlite RunLedger migration", () => {
  it.effect("reads a run left at the retired blocked status as exhausted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-ledger-retired-" });
      const ledgerPath = path.join(dir, "runs.db");
      yield* insertRunAt(ledgerPath, record("retired-1", 1000));
      yield* writeRetiredStatus(ledgerPath);
      const [summary] = yield* listRunsAt(ledgerPath);
      assert.isDefined(summary);
      assert.strictEqual(summary?.status, "exhausted");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
