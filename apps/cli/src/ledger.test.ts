import { DatabaseSync } from "node:sqlite";

import { RunLedger } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import { runLedgerAppendDuration } from "./ledger";
import {
  bareResolveItem,
  bootedLedgerLayer,
  branchName,
  insertRunsBulk,
  LedgerLogProbe,
  missingResolveItem,
  replacementSession,
  record,
  resolveItem,
  resolveOther,
  runId,
  runPlan,
  session,
  TestStorePath,
  triageWorkflow,
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

    it.effect("persists a run and reports its event count and history state", () =>
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
        assert.isNull(storedSummary?.eventsPrunedAtMillis);
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

        const storePath = yield* TestStorePath;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new DatabaseSync(storePath)),
          (sqlite) =>
            Effect.sync(() => sqlite.prepare("UPDATE runs SET events_pruned_at = 3000 WHERE id = ?").run(id)),
          (sqlite) => Effect.sync(() => sqlite.close()),
        );
        assert.strictEqual((yield* ledger.getRunSummary(id))?.eventsPrunedAtMillis, 3000);
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

    it.effect("round-trips a Run's subject and Workflow and keeps them absent when none was given", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.CoreRunLedger;
        const subject = { title: "Fix login", url: "https://github.com/acme/web/issues/7" };
        yield* ledger.insertRun({ ...record("subject-titled", 9200), subject, workflow: triageWorkflow });
        yield* ledger.insertRun(record("subject-absent", 9300));

        const summaries = yield* ledger.listRuns(10);
        const titled = summaries.find((row) => row.id === runId("subject-titled"));
        const absent = summaries.find((row) => row.id === runId("subject-absent")) ?? {};
        assert.deepStrictEqual(titled?.subject, subject);
        assert.strictEqual(titled?.workflow, triageWorkflow);
        assert.isFalse("subject" in absent);
        assert.isFalse("workflow" in absent);
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
