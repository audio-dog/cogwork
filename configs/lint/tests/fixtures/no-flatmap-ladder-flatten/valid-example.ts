import { Effect } from "effect";

const staged = Effect.flatMap(Effect.succeed(1), (count) => Effect.succeed(count + 1));
export const value = staged;
