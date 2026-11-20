import { toolDefinition } from "@tanstack/ai";
import * as Effect from "effect/Effect";

import type { WorktreeFsError } from "./worktree-fs";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

const maxOutputTailLength = 4_000;

const failedSetup = (error: WorktreeFsError) => ({
  status: "failed" as const,
  command: error.operation,
  exitCode: error.exitCode ?? null,
  outputTail: (error.output ?? error.message).slice(-maxOutputTailLength),
});

type RunPromise = <A>(effect: Effect.Effect<A>, options?: Effect.RunOptions) => Promise<A>;

export const makeWorktreeSetupTool = (setup: Effect.Effect<void, WorktreeFsError>, runPromise: RunPromise) =>
  toolDefinition({
    name: "worktree-setup",
    description:
      "Run the Workspace's configured worktree setup (linked paths, then each setup command, such as a dependency install) in this Run's worktree, outside the sandbox. Call it after a change to a dependency manifest or lockfile. It takes no input.",
    inputSchema,
  }).server((_input, context) =>
    runPromise(
      setup.pipe(
        Effect.match({
          onFailure: failedSetup,
          onSuccess: () => ({ status: "completed" as const }),
        }),
      ),
      { signal: context?.abortSignal },
    ),
  );
