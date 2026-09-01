import { pipe } from "effect";

export const build = (value: number) => {
  const fragment = pipe(value, String);
  return pipe(fragment, Array.of);
};
