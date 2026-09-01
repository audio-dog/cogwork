import { Effect } from "effect";

export const load = Effect.fn(function* () {
  return yield* Effect.succeed(1);
});
