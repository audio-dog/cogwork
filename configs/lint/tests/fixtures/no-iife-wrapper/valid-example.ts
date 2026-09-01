import { Effect } from "effect";

const succeed = (number: number) => Effect.succeed(number);

export const value = succeed(1);
