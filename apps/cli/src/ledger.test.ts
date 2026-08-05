import { DatabaseSync } from "node:sqlite";
import {
  HarnessName,
  RunId,
  type RunRecord,
  SessionId,
  WorkItemId,
  WorkspaceId,
} from "@clanker-forge/contracts";
import { RunLedger } from "@clanker-forge/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { layer as ledgerLayer } from "./ledger";

const runId = Schema.decodeSync(RunId);
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const crashItem = Schema.decodeSync(WorkItemId)("#101");
const resolveItem = Schema.decodeSync(WorkItemId)("#202");
const resolveOther = Schema.decodeSync(WorkItemId)("#303");
const session = Schema.decodeSync(SessionId)("sess-abc");
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

const insertRunAt = (ledgerPath: string, run: RunRecord) =>
  Effect.provide(
    Effect.flatMap(RunLedger.RunLedger, (ledger) => ledger.insertRun(run)),
    ledgerLayer(ledgerPath),
  );

const listRunsAt = (ledgerPath: string) =>
  Effect.provide(
    Effect.flatMap(RunLedger.RunLedger, (ledger) => ledger.listRuns(10)),
    ledgerLayer(ledgerPath),
  );

const writeRetiredStatus = (ledgerPath: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(ledgerPath)),
    (sqlite) => Effect.sync(() => sqlite.exec("UPDATE runs SET status = 'blocked'")),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );

describe("sqlite RunLedger", () => {
  layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "clanker-forge-ledger-" });
      return ledgerLayer(path.join(dir, "runs.db"));
    }).pipe(Layer.unwrap, Layer.provide(NodeServices.layer)),
  )((it) => {
    it.effect("persists a run, its events, and reports a summary with event count", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        const id = runId("happy-1");
        yield* ledger.insertRun(record("happy-1", 1000));
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
        yield* ledger.updateRun(id, {
          status: "succeeded",
          session,
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          endedAtMillis: 2000,
        });

        const summaries = yield* ledger.listRuns(10);
        const summary = summaries.find((row) => row.id === id);
        assert.isDefined(summary);
        assert.strictEqual(summary?.status, "succeeded");
        assert.strictEqual(summary?.eventCount, 2);
        assert.strictEqual(summary?.session, "sess-abc");
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
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertRun(record("order-older", 1000));
        yield* ledger.insertRun(record("order-newer", 5000));
        const summaries = yield* ledger.listRuns(10);
        const ids = summaries
          .map((summary) => summary.id)
          .filter((id) => id === "order-older" || id === "order-newer");
        assert.deepStrictEqual(ids, ["order-newer", "order-older"]);
      }),
    );

    it.effect("returns the most recent session handle for a branch", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        const sessionByBranch = (workspace: string, branch: string) =>
          Effect.map(ledger.latestRunByBranch(workspace, branch), (run) => run?.session ?? null);
        yield* ledger.insertRun(record("branch-1", 1000, { branch: "7-fix-export" }));
        yield* ledger.insertRun(record("branch-2", 3000, { branch: "9-other" }));
        yield* ledger.updateRun(runId("branch-1"), {
          status: "succeeded",
          session,
          usage: null,
          endedAtMillis: 1500,
        });
        assert.strictEqual(yield* sessionByBranch("gh", "7-fix-export"), "sess-abc");
        assert.isNull(yield* sessionByBranch("gh", "9-other"));
        assert.isNull(yield* sessionByBranch("other", "7-fix-export"));
      }),
    );

    it.effect("interrupts runs this daemon started and leaves older or finished ones alone", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertRun(record("interrupt-stale", 3900));
        yield* ledger.insertRun(record("interrupt-running", 4000));
        yield* ledger.insertRun(record("interrupt-done", 4100));
        yield* ledger.updateRun(runId("interrupt-done"), {
          status: "succeeded",
          session,
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

    it.effect("crashes the item's running runs and counts crashes until a success resets them", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
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
        const ledger = yield* RunLedger.RunLedger;
        const sessionByBranch = (branch: string) =>
          Effect.map(ledger.latestRunByBranch("gh", branch), (run) => run?.session ?? null);
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

    it.effect("records a session on a run that has not reached a terminal status", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        const id = runId("in-flight");
        yield* ledger.insertRun(record("in-flight", 7000, { branch: "11-mid-run" }));
        yield* ledger.recordSession(id, session);

        const inFlight = yield* ledger.getRun(id);
        assert.strictEqual(inFlight?.session, "sess-abc");
        assert.strictEqual(inFlight?.status, "running");
        assert.isNull(inFlight?.endedAtMillis);

        const byBranch = yield* ledger.latestRunByBranch("gh", "11-mid-run");
        assert.strictEqual(byBranch?.id, id);
      }),
    );

    it.effect("collapses absent token usage fields to omitted keys", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        const id = runId("usage-partial");
        yield* ledger.insertRun(record("usage-partial", 9000));
        yield* ledger.updateRun(id, {
          status: "succeeded",
          session,
          usage: { inputTokens: 5 },
          endedAtMillis: 9100,
        });

        const summaries = yield* ledger.listRuns(10);
        const summary = summaries.find((row) => row.id === id);
        assert.isDefined(summary);
        assert.deepStrictEqual(summary?.usage, { inputTokens: 5 });
      }),
    );

    it.effect("resolves a watch target by work item, running-first, past the recent-runs window", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertRun(
          record("resolve-old-done", 1000, {
            workItem: resolveItem,
            status: "succeeded",
            endedAtMillis: 1500,
          }),
        );
        yield* ledger.insertRun(record("resolve-running", 2000, { workItem: resolveItem }));
        yield* Effect.forEach(
          Array.from({ length: 60 }, (_, index) => index),
          (index) =>
            ledger.insertRun(
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
        const ledger = yield* RunLedger.RunLedger;
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
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "clanker-forge-ledger-retired-" });
      const ledgerPath = path.join(dir, "runs.db");
      yield* insertRunAt(ledgerPath, record("retired-1", 1000));
      yield* writeRetiredStatus(ledgerPath);
      const [summary] = yield* listRunsAt(ledgerPath);
      assert.isDefined(summary);
      assert.strictEqual(summary?.status, "exhausted");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
