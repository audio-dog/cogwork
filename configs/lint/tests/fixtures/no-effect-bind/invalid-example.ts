import { Effect } from "effect";

export const withValue = Effect.bind("value", () => Effect.succeed(1));
