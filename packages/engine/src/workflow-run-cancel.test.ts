import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { cancelRun } from "./commands";
import { RunLedger } from "./run-ledger";
import { admission } from "./workflow-run-admissions-fixtures";
import { requirements, resultEvent, testProgram } from "./workflow-run-fixtures";

const allClear = {
  summary: "All clear",
  stuck: false,
  answers: { done: "yes" },
  inputs: { notification: "All clear" },
};

const startGatedRun = Effect.fn("startGatedRun")(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const aborted = yield* Deferred.make<void>();
  const run = () =>
    Stream.fromEffect(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.map(() => resultEvent(allClear)),
        Effect.onInterrupt(() => Deferred.succeed(aborted, undefined)),
      ),
    );
  const program = yield* testProgram([], { run });
  const running = yield* Effect.forkChild(program.runner.execute(admission), { startImmediately: true });
  yield* Deferred.await(started);
  const [record] = yield* (yield* RunLedger).listRuns(10);
  if (record === undefined) return yield* Effect.die("the Run was not accepted");
  return { ...program, running, record, release, aborted };
});

describe("WorkflowRun cancellation", () => {
  it.effect("CancelRun stops the Run, parks the item with the note, and runs no Workflow action", () =>
    Effect.gen(function* () {
      const { running, record, release, aborted, coordination, notifications } = yield* startGatedRun();

      yield* cancelRun({ runId: record.id, note: "Wrong approach" });
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.await(running);

      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.isTrue(yield* Deferred.isDone(aborted));
      assert.isEmpty(yield* Ref.get(coordination.attempts));
      assert.isEmpty(yield* notifications.list);
      assert.deepStrictEqual(
        (yield* Ref.get(coordination.parks)).map(({ reason }) => reason),
        [{ _tag: "Cancelled", note: "Wrong approach" }],
      );
      assert.strictEqual((yield* (yield* RunLedger).getRun(record.id))?.status, "interrupted");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("a daemon drain interrupts the Run without parking the item", () =>
    Effect.gen(function* () {
      const { running, record, aborted, coordination } = yield* startGatedRun();

      yield* Fiber.interrupt(running);

      assert.isTrue(yield* Deferred.isDone(aborted));
      assert.isEmpty(yield* Ref.get(coordination.parks));
      assert.strictEqual((yield* (yield* RunLedger).getRun(record.id))?.status, "interrupted");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("CancelRun on a finished Run reports it finished and does not park the item", () =>
    Effect.gen(function* () {
      const { running, record, release, coordination } = yield* startGatedRun();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);

      const error = yield* cancelRun({ runId: record.id }).pipe(Effect.flip);

      assert.strictEqual(error.reason, "already-finished");
      assert.isEmpty(yield* Ref.get(coordination.parks));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
