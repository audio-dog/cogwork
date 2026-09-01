import { Effect } from "effect";

const increment = Effect.map((value: number) => value + 1);

export const value = Effect.succeed(1).pipe(increment);
