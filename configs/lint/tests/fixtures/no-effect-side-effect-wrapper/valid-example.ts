import { Effect } from "effect";

export const saved = Effect.logInfo("saved").pipe(Effect.map(() => "saved"));
