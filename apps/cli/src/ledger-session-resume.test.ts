import { type BranchName, sessionHandle, type WorkspaceId } from "@cogwork/contracts";
import { RunLedger } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  bootedLedgerLayer,
  branchName,
  foldSession,
  harness,
  LedgerLogProbe,
  midSession,
  otherWorkspace,
  ownedSession,
  replacementSession,
  record,
  runId,
  session,
  sessionRecord,
  TestStorePath,
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
  });
});
