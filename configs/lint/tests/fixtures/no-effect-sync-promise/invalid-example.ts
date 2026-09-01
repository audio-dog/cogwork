import { Effect } from "effect";

export const promise = Effect.sync(async () => "ready");
