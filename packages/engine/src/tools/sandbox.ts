import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import { toolError } from "./errors";

const sandboxCommandDeadline = "5 minutes";
const sandboxDestroyDeadline = "5 seconds";
const sandboxLaunchDeadline = "5 minutes";

const hasNoBaseSha = (exitCode: number, stderr: string) =>
  exitCode === 128 &&
  (stderr.includes("not a git repository") || stderr.includes("Needed a single revision"));

export interface WorktreeSandbox {
  readonly handle: SandboxHandle;
  readonly root: string;
}

// Fixed `dir` means teardown never deletes the checkout, only the sandbox handle.
export const openWorktreeSandbox = (root: string) => {
  const provider = localProcessSandbox({ dir: root, passEnv: Object.keys(process.env) });
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) => provider.create({ signal }),
      catch: (cause) => toolError("exec-failed", `failed to open worktree sandbox: ${String(cause)}`, root),
    }).pipe(
      Effect.timeoutOrElse({
        duration: sandboxLaunchDeadline,
        orElse: () =>
          Effect.fail(toolError("timeout", `sandbox launch timed out after ${sandboxLaunchDeadline}`, root)),
      }),
      Effect.map((handle): WorktreeSandbox => ({ handle, root })),
    ),
    ({ handle }) =>
      Effect.tryPromise({
        try: () => handle.destroy(),
        catch: (cause) =>
          toolError("exec-failed", `failed to destroy worktree sandbox: ${String(cause)}`, root),
      }).pipe(Effect.interruptible, Effect.timeout(sandboxDestroyDeadline), Effect.ignore),
    { interruptible: true },
  );
};

export const resolveBaseSha = Effect.fn("Tools.resolveBaseSha")(function* (sandbox: WorktreeSandbox) {
  const result = yield* Effect.tryPromise({
    try: (signal) => sandbox.handle.process.exec("git rev-parse --verify HEAD", { signal }),
    catch: (cause) => toolError("exec-failed", `failed to resolve base SHA: ${String(cause)}`, sandbox.root),
  }).pipe(
    Effect.timeoutOrElse({
      duration: sandboxCommandDeadline,
      orElse: () =>
        Effect.fail(
          toolError("timeout", `base SHA command timed out after ${sandboxCommandDeadline}`, sandbox.root),
        ),
    }),
  );
  if (hasNoBaseSha(result.exitCode, result.stderr)) return "";
  if (result.exitCode !== 0) {
    return yield* toolError(
      "exec-failed",
      `base SHA command exited ${result.exitCode}${result.stderr === "" ? "" : `: ${result.stderr.trim()}`}`,
      sandbox.root,
    );
  }
  return result.stdout.trim();
});
