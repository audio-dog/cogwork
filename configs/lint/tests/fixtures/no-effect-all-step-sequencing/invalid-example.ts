import { Effect } from "effect";

export const logged = Effect.all([Effect.logInfo("ready")], { concurrency: 1 });
