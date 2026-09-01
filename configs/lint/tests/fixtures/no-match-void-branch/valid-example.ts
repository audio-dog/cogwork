import { Effect, Match } from "effect";

export const fallback = Match.orElse(() => Effect.succeed("ready"));
