import { Effect } from "effect";

export const value = Effect.gen(function* () {
  const number = yield* Effect.succeed(1);
  return number + 1;
});
