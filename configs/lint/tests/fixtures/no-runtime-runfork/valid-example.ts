import { Effect } from "effect";

export const fiber = Effect.succeed("scoped").pipe(Effect.forkScoped);
