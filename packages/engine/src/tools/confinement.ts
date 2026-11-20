import * as Effect from "effect/Effect";

import { toolError } from "./errors";

const WORKSPACE_PREFIX = "/workspace";

interface Normalized {
  readonly segments: ReadonlyArray<string>;
  readonly escaped: boolean;
}

const stepSegment = (acc: Normalized, segment: string): Normalized => {
  if (acc.escaped || segment === "" || segment === ".") return acc;
  if (segment !== "..") return { segments: [...acc.segments, segment], escaped: false };
  if (acc.segments.length === 0) return { segments: acc.segments, escaped: true };
  return { segments: acc.segments.slice(0, -1), escaped: false };
};

export const confine = Effect.fn("Tools.confine")(function* (requested: string) {
  const stripped = requested.startsWith(WORKSPACE_PREFIX)
    ? requested.slice(WORKSPACE_PREFIX.length)
    : requested;
  const { segments, escaped } = stripped
    .split("/")
    .reduce<Normalized>(stepSegment, { segments: [], escaped: false });
  if (escaped) {
    return yield* toolError("out-of-bounds", `path "${requested}" escapes the worktree root`, requested);
  }
  return segments.join("/");
});
