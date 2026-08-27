import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ContextFsError extends Schema.TaggedError<ContextFsError>()("ContextFsError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const unavailable = Effect.fn("ContextFs.unavailable")(function* (operation: string) {
  return yield* new ContextFsError({ operation, message: "context fs adapter not provided" });
});

const makeUnavailable = () => ({
  readFile: (target: string): Effect.Effect<string | null, ContextFsError> => unavailable(`read ${target}`),
  readDirectory: (target: string): Effect.Effect<ReadonlyArray<string>, ContextFsError> =>
    unavailable(`read directory ${target}`),
  copyDirectory: (source: string, dest: string): Effect.Effect<void, ContextFsError> =>
    unavailable(`copy ${source} to ${dest}`),
});

export type ContextFsService = ReturnType<typeof makeUnavailable>;

export class ContextFs extends Context.Service<ContextFs, ContextFsService>()(
  "@cogwork/engine/context-fs/ContextFs",
) {}
