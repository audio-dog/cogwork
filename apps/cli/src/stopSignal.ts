import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";

const stopSignals = ["SIGINT", "SIGTERM"] as const;

export const stopSignalTracker = () => {
  const armed = Latch.makeUnsafe(false);
  const aborted = Latch.makeUnsafe(false);
  return {
    onSignal: () => {
      const latch = armed.isOpen() ? aborted : armed;
      latch.openUnsafe();
    },
    abort: aborted.await,
  } as const;
};

const listen = () => {
  const tracker = stopSignalTracker();
  for (const signal of stopSignals) process.on(signal, tracker.onSignal);
  return tracker;
};

export const secondStopSignal = Effect.acquireRelease(Effect.sync(listen), (tracker) =>
  Effect.sync(() => {
    for (const signal of stopSignals) process.removeListener(signal, tracker.onSignal);
  }),
).pipe(Effect.map((tracker) => tracker.abort));
