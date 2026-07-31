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
import { layerMemory, RunLedger } from "./RunLedger";

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
