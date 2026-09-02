import { createHash, type Hash } from "node:crypto";
import type { AgUiEvent } from "@cogwork/contracts";
import { DEFAULT_WORKSPACE_ROOT, type ExecResult, type SandboxFileEvent } from "@tanstack/ai-sandbox";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { type ToolError, toolError } from "./errors";
import type { WorktreeSandbox } from "./sandbox";

export const FILE_DIFF_EVENT = "sandbox.file.diff";
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
const diffCommandDeadline = "5 minutes";
const diffDebounce = "250 millis";
const debouncedPathConcurrency = 32;
const configuredIgnoreBatchSize = 256;
const configuredIgnoreWindow = "50 millis";
const stderrMaxBytes = 4 * 1024;
const processReleaseDeadline = "5 seconds";

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

const decodeUtf8Prefix = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeUtf8Prefix(bytes.subarray(0, bytes.length - 1));
  }
};

const boundedDiff = (diff: string) => {
  const bytes = Buffer.from(diff);
  if (bytes.length <= fileDiffMaxBytes) return diff;
  const available = fileDiffMaxBytes - Buffer.byteLength(diffTruncationMarker);
  return `${decodeUtf8Prefix(bytes.subarray(0, available))}${diffTruncationMarker}`;
};

const appendPrefix = (prefix: Uint8Array, chunk: Uint8Array, maxBytes: number) => {
  if (prefix.length >= maxBytes) return prefix;
  return Buffer.concat([prefix, chunk.subarray(0, maxBytes - prefix.length)]);
};

interface DiffOutput {
  readonly prefix: Uint8Array;
  readonly byteLength: number;
  readonly fingerprint: string;
}

const readDiffOutput = (
  chunks: AsyncIterator<string>,
  hash: Hash,
  prefix: Uint8Array = new Uint8Array(),
  byteLength = 0,
): Effect.Effect<DiffOutput, ToolError> =>
  Effect.tryPromise({
    try: () => chunks.next(),
    catch: (cause) => toolError("exec-failed", `process stream failed: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((next) => {
      if (next.done) {
        return Effect.succeed({ prefix, byteLength, fingerprint: hash.digest("base64") });
      }
      const bytes = Buffer.from(next.value);
      hash.update(bytes);
      return readDiffOutput(
        chunks,
        hash,
        appendPrefix(prefix, bytes, fileDiffMaxBytes),
        byteLength + bytes.length,
      );
    }),
  );

const readStderr = (
  chunks: AsyncIterator<string>,
  prefix: Uint8Array = new Uint8Array(),
): Effect.Effect<string, ToolError> =>
  Effect.tryPromise({
    try: () => chunks.next(),
    catch: (cause) => toolError("exec-failed", `process stream failed: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((next) =>
      next.done
        ? Effect.succeed(new TextDecoder().decode(prefix))
        : readStderr(chunks, appendPrefix(prefix, Buffer.from(next.value), stderrMaxBytes)),
    ),
  );

const readText = (chunks: AsyncIterator<string>, text = ""): Effect.Effect<string, ToolError> =>
  Effect.tryPromise({
    try: () => chunks.next(),
    catch: (cause) => toolError("exec-failed", `process stream failed: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((next) => (next.done ? Effect.succeed(text) : readText(chunks, `${text}${next.value}`))),
  );

const diffFromOutput = (output: DiffOutput) => {
  if (output.byteLength <= fileDiffMaxBytes) return new TextDecoder().decode(output.prefix);
  const available = fileDiffMaxBytes - Buffer.byteLength(diffTruncationMarker);
  return `${decodeUtf8Prefix(output.prefix.subarray(0, available))}${diffTruncationMarker}`;
};

const acquireProcess = (sandbox: WorktreeSandbox, command: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) => sandbox.handle.process.spawn(command, { signal }),
      catch: (cause) => toolError("exec-failed", `process command failed: ${String(cause)}`),
    }).pipe(
      Effect.flatMap((process) =>
        Deferred.make<void>().pipe(Effect.map((completed) => ({ process, completed, exit: process.wait() }))),
      ),
    ),
    ({ process, completed, exit }) =>
      Deferred.poll(completed).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.tryPromise(() => process.kill("SIGTERM")).pipe(
                Effect.ignore,
                Effect.andThen(Effect.tryPromise(() => exit)),
                Effect.timeoutOrElse({
                  duration: processReleaseDeadline,
                  orElse: () =>
                    Effect.tryPromise(() => process.kill("SIGKILL")).pipe(
                      Effect.ignore,
                      Effect.andThen(Effect.tryPromise(() => exit)),
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
  );

const streamDiff = Effect.fn("Tools.streamDiff")(function* (
  sandbox: WorktreeSandbox,
  command: string,
  rel: string,
  acceptedExitCodes: ReadonlySet<number>,
) {
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const { process, completed, exit } = yield* acquireProcess(sandbox, command);
      const collected = yield* Effect.all(
        {
          stdout: readDiffOutput(process.stdout[Symbol.asyncIterator](), createHash("sha256")),
          stderr: readStderr(process.stderr[Symbol.asyncIterator]()),
          exitCode: Effect.tryPromise({
            try: () => exit,
            catch: (cause) => toolError("exec-failed", `process command failed: ${String(cause)}`),
          }),
        },
        { concurrency: "unbounded" },
      );
      yield* Deferred.succeed(completed, undefined);
      return collected;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: diffCommandDeadline,
      orElse: () => Effect.fail(toolError("timeout", `diff command timed out after ${diffCommandDeadline}`)),
    }),
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

export const fileDiffEvent = (path: string, diff: string): AgUiEvent => ({
  type: "CUSTOM",
  name: FILE_DIFF_EVENT,
  value: { path, diff: boundedDiff(diff) },
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

const debounceByPath = <E, R>(stream: Stream.Stream<FileSystem.WatchEvent, E, R>) =>
  stream.pipe(
    Stream.groupByKey((event) => event.path, { idleTimeToLive: diffDebounce }),
    Stream.flatMap(([, events]) => events.pipe(Stream.debounce(diffDebounce)), {
      concurrency: debouncedPathConcurrency,
    }),
  );

const configuredIgnoredEvents = Effect.fn("Tools.configuredIgnoredEvents")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  events: ReadonlyArray<FileSystem.WatchEvent>,
) {
  if (baseSha === "") return events;
  const paths = events.map((event) => event.path);
  const command = "git check-ignore -z --stdin";
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const { process, completed, exit } = yield* acquireProcess(sandbox, command);
      const collected = yield* Effect.all(
        {
          stdout: readText(process.stdout[Symbol.asyncIterator]()),
          stderr: readStderr(process.stderr[Symbol.asyncIterator]()),
          exitCode: Effect.tryPromise({
            try: () => exit,
            catch: (cause) => toolError("exec-failed", `process command failed: ${String(cause)}`),
          }),
          input: Effect.tryPromise({
            try: () => process.stdin.write(`${paths.join("\0")}\0`),
            catch: (cause) => toolError("exec-failed", `process command failed: ${String(cause)}`),
          }).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => process.stdin.end(),
                catch: (cause) => toolError("exec-failed", `process command failed: ${String(cause)}`),
              }),
            ),
          ),
        },
        { concurrency: "unbounded" },
      );
      yield* Deferred.succeed(completed, undefined);
      return collected;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: diffCommandDeadline,
      orElse: () =>
        Effect.fail(toolError("timeout", `ignore command timed out after ${diffCommandDeadline}`)),
    }),
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return yield* execFailure(command, paths[0] ?? "", result);
  }
  const ignoredPaths = new Set(result.stdout.split("\0").filter((path) => path !== ""));
  return events.filter((event) => !ignoredPaths.has(event.path));
});

interface FileDiff {
  readonly path: string;
  readonly diff: string;
  readonly fingerprint: string;
}

const emptyDiff = () => ({
  diff: "",
  fingerprint: createHash("sha256").digest("base64"),
});

const streamAddPatch = (sandbox: WorktreeSandbox, rel: string) =>
  streamDiff(sandbox, `git diff --no-index -- /dev/null ${quote(rel)}`, rel, new Set([0, 1]));

const computeFileDiff = Effect.fn("Tools.computeFileDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
) {
  const path = relTo(event.path);
  if (event.type === "delete" && baseSha === "") return { path, ...emptyDiff() };
  if (baseSha === "") return { path, ...(yield* streamAddPatch(sandbox, path)) };
  const command = `git diff ${quote(baseSha)} -- ${quote(path)}`;
  const trackedDiff = yield* streamDiff(sandbox, command, path, new Set([0]));
  if (trackedDiff.diff !== "") return { path, ...trackedDiff };
  if (event.type === "delete") return { path, ...emptyDiff() };
  if (yield* trackedAtBase(sandbox, baseSha, path)) return { path, ...emptyDiff() };
  return {
    path,
    ...(yield* streamAddPatch(sandbox, path)),
  };
});

const dedupeFileDiff = (previous: ReadonlyMap<string, string>, current: FileDiff) => {
  if (previous.get(current.path) === current.fingerprint) return [previous, []] as const;
  if (current.diff === "" && !previous.has(current.path)) return [previous, []] as const;
  if (current.diff === "") {
    return [new Map([...previous].filter(([path]) => path !== current.path)), [current]] as const;
  }
  return [new Map([...previous, [current.path, current.fingerprint]]), [current]] as const;
};

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

export const watchWorktreeDiffs = (
  sandbox: WorktreeSandbox,
  baseSha: string,
): Stream.Stream<AgUiEvent, ToolError, FileSystem.FileSystem> =>
  Stream.unwrap(
    FileSystem.FileSystem.pipe(
      Effect.map((fs) =>
        fs.watch(sandbox.root, { recursive: true }).pipe(
          Stream.mapError((error) => toolError("exec-failed", `file watcher failed: ${error.message}`)),
          Stream.filter((event) => !ignored(event.path)),
          Stream.groupedWithin(configuredIgnoreBatchSize, configuredIgnoreWindow),
          Stream.mapEffect((events) => configuredIgnoredEvents(sandbox, baseSha, events)),
          Stream.flatMap(Stream.fromIterable),
          debounceByPath,
          Stream.mapEffect((event) => classifyWorktreeEvent(sandbox, event.path)),
          Stream.mapEffect((event) => computeFileDiff(sandbox, baseSha, event)),
          Stream.mapAccum(() => new Map<string, string>(), dedupeFileDiff),
          Stream.map(({ path, diff }) => fileDiffEvent(path, diff)),
        ),
      ),
    ),
  );
