import { Effect } from "effect";

export const value = ((first) => ((second) => second)(first))(Effect.succeed(1));
