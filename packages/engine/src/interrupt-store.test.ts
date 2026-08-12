import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeInterruptStore } from "./interrupt-store";

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

describe("makeInterruptStore", () => {
  it.effect("creates a pending interrupt and lists it for its thread and run", () =>
    Effect.gen(function* () {
      const store = makeInterruptStore();
      yield* Effect.promise(() => store.create(record("i1", 10)));

      const stored = yield* Effect.promise(() => store.get("i1"));
      assert.strictEqual(stored?.status, "pending");
      assert.deepStrictEqual(
        (yield* Effect.promise(() => store.listPending("thread-1"))).map((r) => r.interruptId),
        ["i1"],
      );
      assert.deepStrictEqual(
        (yield* Effect.promise(() => store.listPendingByRun("run-1"))).map((r) => r.interruptId),
        ["i1"],
      );
    }),
  );

  it.effect("orders a thread's interrupts by requestedAt ascending", () =>
    Effect.gen(function* () {
      const store = makeInterruptStore();
      yield* Effect.promise(() => store.create(record("late", 30)));
      yield* Effect.promise(() => store.create(record("early", 10)));
      yield* Effect.promise(() => store.create(record("mid", 20)));

      assert.deepStrictEqual(
        (yield* Effect.promise(() => store.list("thread-1"))).map((r) => r.interruptId),
        ["early", "mid", "late"],
      );
    }),
  );

  it.effect("resolves an interrupt, dropping it from the pending list", () =>
    Effect.gen(function* () {
      const store = makeInterruptStore();
      yield* Effect.promise(() => store.create(record("i1", 10)));
      yield* Effect.promise(() => store.resolve("i1", { approved: true }));

      const stored = yield* Effect.promise(() => store.get("i1"));
      assert.strictEqual(stored?.status, "resolved");
      assert.deepStrictEqual(stored?.response, { approved: true });
      assert.isNumber(stored?.resolvedAt);
      assert.lengthOf(yield* Effect.promise(() => store.listPending("thread-1")), 0);
    }),
  );

  it.effect("cancels an interrupt", () =>
    Effect.gen(function* () {
      const store = makeInterruptStore();
      yield* Effect.promise(() => store.create(record("i1", 10)));
      yield* Effect.promise(() => store.cancel("i1"));

      assert.strictEqual((yield* Effect.promise(() => store.get("i1")))?.status, "cancelled");
    }),
  );

  it.effect("never clobbers a resolved interrupt back to pending on a duplicate create", () =>
    Effect.gen(function* () {
      const store = makeInterruptStore();
      yield* Effect.promise(() => store.create(record("i1", 10)));
      yield* Effect.promise(() => store.resolve("i1"));
      yield* Effect.promise(() => store.create(record("i1", 10)));

      assert.strictEqual((yield* Effect.promise(() => store.get("i1")))?.status, "resolved");
    }),
  );
});
