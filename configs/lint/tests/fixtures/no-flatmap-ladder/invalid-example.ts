import { Effect } from "effect";

export const value = Effect.flatMap(Effect.flatMap(Effect.succeed(1)));
