import { Effect } from "effect";

export const parsed = Effect.sync(() => {
  throw new Error("invalid");
});
