import { keyOf, LineageId, RunId, type RunRecord, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { Coordination } from "./coordination";
import { harnessName, startHeartbeats, testLayer } from "./daemon-composition-fixtures";
import * as RunLedger from "./run-ledger";

const crashedIssue = {
  _tag: "Issue",
  workspace: WorkspaceId.make("github"),
  id: WorkItemId.make("#1"),
} as const;

const claimCrashedIssue = Effect.fn("DaemonCompositionTest.claimCrashedIssue")(function* () {
  const coordination = yield* Coordination;
  yield* coordination.observe(crashedIssue, "label:needs-triage:1", { _tag: "Unknown" });
  yield* coordination.claim(crashedIssue, {
    operation: { workflow: "coding", operation: "triage" },
    lineage: { root: LineageId.make(keyOf(crashedIssue)), parent: null, hop: 0 },
  });
  yield* TestClock.adjust("1 minute");
});

const issueRun = (id: string, status: RunRecord["status"], startedAtMillis: number) =>
  ({
    id: RunId.make(id),
    workspace: crashedIssue.workspace,
    workItem: WorkItemId.make(keyOf(crashedIssue)),
    operation: "triage",
    harness: harnessName,
    branch: null,
    session: null,
    usage: null,
    status,
    startedAtMillis,
    endedAtMillis: status === "running" ? null : startedAtMillis,
  }) satisfies RunRecord;

describe("daemon composition", () => {
  it.effect("marks a Run the stopped daemon left running as crashed and releases its Claim", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const coordination = yield* Coordination;
      yield* claimCrashedIssue();
      yield* ledger.insertRun(issueRun("left-running", "running", 1));

      yield* startHeartbeats();

      assert.strictEqual((yield* ledger.getRun(RunId.make("left-running")))?.status, "crashed");
      const view = yield* coordination.read(crashedIssue);
      assert.isNull(view.claim);
      assert.isNull(view.park);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("parks an item exhausted after its third Run in a row dies with the daemon", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* claimCrashedIssue();
      yield* ledger.insertRun(issueRun("first-crash", "crashed", 1));
      yield* ledger.insertRun(issueRun("second-crash", "crashed", 2));
      yield* ledger.insertRun(issueRun("left-running", "running", 3));

      yield* startHeartbeats();

      const view = yield* (yield* Coordination).read(crashedIssue);
      assert.strictEqual(view.park?.reason._tag, "Exhausted");
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );
});
