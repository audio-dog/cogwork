import * as Effect from "effect/Effect";

export const value = Effect.succeed(1).pipe(Effect.map((number) => number + 1));
