import { Effect } from "effect";

export const value = Effect.succeed(1).pipe(
  Effect.flatMap((number) => Effect.succeed(number + 1)),
  Effect.map(String),
);
