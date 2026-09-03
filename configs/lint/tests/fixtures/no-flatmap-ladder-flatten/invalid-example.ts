import { Effect } from "effect";

const staged = Effect.flatten(Effect.map(Effect.succeed(1)));
export const value = staged;
