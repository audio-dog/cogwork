import { Effect } from "effect";

export const recovered = Effect.orElse(
  Effect.succeed(1).pipe(Effect.flatMap((value) => Effect.succeed(value + 1))),
  () => Effect.succeed(0),
);
