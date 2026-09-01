import { Effect, Match } from "effect";

declare const value: string;

export const handled = Match.value(value).pipe(
  Match.when("ready", () => Effect.succeed(1).pipe(Effect.map(String))),
  Match.orElse(() => Effect.succeed("pending")),
);
