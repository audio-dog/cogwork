import { Effect, Match } from "effect";

declare const value: string;

export const handled = Match.value(value).pipe(
  Match.when("ready", () => 1),
  Match.orElse(() => 0),
  Effect.succeed,
  Effect.map(String),
);
