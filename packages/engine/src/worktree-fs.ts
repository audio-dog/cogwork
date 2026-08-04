import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorktreeFsError extends Schema.TaggedErrorClass<WorktreeFsError>()("WorktreeFsError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface FileStat {
  readonly mtimeMillis: number;
}

const unavailable = Effect.fn("WorktreeFs.unavailable")(function* (operation: string) {
  return yield* new WorktreeFsError({ operation, message: "worktree fs adapter not provided" });
});

const makeUnavailable = () => ({
  linkFile: (_target: string, linkPath: string) => Effect.asVoid(unavailable(`link ${linkPath}`)),
  runCommand: (_cwd: string, command: string) => Effect.asVoid(unavailable(command)),
  stat: (_target: string) => Effect.succeed<FileStat | null>(null),
});

export type WorktreeFsService = ReturnType<typeof makeUnavailable>;

export class WorktreeFs extends Context.Service<WorktreeFs, WorktreeFsService>()(
  "@clanker-forge/engine/worktree-fs/WorktreeFs",
) {}
