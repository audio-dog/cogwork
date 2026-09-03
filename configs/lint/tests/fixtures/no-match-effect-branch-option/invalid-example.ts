import { Effect, Option } from "effect";

export const describe = (name: Option.Option<string>) =>
  Option.match(name, {
    onNone: () => Effect.succeed("anonymous"),
    onSome: (value) => Effect.flatMap(Effect.succeed(value), (label) => Effect.succeed(label)),
  });
