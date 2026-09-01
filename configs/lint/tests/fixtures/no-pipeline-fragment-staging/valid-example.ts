import { pipe } from "effect";

export const build = (value: number) => pipe(value, String, Array.of);
