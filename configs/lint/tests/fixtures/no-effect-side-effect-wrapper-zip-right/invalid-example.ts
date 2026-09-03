import { Effect } from "effect";

export const saved = Effect.zipRight(
  Effect.sync(() => console.info("saved")),
  "saved",
);
