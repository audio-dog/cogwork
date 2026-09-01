import { Effect } from "effect";

export const value = Effect.map(Effect.flatMap(Effect.succeed(1)));
