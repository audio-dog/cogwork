import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import { stopSignalTracker } from "./stop-signal";

const settled = (abort: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const waiting = yield* Effect.forkChild(Effect.timeoutOption(abort, "1 minute"));
    yield* TestClock.adjust("1 minute");
    return Option.isSome(yield* Fiber.join(waiting));
  });

describe("stopSignalTracker", () => {
  it.effect("keeps waiting after the first stop signal", () =>
    Effect.gen(function* () {
      const tracker = stopSignalTracker();
      tracker.onSignal();
      assert.isFalse(yield* settled(tracker.abort));
    }),
  );

  it.effect("aborts on the second stop signal", () =>
    Effect.gen(function* () {
      const tracker = stopSignalTracker();
      tracker.onSignal();
      tracker.onSignal();
      assert.isTrue(yield* settled(tracker.abort));
    }),
  );
});
