import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import { toolError } from "./errors";

export interface WorktreeSandbox {
  readonly handle: SandboxHandle;
  readonly root: string;
}

// Fixed `dir` means teardown never deletes the checkout, only the sandbox handle.
export const openWorktreeSandbox = (root: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => localProcessSandbox({ dir: root }).create({}),
      catch: (cause) => toolError("exec-failed", `failed to open worktree sandbox: ${String(cause)}`, root),
    }).pipe(Effect.map((handle): WorktreeSandbox => ({ handle, root }))),
    ({ handle }) => Effect.promise(() => handle.destroy()),
  );

// "" when the checkout is not a git repo — the sentinel computeDiff reads as
// "synthesize an add-patch instead of diffing against a baseline".
export const resolveBaseSha = Effect.fn("Tools.resolveBaseSha")(function* (sandbox: WorktreeSandbox) {
  const result = yield* Effect.promise(() => sandbox.handle.process.exec("git rev-parse HEAD"));
  return result.exitCode === 0 ? result.stdout.trim() : "";
});
