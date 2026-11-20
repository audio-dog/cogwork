import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import { InterruptStore, layer, make } from "./interrupt-store";

const record = (
  interruptId: string,
  requestedAt: number,
  overrides: { runId?: string; threadId?: string } = {},
) => ({
  interruptId,
  runId: overrides.runId ?? "run-1",
  threadId: overrides.threadId ?? "thread-1",
  requestedAt,
  payload: {},
});

describe("InterruptStore", () => {
  it.effect("creates a pending interrupt and lists it for its thread and run", () =>
    Effect.gen(function* () {
      const store = yield* InterruptStore;
      yield* store.create(record("i1", 10));

      const stored = yield* store.get("i1");
      assert.strictEqual(stored?.status, "pending");
      assert.deepStrictEqual(
        (yield* store.listPending("thread-1")).map((r) => r.interruptId),
        ["i1"],
      );
      assert.deepStrictEqual(
        (yield* store.listPendingByRun("run-1")).map((r) => r.interruptId),
        ["i1"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("orders a thread's interrupts by requestedAt ascending", () =>
    Effect.gen(function* () {
      const store = yield* InterruptStore;
      yield* store.create(record("late", 30));
      yield* store.create(record("early", 10));
      yield* store.create(record("mid", 20));

      assert.deepStrictEqual(
        (yield* store.list("thread-1")).map((r) => r.interruptId),
        ["early", "mid", "late"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("resolves an interrupt, dropping it from the pending list", () =>
    Effect.gen(function* () {
      const store = yield* InterruptStore;
      yield* store.create(record("i1", 10));
      yield* TestClock.setTime(1234);
      yield* store.resolve("i1", { approved: true });

      const stored = yield* store.get("i1");
      assert.strictEqual(stored?.status, "resolved");
      assert.deepStrictEqual(stored?.response, { approved: true });
      assert.strictEqual(stored?.resolvedAt, 1234);
      assert.lengthOf(yield* store.listPending("thread-1"), 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("cancels an interrupt", () =>
    Effect.gen(function* () {
      const store = yield* InterruptStore;
      yield* store.create(record("i1", 10));
      yield* store.cancel("i1");

      assert.strictEqual((yield* store.get("i1"))?.status, "cancelled");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never clobbers a resolved interrupt back to pending on a duplicate create", () =>
    Effect.gen(function* () {
      const store = yield* InterruptStore;
      yield* store.create(record("i1", 10));
      yield* store.resolve("i1");
      yield* store.create(record("i1", 10));

      assert.strictEqual((yield* store.get("i1"))?.status, "resolved");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drops pending interrupts when its process-scoped store is rebuilt", () =>
    Effect.gen(function* () {
      const previous = yield* InterruptStore;
      yield* previous.create(record("pending", 10));
      assert.lengthOf(yield* previous.listPending("thread-1"), 1);

      const current = yield* make;
      assert.lengthOf(yield* current.listPending("thread-1"), 0);
    }).pipe(Effect.provide(layer)),
  );
});
