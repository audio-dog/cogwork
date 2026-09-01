import { Effect } from "effect";

export const saved = Effect.as(
  Effect.sync(() => console.info("saved")),
  "saved",
);
