// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash, type Hash } from "node:crypto";
import { DEFAULT_WORKSPACE_ROOT, type ExecResult, type SandboxFileEvent } from "@tanstack/ai-sandbox";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import { type ToolError, toolError } from "./errors";
import type { WorktreeSandbox } from "./sandbox";

export const fileDiffExecDuration = Metric.timer("cogwork_file_diff_git_diff_exec_duration", {
  description: "Time spent executing git diff for settled file events.",
});
export const fileDiffGitChildren = Metric.counter("cogwork_file_diff_git_children_total", {
  description: "Git child processes started to compute file diffs.",
});
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
const diffCommandDeadline = "5 minutes";
const stderrMaxBytes = 4 * 1024;
const processReleaseDeadline = "5 seconds";
export const gitCommand = "git --literal-pathspecs";
export const gitDiffCommand = `${gitCommand} diff`;

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const relTo = (path: string) =>
  (path.startsWith(`${DEFAULT_WORKSPACE_ROOT}/`)
    ? path.slice(DEFAULT_WORKSPACE_ROOT.length + 1)
    : path
  ).replace(/^(?:\.\/)+/, "");

export const execFailure = (command: string, rel: string, result: ExecResult) =>
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

export const exec = (sandbox: WorktreeSandbox, command: string): Effect.Effect<ExecResult, ToolError> =>
  Metric.update(fileDiffGitChildren, 1).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: (signal) => sandbox.handle.process.exec(command, { signal }),
        catch: (cause) => toolError("exec-failed", `diff command failed: ${String(cause)}`),
      }),
    ),
    Effect.timeoutOrElse({
      duration: diffCommandDeadline,
      orElse: () => Effect.fail(toolError("timeout", `diff command timed out after ${diffCommandDeadline}`)),
    }),
  );

const currentContent = (sandbox: WorktreeSandbox, path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => sandbox.handle.fs.read(path)).pipe(Effect.orElseSucceed(() => ""));

export const trackedAtBase = Effect.fn("Tools.trackedAtBase")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  rel: string,
) {
  const command = `${gitCommand} ls-tree -r --name-only ${quote(baseSha)} -- ${quote(rel)}`;
  const result = yield* exec(sandbox, command);
  if (result.exitCode !== 0) {
    return yield* execFailure(command, rel, result);
  }
  return result.stdout.trim() !== "";
});

export const directoryAtBase = Effect.fn("Tools.directoryAtBase")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  rel: string,
) {
  const command = `${gitCommand} ls-tree ${quote(baseSha)} -- ${quote(rel)}`;
  const result = yield* exec(sandbox, command);
  if (result.exitCode !== 0) {
    return yield* execFailure(command, rel, result);
  }
  return result.stdout.startsWith("040000 tree ");
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
  const diffCommand = `${gitDiffCommand} ${quote(baseSha)} -- ${quote(rel)}`;
  const diffed = yield* exec(sandbox, diffCommand).pipe(Effect.trackDuration(fileDiffExecDuration));
  if (diffed.exitCode !== 0) {
    return yield* execFailure(diffCommand, rel, diffed);
  }
  if (diffed.stdout !== "") return diffed.stdout;
  if (event.type === "delete") return "";
  return (yield* trackedAtBase(sandbox, baseSha, rel))
    ? ""
    : yield* addPatchFromCurrent(sandbox, rel, event.path);
});

const decodeUtf8Prefix = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeUtf8Prefix(bytes.subarray(0, bytes.length - 1));
  }
};

export const boundedDiff = (diff: string) => {
  const bytes = Buffer.from(diff);
  if (bytes.length <= fileDiffMaxBytes) return diff;
  const available = fileDiffMaxBytes - Buffer.byteLength(diffTruncationMarker);
  return `${decodeUtf8Prefix(bytes.subarray(0, available))}${diffTruncationMarker}`;
};

const appendPrefix = (prefix: Uint8Array, chunk: Uint8Array, maxBytes: number) => {
  if (prefix.length >= maxBytes) return prefix;
  return Buffer.concat([prefix, chunk.subarray(0, maxBytes - prefix.length)]);
};

export interface DiffOutput {
  readonly prefix: Uint8Array;
  readonly byteLength: number;
  readonly fingerprint: string;
}

export interface PendingDiffOutput {
  readonly prefix: Uint8Array;
  readonly byteLength: number;
  readonly hash: Hash;
}

export const pendingDiffOutput = () => ({
  prefix: new Uint8Array(),
  byteLength: 0,
  hash: createHash("sha256"),
});

export const appendDiffOutput = (output: PendingDiffOutput, value: string) => {
  const bytes = Buffer.from(value);
  output.hash.update(bytes);
  return {
    prefix: appendPrefix(output.prefix, bytes, fileDiffMaxBytes),
    byteLength: output.byteLength + bytes.length,
    hash: output.hash,
  };
};

export const completeDiffOutput = (output: PendingDiffOutput) => ({
  prefix: output.prefix,
  byteLength: output.byteLength,
  fingerprint: output.hash.digest("base64"),
});

export const nextChunk = <A>(chunks: AsyncIterator<A>) =>
  Effect.tryPromise({
    try: () => chunks.next(),
    catch: (cause) => toolError("exec-failed", `process stream failed: ${String(cause)}`),
  });

const readDiffOutput = (
  chunks: AsyncIterator<string>,
  output: PendingDiffOutput = pendingDiffOutput(),
): Effect.Effect<DiffOutput, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) => {
      if (next.done) return Effect.succeed(completeDiffOutput(output));
      return readDiffOutput(chunks, appendDiffOutput(output, next.value));
    }),
  );

const readStderr = (
  chunks: AsyncIterator<string>,
  prefix: Uint8Array = new Uint8Array(),
): Effect.Effect<string, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) =>
      next.done
        ? Effect.succeed(new TextDecoder().decode(prefix))
        : readStderr(chunks, appendPrefix(prefix, Buffer.from(next.value), stderrMaxBytes)),
    ),
  );

export const readText = (chunks: AsyncIterator<string>, text = ""): Effect.Effect<string, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) => (next.done ? Effect.succeed(text) : readText(chunks, `${text}${next.value}`))),
  );

export const diffFromOutput = (output: DiffOutput) => {
  if (output.byteLength <= fileDiffMaxBytes) return new TextDecoder().decode(output.prefix);
  const available = fileDiffMaxBytes - Buffer.byteLength(diffTruncationMarker);
  return `${decodeUtf8Prefix(output.prefix.subarray(0, available))}${diffTruncationMarker}`;
};

const processCommand = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toolError("exec-failed", `process command failed: ${String(cause)}`),
  });

const acquireProcess = (sandbox: WorktreeSandbox, command: string) =>
  Effect.acquireRelease(
    Metric.update(fileDiffGitChildren, 1).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: (signal) => sandbox.handle.process.spawn(command, { signal }),
          catch: (cause) => toolError("exec-failed", `process command failed: ${String(cause)}`),
        }),
      ),
      Effect.flatMap((process) =>
        Deferred.make<void>().pipe(Effect.map((completed) => ({ process, completed, exit: process.wait() }))),
      ),
    ),
    ({ process, completed, exit }) =>
      Deferred.poll(completed).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              processCommand(() => process.kill("SIGTERM")).pipe(
                Effect.ignore,
                Effect.andThen(processCommand(() => exit).pipe(Effect.interruptible)),
                Effect.timeoutOrElse({
                  duration: processReleaseDeadline,
                  orElse: () =>
                    processCommand(() => process.kill("SIGKILL")).pipe(
                      Effect.ignore,
                      Effect.andThen(processCommand(() => exit).pipe(Effect.interruptible)),
                      Effect.timeout(processReleaseDeadline),
                      Effect.ignore,
                    ),
                }),
                Effect.ignore,
              ),
            onSome: () => Effect.void,
          }),
        ),
      ),
    { interruptible: true },
  );

export const collectProcessOutput = <A>(
  sandbox: WorktreeSandbox,
  command: string,
  readStdout: (chunks: AsyncIterator<string>) => Effect.Effect<A, ToolError>,
  stdin?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { process, completed, exit } = yield* acquireProcess(sandbox, command);
      const input =
        stdin === undefined
          ? Effect.void
          : processCommand(() => process.stdin.write(stdin)).pipe(
              Effect.andThen(processCommand(() => process.stdin.end())),
            );
      const result = yield* Effect.all(
        {
          stdout: readStdout(process.stdout[Symbol.asyncIterator]()),
          stderr: readStderr(process.stderr[Symbol.asyncIterator]()),
          exitCode: processCommand(() => exit),
          input,
        },
        { concurrency: "unbounded" },
      );
      yield* Deferred.succeed(completed, undefined);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: diffCommandDeadline,
      orElse: () =>
        Effect.fail(
          toolError("timeout", `process command timed out after ${diffCommandDeadline}: ${command}`),
        ),
    }),
  );

export const streamDiff = Effect.fn("Tools.streamDiff")(function* (
  sandbox: WorktreeSandbox,
  command: string,
  rel: string,
  acceptedExitCodes: ReadonlySet<number>,
) {
  const result = yield* collectProcessOutput(sandbox, command, (chunks) => readDiffOutput(chunks)).pipe(
    Effect.trackDuration(fileDiffExecDuration),
  );
  if (!acceptedExitCodes.has(result.exitCode)) {
    return yield* execFailure(command, rel, {
      stdout: new TextDecoder().decode(result.stdout.prefix),
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return { diff: diffFromOutput(result.stdout), fingerprint: result.stdout.fingerprint };
});
