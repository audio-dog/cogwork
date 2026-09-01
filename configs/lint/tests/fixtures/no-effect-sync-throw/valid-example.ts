import { Effect } from "effect";

export const parsed = Effect.try({
  catch: (error) => new Error(String(error)),
  try: () => JSON.parse("{}"),
});
