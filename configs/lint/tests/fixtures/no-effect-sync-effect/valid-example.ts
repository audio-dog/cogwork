import { Effect } from "effect";

export const deferred = Effect.suspend(() => Effect.succeed(1));
