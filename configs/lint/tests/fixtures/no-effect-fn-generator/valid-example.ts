import { Effect } from "effect";

export const load = Effect.gen(function* () {
  return yield* Effect.succeed(1);
});
