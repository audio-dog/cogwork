import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ContextFsError extends Schema.TaggedError<ContextFsError>()("ContextFsError", {
  operation: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export interface ContextFsService {
  readonly directoryExists: (target: string) => Effect.Effect<boolean, ContextFsError>;
  readonly readFile: (target: string) => Effect.Effect<string | null, ContextFsError>;
  readonly readDirectory: (
    target: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<ReadonlyArray<string>, ContextFsError>;
  readonly copyDirectory: (source: string, dest: string) => Effect.Effect<void, ContextFsError>;
  readonly removeDirectory: (target: string) => Effect.Effect<void, ContextFsError>;
}

export class ContextFs extends Context.Service<ContextFs, ContextFsService>()(
  "@cogwork/engine/context-fs/ContextFs",
) {}
