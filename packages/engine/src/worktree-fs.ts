import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorktreeFsError extends Schema.TaggedError<WorktreeFsError>()("WorktreeFsError", {
  operation: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export interface FileStat {
  readonly mtimeMillis: number;
}

export interface WorktreeFsService {
  readonly linkFile: (target: string, linkPath: string) => Effect.Effect<void, WorktreeFsError>;
  readonly removeDebris: (root: string, target: string) => Effect.Effect<boolean, WorktreeFsError>;
  readonly runCommand: (cwd: string, command: string) => Effect.Effect<void, WorktreeFsError>;
  readonly stat: (target: string) => Effect.Effect<FileStat | null, WorktreeFsError>;
}

export class WorktreeFs extends Context.Service<WorktreeFs, WorktreeFsService>()(
  "@cogwork/engine/worktree-fs/WorktreeFs",
) {}
