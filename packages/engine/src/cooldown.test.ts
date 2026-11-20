import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import * as Cooldown from "./cooldown";

const minute = 60_000;

describe("Cooldown", () => {
  it.effect("opens an initial window", () =>
    Effect.gen(function* () {
      const cooldowns = yield* Cooldown.make;
      const now = yield* Clock.currentTimeMillis;

      const opened = yield* cooldowns.enter("claim");

      assert.deepStrictEqual(opened, { entered: true, retryAtMillis: now + minute });
      assert.strictEqual(yield* cooldowns.heldUntil("claim"), opened.retryAtMillis);
    }),
  );

  it.effect("holds the active window instead of replacing it", () =>
    Effect.gen(function* () {
      const cooldowns = yield* Cooldown.make;
      const now = yield* Clock.currentTimeMillis;
      const opened = yield* cooldowns.enter("claim", 30_000);
      yield* TestClock.adjust("10 seconds");

      const held = yield* cooldowns.enter("claim", 5_000);

      assert.strictEqual(opened.retryAtMillis, now + 30_000);
      assert.deepStrictEqual(held, { entered: false, retryAtMillis: opened.retryAtMillis });
      assert.strictEqual(yield* cooldowns.heldUntil("claim"), opened.retryAtMillis);
    }),
  );

  it.effect("grows fallback windows after each expiry", () =>
    Effect.gen(function* () {
      const cooldowns = yield* Cooldown.make;
      const first = yield* cooldowns.enter("claim");
      yield* TestClock.adjust("1 minute");

      const second = yield* cooldowns.enter("claim");
      yield* TestClock.adjust("2 minutes");
      const third = yield* cooldowns.enter("claim");

      assert.strictEqual(second.retryAtMillis - first.retryAtMillis, 2 * minute);
      assert.strictEqual(third.retryAtMillis - second.retryAtMillis, 4 * minute);
    }),
  );

  it.effect("clears a window and resets its growth", () =>
    Effect.gen(function* () {
      const cooldowns = yield* Cooldown.make;
      const first = yield* cooldowns.enter("claim");
      yield* TestClock.adjust("1 minute");
      yield* cooldowns.enter("claim");

      yield* cooldowns.clear("claim");

      assert.isNull(yield* cooldowns.heldUntil("claim"));
      const reopened = yield* cooldowns.enter("claim");
      assert.strictEqual(reopened.retryAtMillis - first.retryAtMillis, minute);
    }),
  );
});
