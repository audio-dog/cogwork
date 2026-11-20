import { type RunRecord, refOfKey } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { Coordination } from "./coordination";
import { RunLedger } from "./run-ledger";

const maxConsecutiveCrashes = 3;

const recoverItem = Effect.fn("CrashRecovery.recoverItem")(function* (run: RunRecord) {
  const ledger = yield* RunLedger;
  const coordination = yield* Coordination;
  yield* ledger.crashRunning(run.workspace, run.workItem, yield* Clock.currentTimeMillis);
  const ref = refOfKey(run.workItem);
  if (ref === null) {
    return yield* Effect.logWarning("crashed Run names no coordinated item", {
      run: run.id,
      item: run.workItem,
    });
  }
  const view = yield* coordination.read(ref);
  const claim = view.claimedByUs ? view.claim : null;
  if (claim !== null) yield* coordination.release(ref, claim);
  const crashes = yield* ledger.consecutiveCrashes(run.workspace, run.workItem, view.barrierAtMillis);
  if (crashes < maxConsecutiveCrashes) return;
  yield* coordination.park(
    ref,
    { _tag: "Exhausted", reason: `The daemon stopped during ${crashes} Runs in a row.` },
    claim?.operation,
  );
});

export const recoverCrashedRuns = Effect.fn("CrashRecovery.recoverCrashedRuns")(function* () {
  const ledger = yield* RunLedger;
  const running = yield* ledger.runningRuns;
  const byItem = new Map(running.map((run) => [`${run.workspace}\u0000${run.workItem}`, run] as const));
  yield* Effect.forEach(
    byItem.values(),
    (run) =>
      recoverItem(run).pipe(
        Effect.catchTag("CoordinationError", (error) =>
          Effect.logWarning("crashed Run recovery failed", { run: run.id, message: error.message }),
        ),
      ),
    { discard: true },
  );
});
