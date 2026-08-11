import type { AgUiEvent } from "@clanker-forge/contracts";
import {
  DEFAULT_WORKSPACE_ROOT,
  type ExecResult,
  type SandboxFileEvent,
  watchWorkspace,
} from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type ToolError, toolError } from "./errors";
import type { WorktreeSandbox } from "./sandbox";

export const FILE_DIFF_EVENT = "sandbox.file.diff";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const relTo = (path: string) =>
  path.startsWith(`${DEFAULT_WORKSPACE_ROOT}/`) ? path.slice(DEFAULT_WORKSPACE_ROOT.length + 1) : path;

const synthesizeAddPatch = (rel: string, content: string) => {
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;
  if (content === "") return header;
  const hasFinalNewline = content.endsWith("\n");
  const lines = content.replace(/\n$/, "").split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  const tail = hasFinalNewline ? "\n" : "\n\\ No newline at end of file\n";
  return `${header}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}${tail}`;
};

const exec = (sandbox: WorktreeSandbox, command: string): Effect.Effect<ExecResult> =>
  Effect.tryPromise(() => sandbox.handle.process.exec(command)).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })),
  );

const currentContent = (sandbox: WorktreeSandbox, path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => sandbox.handle.fs.read(path)).pipe(Effect.orElseSucceed(() => ""));

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
  const diffed = yield* exec(sandbox, `git diff ${quote(baseSha)} -- ${quote(rel)}`);
  if (diffed.exitCode === 0 && diffed.stdout !== "") return diffed.stdout;
  if (event.type === "delete") return "";
  const shown = yield* exec(sandbox, `git show ${quote(baseSha)}:${quote(rel)}`);
  if (shown.exitCode === 0) return "";
  return yield* addPatchFromCurrent(sandbox, rel, event.path);
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

export const watchWorktreeDiffs = (
  sandbox: WorktreeSandbox,
  baseSha: string,
): Stream.Stream<AgUiEvent, ToolError> =>
  Stream.callback<SandboxFileEvent, ToolError>((queue) =>
    Effect.gen(function* () {
      const watcher = yield* Effect.tryPromise({
        try: () =>
          watchWorkspace(sandbox.handle, {
            root: DEFAULT_WORKSPACE_ROOT,
            onEvent: (event) => Queue.offerUnsafe(queue, event),
          }),
        catch: (cause) => toolError("exec-failed", `failed to start file watcher: ${String(cause)}`),
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => watcher.stop()));
    }),
  ).pipe(
    Stream.mapEffect((event) => toFileDiffEvent(sandbox, baseSha, event)),
    Stream.filter((event): event is AgUiEvent => event !== null),
  );
