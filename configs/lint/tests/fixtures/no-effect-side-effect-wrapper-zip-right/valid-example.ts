import { Effect } from "effect";

export const saved = Effect.tap(Effect.succeed("saved"), (label) => Effect.sync(() => console.info(label)));
