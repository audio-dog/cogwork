import { Effect } from "effect";

export const recovered = Effect.succeed(1).pipe(
  Effect.flatMap((value) => Effect.succeed(value + 1)),
  Effect.orElse(() => Effect.succeed(0)),
);
