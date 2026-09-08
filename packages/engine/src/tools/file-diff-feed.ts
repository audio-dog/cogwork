import { createHash, type Hash } from "node:crypto";
import { type AgUiEvent, agUiFileDiffEvent, FILE_DIFF_EVENT } from "@cogwork/contracts";
import { DEFAULT_WORKSPACE_ROOT, type ExecResult, type SandboxFileEvent } from "@tanstack/ai-sandbox";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { type ToolError, toolError } from "./errors";
import type { WorktreeSandbox } from "./sandbox";

export { FILE_DIFF_EVENT };
export const fileDiffExecDuration = Metric.timer("cogwork_file_diff_git_diff_exec_duration", {
  description: "Time spent executing git diff for settled file events.",
});
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
const diffCommandDeadline = "5 minutes";
const diffDebounce = "250 millis";
const debouncedPathConcurrency = 32;
const diffBatchSize = 32;
const diffBatchWindow = "50 millis";
const configuredIgnoreBatchSize = 256;
const configuredIgnoreWindow = "50 millis";
const stderrMaxBytes = 4 * 1024;
const processReleaseDeadline = "5 seconds";
const gitCommand = "git --literal-pathspecs";
const gitDiffCommand = `${gitCommand} diff`;

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
  const command = `${gitCommand} ls-tree -r --name-only ${quote(baseSha)} -- ${quote(rel)}`;
  const result = yield* exec(sandbox, command);
  if (result.exitCode !== 0) {
    return yield* execFailure(command, rel, result);
  }
  return result.stdout.trim() !== "";
});

const directoryAtBase = Effect.fn("Tools.directoryAtBase")(function* (
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

interface DiffOutput {
  readonly prefix: Uint8Array;
  readonly byteLength: number;
  readonly fingerprint: string;
}

interface PendingDiffOutput {
  readonly prefix: Uint8Array;
  readonly byteLength: number;
  readonly hash: Hash;
}

const pendingDiffOutput = () => ({
  prefix: new Uint8Array(),
  byteLength: 0,
  hash: createHash("sha256"),
});

const appendDiffOutput = (output: PendingDiffOutput, value: string) => {
  const bytes = Buffer.from(value);
  output.hash.update(bytes);
  return {
    prefix: appendPrefix(output.prefix, bytes, fileDiffMaxBytes),
    byteLength: output.byteLength + bytes.length,
    hash: output.hash,
  };
};

const completeDiffOutput = (output: PendingDiffOutput) => ({
  prefix: output.prefix,
  byteLength: output.byteLength,
  fingerprint: output.hash.digest("base64"),
});

const nextChunk = <A>(chunks: AsyncIterator<A>) =>
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

const readText = (chunks: AsyncIterator<string>, text = ""): Effect.Effect<string, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) => (next.done ? Effect.succeed(text) : readText(chunks, `${text}${next.value}`))),
  );

const diffFromOutput = (output: DiffOutput) => {
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

const collectProcessOutput = <A>(
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

const streamDiff = Effect.fn("Tools.streamDiff")(function* (
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

interface BatchDiffHeader {
  readonly paths: ReadonlyArray<string>;
  readonly patch: string;
}

const rawPatchSeparator = "\0\0";

const batchDiffPaths = (raw: string) => raw.split("\0").filter((_field, index) => index % 2 === 1);

const readBatchDiffHeader = (
  chunks: AsyncIterator<string>,
  buffered = "",
): Effect.Effect<BatchDiffHeader, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) => {
      if (next.done && buffered === "") return Effect.succeed({ paths: [], patch: "" });
      if (next.done) {
        return Effect.fail(toolError("exec-failed", "git diff returned an incomplete raw header"));
      }
      const output = `${buffered}${next.value}`;
      const separator = output.indexOf(rawPatchSeparator);
      if (separator !== -1) {
        return Effect.succeed({
          paths: batchDiffPaths(output.slice(0, separator)),
          patch: output.slice(separator + rawPatchSeparator.length),
        });
      }
      return readBatchDiffHeader(chunks, output);
    }),
  );

interface BatchPatchState {
  readonly currentPath: string | undefined;
  readonly remainingPaths: ReadonlyArray<string>;
  readonly current: PendingDiffOutput;
  readonly completed: ReadonlyMap<string, DiffOutput>;
  readonly tail: string;
  readonly invalid: boolean;
}

const ansiEscape = String.fromCharCode(27);
const patchBoundary = new RegExp(`(?:^|\\n)(?:${ansiEscape}\\[[0-9;]*m)*diff --git `);
const ansiPrefixes = new RegExp(`^(?:${ansiEscape}\\[[0-9;]*m)*`);
const partialAnsiPrefix = new RegExp(`^${ansiEscape}(?:\\[[0-9;]*)?$`);
const diffHeader = "diff --git ";

// `--no-renames` preserves one raw path per patch. `-z` terminates the raw path list with two NULs;
// colored patch headers may start with SGR sequences that must remain in the emitted payload.
const completeBatchPatch = (state: BatchPatchState, value: string) => {
  if (state.currentPath === undefined) return { ...state, invalid: true };
  return {
    currentPath: state.remainingPaths[0],
    remainingPaths: state.remainingPaths.slice(1),
    current: pendingDiffOutput(),
    completed: new Map([
      ...state.completed,
      [state.currentPath, completeDiffOutput(appendDiffOutput(state.current, value))],
    ]),
    tail: "",
    invalid: state.invalid,
  };
};

const couldStartPatchBoundary = (value: string) => {
  const withoutAnsi = value.replace(ansiPrefixes, "");
  return partialAnsiPrefix.test(withoutAnsi) || diffHeader.startsWith(withoutAnsi);
};

const findPatchBoundary = (value: string) => {
  const match = patchBoundary.exec(value);
  if (match === null) return null;
  return {
    start: match.index + (match[0].startsWith("\n") ? 1 : 0),
    end: match.index + match[0].length,
  };
};

const nextPatchStart = (state: BatchPatchState, output: string) => {
  const first = findPatchBoundary(output);
  if (first === null) return null;
  if (first.start > 0 || state.current.byteLength > 0) return first.start;
  const following = findPatchBoundary(output.slice(first.end));
  return following === null ? null : first.end + following.start;
};

const consumeBatchPatch = (state: BatchPatchState, value: string): BatchPatchState => {
  const output = `${state.tail}${value}`;
  const boundary = nextPatchStart(state, output);
  if (boundary !== null) {
    const completed = completeBatchPatch(state, output.slice(0, boundary));
    return consumeBatchPatch(completed, output.slice(boundary));
  }
  const lastLineStart = output.lastIndexOf("\n") + 1;
  const consumedLength = couldStartPatchBoundary(output.slice(lastLineStart)) ? lastLineStart : output.length;
  return {
    ...state,
    current: appendDiffOutput(state.current, output.slice(0, consumedLength)),
    tail: output.slice(consumedLength),
  };
};

const finishBatchPatch = (state: BatchPatchState) => {
  const completed = state.currentPath === undefined ? state : completeBatchPatch(state, state.tail);
  const mismatched =
    completed.invalid ||
    completed.currentPath !== undefined ||
    completed.remainingPaths.length > 0 ||
    completed.tail !== "";
  return mismatched ? Option.none<ReadonlyMap<string, DiffOutput>>() : Option.some(completed.completed);
};

const readBatchPatches = (
  chunks: AsyncIterator<string>,
  state: BatchPatchState,
): Effect.Effect<Option.Option<ReadonlyMap<string, DiffOutput>>, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) =>
      next.done
        ? Effect.succeed(finishBatchPatch(state))
        : readBatchPatches(chunks, consumeBatchPatch(state, next.value)),
    ),
  );

const readBatchDiffOutput = Effect.fn("Tools.readBatchDiffOutput")(function* (chunks: AsyncIterator<string>) {
  const header = yield* readBatchDiffHeader(chunks);
  if (header.paths.length === 0) return Option.some(new Map<string, DiffOutput>());
  const state = consumeBatchPatch(
    {
      currentPath: header.paths[0],
      remainingPaths: header.paths.slice(1),
      current: pendingDiffOutput(),
      completed: new Map(),
      tail: "",
      invalid: false,
    },
    header.patch,
  );
  return yield* readBatchPatches(chunks, state);
});

const streamBatchDiff = Effect.fn("Tools.streamBatchDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  paths: ReadonlyArray<string>,
) {
  if (paths.length === 0) {
    return Option.some(new Map<string, { readonly diff: string; readonly fingerprint: string }>());
  }
  const command = `${gitDiffCommand} --raw -z --patch --no-renames ${quote(baseSha)} -- ${paths.map(quote).join(" ")}`;
  const result = yield* collectProcessOutput(sandbox, command, readBatchDiffOutput).pipe(
    Effect.trackDuration(fileDiffExecDuration),
  );
  if (result.exitCode !== 0) {
    return yield* execFailure(command, paths[0] ?? "", {
      stdout: "",
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return Option.map(
    result.stdout,
    (outputs) =>
      new Map(
        [...outputs].map(([path, output]) => [
          path,
          { diff: diffFromOutput(output), fingerprint: output.fingerprint },
        ]),
      ),
  );
});

export const fileDiffEvent = (path: string, diff: string): AgUiEvent =>
  agUiFileDiffEvent(path, boundedDiff(diff));

export const toFileDiffEvent = Effect.fn("Tools.toFileDiffEvent")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
) {
  const diff = yield* computeDiff(sandbox, baseSha, event);
  return diff === "" ? null : fileDiffEvent(relTo(event.path), diff);
});

// Refused by segment because `git check-ignore` is skipped without a base SHA, and
// that path synthesizes a whole-file patch per file instead.
const IGNORED_SEGMENTS = [".git", "node_modules", ".repos", ".pnpm-store"];

// Anchored to a whole root entry so it cannot hide a nested file the agent wrote:
// the checkout is the agent's, and it can create any name it likes inside it.
const reservedScratch = /^\.tanstack-[^/]*$/;

export const ignored = (rel: string) =>
  rel.split("/").some((segment) => IGNORED_SEGMENTS.includes(segment)) || reservedScratch.test(rel);

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
  const literalPaths = paths.map((path) => `./${path}`);
  const command = "git check-ignore -z --stdin";
  const result = yield* collectProcessOutput(sandbox, command, readText, `${literalPaths.join("\0")}\0`);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return yield* execFailure(command, paths[0] ?? "", result);
  }
  // `check-ignore --stdin` still parses leading `:(...)` as pathspec magic; `./` makes watcher paths literal.
  const ignoredPaths = new Set(
    result.stdout
      .split("\0")
      .filter((path) => path !== "")
      .map((path) => path.slice(2)),
  );
  return events.filter((event) => !ignoredPaths.has(event.path));
});

interface FileDiff {
  readonly path: string;
  readonly diff: string;
  readonly fingerprint: string;
}

interface BaseEntry {
  readonly directory: boolean;
}

const externalDiffConfigured = Effect.fn("Tools.externalDiffConfigured")(function* (
  sandbox: WorktreeSandbox,
  paths: ReadonlyArray<string>,
) {
  const hasEnvironmentExternalDiff = yield* Config.string("GIT_EXTERNAL_DIFF").pipe(
    Config.option,
    Effect.match({
      onFailure: () => true,
      onSuccess: (value) => Option.isSome(value) && value.value !== "",
    }),
  );
  if (hasEnvironmentExternalDiff) return true;
  const configCommand = "git config -z --get-regexp '^diff\\.(external|.*\\.command)$'";
  const config = yield* exec(sandbox, configCommand);
  if (config.exitCode !== 0 && config.exitCode !== 1) {
    return yield* execFailure(configCommand, paths[0] ?? "", config);
  }
  const settings = new Map(
    config.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const separator = entry.indexOf("\n");
        return [entry.slice(0, separator), entry.slice(separator + 1)] satisfies [string, string];
      }),
  );
  if (settings.has("diff.external")) return true;
  const drivers = new Set(
    [...settings.keys()].flatMap((key) => /^diff\.(.+)\.command$/.exec(key)?.[1] ?? []),
  );
  if (drivers.size === 0) return false;
  const attributeCommand = `git check-attr -z diff -- ${paths.map((path) => quote(`./${path}`)).join(" ")}`;
  const attributes = yield* exec(sandbox, attributeCommand);
  if (attributes.exitCode !== 0) {
    return yield* execFailure(attributeCommand, paths[0] ?? "", attributes);
  }
  return attributes.stdout.split("\0").some((value, index) => index % 3 === 2 && drivers.has(value));
});

const baseEntries = Effect.fn("Tools.baseEntries")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  paths: ReadonlyArray<string>,
) {
  const command = `${gitCommand} ls-tree -z ${quote(baseSha)} -- ${paths.map(quote).join(" ")}`;
  const result = yield* exec(sandbox, command);
  if (result.exitCode !== 0) return yield* execFailure(command, paths[0] ?? "", result);
  return new Map(
    result.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const separator = entry.indexOf("\t");
        const metadata = entry.slice(0, separator).split(" ");
        return [entry.slice(separator + 1), { directory: metadata[1] === "tree" }] satisfies [
          string,
          BaseEntry,
        ];
      }),
  );
});

const emptyDiff = () => ({
  diff: "",
  fingerprint: createHash("sha256").digest("base64"),
});

const streamAddPatch = (sandbox: WorktreeSandbox, rel: string) =>
  streamDiff(sandbox, `${gitDiffCommand} --no-index -- /dev/null ${quote(rel)}`, rel, new Set([0, 1]));

const resolveFileDiff = Effect.fn("Tools.resolveFileDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
  path: string,
  trackedDiff: { readonly diff: string; readonly fingerprint: string },
  knownTracked?: boolean,
) {
  if (trackedDiff.diff !== "") return { path, ...trackedDiff };
  if (event.type === "delete") return { path, ...emptyDiff() };
  const tracked = knownTracked ?? (yield* trackedAtBase(sandbox, baseSha, path));
  if (tracked) return { path, ...emptyDiff() };
  return { path, ...(yield* streamAddPatch(sandbox, path)) };
});

const computeFileDiff = Effect.fn("Tools.computeFileDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
) {
  const path = relTo(event.path);
  if (event.type === "delete" && baseSha === "") return { path, ...emptyDiff() };
  if (baseSha === "") return { path, ...(yield* streamAddPatch(sandbox, path)) };
  if (event.type === "delete" && (yield* directoryAtBase(sandbox, baseSha, path))) {
    return { path, ...emptyDiff() };
  }
  const command = `${gitDiffCommand} ${quote(baseSha)} -- ${quote(path)}`;
  const trackedDiff = yield* streamDiff(sandbox, command, path, new Set([0]));
  return yield* resolveFileDiff(sandbox, baseSha, event, path, trackedDiff);
});

const computeFileDiffBatch = Effect.fn("Tools.computeFileDiffBatch")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  events: ReadonlyArray<SandboxFileEvent>,
) {
  const computeIndividually = () =>
    Effect.forEach(events, (event) => computeFileDiff(sandbox, baseSha, event));
  if (events.length === 1 || baseSha === "") {
    return yield* computeIndividually();
  }
  const files = events.map((event) => ({ event, path: relTo(event.path) }));
  const paths = files.map(({ path }) => path);
  if (yield* externalDiffConfigured(sandbox, paths)) return yield* computeIndividually();
  const entries = yield* baseEntries(sandbox, baseSha, paths);
  const diffablePaths = files.filter(({ path }) => !entries.get(path)?.directory).map(({ path }) => path);
  const trackedDiffs = yield* streamBatchDiff(sandbox, baseSha, diffablePaths);
  if (Option.isNone(trackedDiffs)) return yield* computeIndividually();
  return yield* Effect.forEach(files, ({ event, path }) => {
    const baseEntry = entries.get(path);
    if (!baseEntry?.directory) {
      const trackedDiff = trackedDiffs.value.get(path);
      return resolveFileDiff(
        sandbox,
        baseSha,
        event,
        path,
        trackedDiff ?? emptyDiff(),
        baseEntry !== undefined,
      );
    }
    if (event.type === "delete") return Effect.succeed({ path, ...emptyDiff() });
    return computeFileDiff(sandbox, baseSha, event);
  });
});

const dedupeFileDiff = (previous: ReadonlyMap<string, string>, current: FileDiff) => {
  if (current.diff === "") {
    const remaining = previous.has(current.path)
      ? new Map([...previous].filter(([path]) => path !== current.path))
      : previous;
    return [remaining, []] as const;
  }
  if (previous.get(current.path) === current.fingerprint) return [previous, []] as const;
  return [new Map([...previous, [current.path, current.fingerprint]]), [current]] as const;
};

const isDirectory = (sandbox: WorktreeSandbox, path: string) =>
  Effect.tryPromise(() => sandbox.handle.fs.list(path)).pipe(
    Effect.match({ onFailure: () => false, onSuccess: () => true }),
  );

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
  if (yield* isDirectory(sandbox, path)) return null;
  const exists = yield* Effect.tryPromise(() => sandbox.handle.fs.exists(path)).pipe(
    Effect.orElseSucceed(() => false),
  );
  return { type: exists ? "change" : "delete", path, timestamp: 0 } satisfies SandboxFileEvent;
});

/** Interruption is a consumer tearing the feed down, not a death. */
export const tolerateFeedDeath =
  (message: string) =>
  <A, E, R>(feed: Stream.Stream<A, E, R>) =>
    feed.pipe(
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.empty
          : Stream.fromEffect(Effect.logWarning(message, { cause })).pipe(Stream.drain),
      ),
    );

export const watchWorktreeDiffs = (
  sandbox: WorktreeSandbox,
  baseSha: string,
  /** Completes to end the source, flushing the debounce. Omitting it drops whatever the debounce holds. */
  stop?: Effect.Effect<void>,
): Stream.Stream<AgUiEvent, ToolError, FileSystem.FileSystem> =>
  Stream.unwrap(
    FileSystem.FileSystem.pipe(
      Effect.map((fs) =>
        fs.watch(sandbox.root, { recursive: true }).pipe(
          Stream.mapError((error) => toolError("exec-failed", `file watcher failed: ${error.message}`)),
          // Not `Stream.haltWhen`: it polls between pulls, and the watcher's pull
          // blocks while the checkout is idle, so an idle feed would never stop.
          (source) =>
            stop
              ? Stream.merge(source, Stream.fromEffect(stop).pipe(Stream.drain), {
                  haltStrategy: "either",
                })
              : source,
          Stream.filter((event) => !ignored(event.path)),
          Stream.groupedWithin(configuredIgnoreBatchSize, configuredIgnoreWindow),
          Stream.mapEffect((events) => configuredIgnoredEvents(sandbox, baseSha, events)),
          Stream.flatMap(Stream.fromIterable),
          debounceByPath,
          Stream.mapEffect((event) => classifyWorktreeEvent(sandbox, event.path)),
          Stream.filter((event) => event !== null),
          Stream.groupedWithin(diffBatchSize, diffBatchWindow),
          Stream.mapEffect((events) => computeFileDiffBatch(sandbox, baseSha, events)),
          Stream.flatMap(Stream.fromIterable),
          Stream.mapAccum(() => new Map<string, string>(), dedupeFileDiff),
          Stream.map(({ path, diff }) => fileDiffEvent(path, diff)),
        ),
      ),
    ),
  );
