import { type BranchName, sessionHandle, type WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { RunLedger } from "./run-ledger";
import {
  branchName,
  harness,
  laterSession,
  layerMemory,
  otherWorkspace,
  record,
  runId,
  session,
  sessionRecord,
  workspace,
} from "./run-ledger-fixtures";

describe("RunLedger (memory)", () => {
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
});
