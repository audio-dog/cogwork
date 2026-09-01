import { Effect } from "effect";

export const value = ((number) => Effect.succeed(number))(1);
