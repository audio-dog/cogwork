import { keyOf, LineageId, type WorkItemRef } from "@cogwork/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import type { CoordinationService } from "./coordination";

export const verifyCoordinationContract = (coordination: CoordinationService, ref: WorkItemRef) =>
  Effect.gen(function* () {
    const operation = { workflow: "workflow", operation: "operate" };
    const siblingOperation = { workflow: "workflow", operation: "verify" };
    const lineage = { root: LineageId.make(keyOf(ref)), parent: null, hop: 0 };
    const afterRetryDelay = 60_000;
    assert.strictEqual((yield* coordination.read(ref)).gate(operation)._tag, "Open");

    const claim = yield* coordination.claim(ref, { operation, lineage });
    assert.deepStrictEqual((yield* coordination.read(ref)).claim, claim);
    const duplicate = yield* Effect.result(coordination.claim(ref, { operation, lineage }));
    assert.isTrue(Result.isFailure(duplicate) && duplicate.failure.reason === "claim-held");

    yield* TestClock.setTime(1);
    const attempted = yield* coordination.recordAttempt(ref, {
      operation,
      outcome: "failed",
      lineage,
    });
    assert.strictEqual(attempted.counters(operation).consecutiveFailures, 1);

    yield* coordination.release(ref, claim);
    yield* TestClock.setTime(2);
    const parked = yield* coordination.park(ref, { _tag: "Stuck", summary: "needs a person" }, operation);
    assert.strictEqual(parked.gate(operation)._tag, "Parked");
    assert.strictEqual(parked.gate(siblingOperation)._tag, "Open");

    yield* TestClock.setTime(3);
    const siblingClaim = yield* coordination.claim(ref, { operation: siblingOperation, lineage });
    yield* coordination.release(ref, siblingClaim);
    assert.strictEqual((yield* coordination.read(ref)).gate(operation)._tag, "Parked");

    yield* TestClock.setTime(afterRetryDelay + 4);
    const clearingClaim = yield* coordination.claim(ref, { operation, lineage });
    yield* coordination.release(ref, clearingClaim);
    assert.strictEqual((yield* coordination.read(ref)).gate(operation)._tag, "Open");

    yield* TestClock.setTime(afterRetryDelay + 5);
    const laterSiblingClaim = yield* coordination.claim(ref, { operation: siblingOperation, lineage });
    yield* coordination.release(ref, laterSiblingClaim);
    assert.strictEqual((yield* coordination.read(ref)).gate(operation)._tag, "Open");

    yield* TestClock.setTime(afterRetryDelay + 6);
    yield* coordination.park(ref, { _tag: "Stuck", summary: "still needs a person" });
    yield* TestClock.setTime(afterRetryDelay + 7);
    const handedBack = yield* coordination.handBack(ref, { by: "person", note: "try again" });
    assert.strictEqual(handedBack.gate(operation)._tag, "Open");
    assert.strictEqual(handedBack.counters(operation).consecutiveFailures, 0);

    const stale = yield* Effect.result(coordination.release(ref, claim));
    assert.isTrue(Result.isFailure(stale) && stale.failure.reason === "stale-claim");
  });
