import { Effect } from "effect";

export const values = Effect.all([Effect.succeed(1), Effect.succeed(2)]);
