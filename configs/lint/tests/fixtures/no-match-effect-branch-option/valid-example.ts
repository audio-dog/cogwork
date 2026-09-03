import { Option } from "effect";

export const describe = (name: Option.Option<string>) =>
  Option.match(name, { onNone: () => "anonymous", onSome: (value) => value });
