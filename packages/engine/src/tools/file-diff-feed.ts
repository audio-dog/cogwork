import type { AgUiEvent } from "@cogwork/contracts";
import { DEFAULT_WORKSPACE_ROOT, type ExecResult, type SandboxFileEvent } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { type ToolError, toolError } from "./errors";
import type { WorktreeSandbox } from "./sandbox";

export const FILE_DIFF_EVENT = "sandbox.file.diff";
const diffCommandDeadline = "5 minutes";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const relTo = (path: string) =>
  path.startsWith(`${DEFAULT_WORKSPACE_ROOT}/`) ? path.slice(DEFAULT_WORKSPACE_ROOT.length + 1) : path;

const execFailure = (command: string, rel: string, result: ExecResult) =>
  toolError(
    "exec-failed",
    `${command} exited ${result.exitCode}${result.stderr === "" ? "" : `: ${result.stderr.trim()}`}`,
    rel,
  );

const synthesizeAddPatch = (rel: string, content: string) => {
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;
  if (content === "") return header;
  const hasFinalNewline = content.endsWith("\n");
  const lines = content.replace(/\n$/, "").split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  const tail = hasFinalNewline ? "\n" : "\n\\ No newline at end of file\n";
  return `${header}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}${tail}`;
};

const exec = (sandbox: WorktreeSandbox, command: string): Effect.Effect<ExecResult, ToolError> =>
  Effect.tryPromise({
    try: (signal) => sandbox.handle.process.exec(command, { signal }),
    catch: (cause) => toolError("exec-failed", `diff command failed: ${String(cause)}`),
  }).pipe(
    Effect.timeoutOrElse({
      duration: diffCommandDeadline,
      orElse: () => Effect.fail(toolError("timeout", `diff command timed out after ${diffCommandDeadline}`)),
    }),
  );

const currentContent = (sandbox: WorktreeSandbox, path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => sandbox.handle.fs.read(path)).pipe(Effect.orElseSucceed(() => ""));

const trackedAtBase = Effect.fn("Tools.trackedAtBase")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  rel: string,
) {
  const command = `git ls-tree -r --name-only ${quote(baseSha)} -- ${quote(rel)}`;
  const result = yield* exec(sandbox, command);
  if (result.exitCode !== 0) {
    return yield* execFailure(command, rel, result);
  }
  return result.stdout.trim() !== "";
});

const addPatchFromCurrent = Effect.fn("Tools.addPatchFromCurrent")(function* (
  sandbox: WorktreeSandbox,
  rel: string,
  path: string,
) {
  const content = yield* currentContent(sandbox, path);
  return content === "" ? "" : synthesizeAddPatch(rel, content);
});

export const computeDiff = Effect.fn("Tools.computeDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
) {
  const rel = relTo(event.path);
  if (baseSha === "") {
    if (event.type === "delete") return "";
    return yield* addPatchFromCurrent(sandbox, rel, event.path);
  }
  const diffCommand = `git diff ${quote(baseSha)} -- ${quote(rel)}`;
  const diffed = yield* exec(sandbox, diffCommand);
  if (diffed.exitCode !== 0) {
    return yield* execFailure(diffCommand, rel, diffed);
  }
  if (diffed.stdout !== "") return diffed.stdout;
  if (event.type === "delete") return "";
  return (yield* trackedAtBase(sandbox, baseSha, rel))
    ? ""
    : yield* addPatchFromCurrent(sandbox, rel, event.path);
});

export const fileDiffEvent = (path: string, diff: string): AgUiEvent => ({
  type: "CUSTOM",
  name: FILE_DIFF_EVENT,
  value: { path, diff },
});

export const toFileDiffEvent = Effect.fn("Tools.toFileDiffEvent")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
) {
  const diff = yield* computeDiff(sandbox, baseSha, event);
  return diff === "" ? null : fileDiffEvent(relTo(event.path), diff);
});

const IGNORED_SEGMENTS = [".git", "node_modules", ".repos"];

const ignored = (rel: string) => rel.split("/").some((segment) => IGNORED_SEGMENTS.includes(segment));

// FileSystem.watch reports paths relative to the watched root, and its
// create/remove classification stats them against the process cwd, so it
// cannot be trusted here. The diff pipeline only distinguishes "gone" from
// "present", which the sandbox handle answers correctly; timestamp is never
// read downstream.
const classifyWorktreeEvent = Effect.fn("Tools.classifyWorktreeEvent")(function* (
  sandbox: WorktreeSandbox,
  rel: string,
) {
  const path = `${DEFAULT_WORKSPACE_ROOT}/${rel}`;
  const exists = yield* Effect.tryPromise(() => sandbox.handle.fs.exists(path)).pipe(
    Effect.orElseSucceed(() => false),
  );
  return { type: exists ? "change" : "delete", path, timestamp: 0 } satisfies SandboxFileEvent;
});

// Watching rides Effect's FileSystem so a watcher failure — e.g. macOS
// FSEvents denied under a Codex seatbelt sandbox, surfaced as an async
// EMFILE — lands on the typed error channel instead of crashing the process.
// The caller already degrades a failed feed to "no live diffs".
export const watchWorktreeDiffs = (
  sandbox: WorktreeSandbox,
  baseSha: string,
): Stream.Stream<AgUiEvent, ToolError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.map((fs) =>
      fs.watch(sandbox.root, { recursive: true }).pipe(
        Stream.mapError((error) => toolError("exec-failed", `file watcher failed: ${error.message}`)),
        Stream.filter((event) => !ignored(event.path)),
        Stream.mapEffect((event) => classifyWorktreeEvent(sandbox, event.path)),
        Stream.mapEffect((event) => toFileDiffEvent(sandbox, baseSha, event)),
        Stream.filter((event): event is AgUiEvent => event !== null),
      ),
    ),
    Stream.unwrap,
  );
