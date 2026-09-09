import { createHash, type Hash } from "node:crypto";
import { type AgUiEvent, agUiFileDiffEvent, FILE_DIFF_EVENT } from "@cogwork/contracts";
import { DEFAULT_WORKSPACE_ROOT, type ExecResult, type SandboxFileEvent } from "@tanstack/ai-sandbox";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { type ToolError, toolError } from "./errors";
import type { WorktreeSandbox } from "./sandbox";

export { FILE_DIFF_EVENT };
export const fileDiffExecDuration = Metric.timer("cogwork_file_diff_git_diff_exec_duration", {
  description: "Time spent executing git diff for a file event.",
});
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
const diffCommandDeadline = "5 minutes";
const diffDebounce = "250 millis";
const debouncedPathConcurrency = 32;
const configuredIgnoreBatchSize = 256;
const configuredIgnoreWindow = "50 millis";
const fallbackCadence = "1 second";
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

const directoryAtBase = Effect.fn("Tools.directoryAtBase")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  rel: string,
) {
  const command = `git ls-tree ${quote(baseSha)} -- ${quote(rel)}`;
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
  const diffCommand = `git diff ${quote(baseSha)} -- ${quote(rel)}`;
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
                Effect.andThen(Effect.tryPromise(() => exit).pipe(Effect.interruptible)),
                Effect.timeoutOrElse({
                  duration: processReleaseDeadline,
                  orElse: () =>
                    Effect.tryPromise(() => process.kill("SIGKILL")).pipe(
                      Effect.ignore,
                      Effect.andThen(Effect.tryPromise(() => exit).pipe(Effect.interruptible)),
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

const debounceByPath = <A extends { readonly path: string }, E, R>(stream: Stream.Stream<A, E, R>) =>
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
  if (event.type === "delete" && (yield* directoryAtBase(sandbox, baseSha, path))) {
    return { path, ...emptyDiff() };
  }
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
          : Stream.fromEffect(Effect.logWarning(message, { cause: Cause.pretty(cause) })).pipe(Stream.drain),
      ),
    );

const changedPathsCommand = (baseSha: string) =>
  baseSha === ""
    ? "git diff --name-only -z --cached -- . && git diff --name-only -z -- . && git ls-files --others --exclude-standard -z -- ."
    : `git diff --name-only -z ${quote(baseSha)} -- . && git ls-files --others --exclude-standard -z -- .`;

const pollWorktreePaths = Effect.fn("Tools.pollWorktreePaths")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
) {
  const command = changedPathsCommand(baseSha);
  const result = yield* exec(sandbox, command);
  if (result.exitCode !== 0) return yield* execFailure(command, "", result);
  return [...new Set(result.stdout.split("\0").filter((path) => path !== ""))];
});

type FeedSource = "native" | "polling";
type SourceIdentity = { readonly source: FeedSource; readonly generation: number };
type SourcedWatchEvent = FileSystem.WatchEvent & SourceIdentity;
type SourcedSandboxEvent = SandboxFileEvent & SourceIdentity;
type SourcedFileDiff = FileDiff & SourceIdentity;
type FingerprintState = {
  readonly pollingActive: boolean;
  readonly generation: number;
  readonly fingerprints: ReadonlyMap<string, string>;
  readonly pathGenerations: ReadonlyMap<string, number>;
};
type PollSnapshot = {
  readonly paths: ReadonlyArray<string>;
  readonly pathGenerations: ReadonlyMap<string, number>;
};

const pollingContext = <A, E, R>(
  sandbox: WorktreeSandbox,
  source: FeedSource,
  effect: Effect.Effect<A, E, R>,
) =>
  source === "native"
    ? effect
    : effect.pipe(
        Effect.annotateLogs({ checkout: sandbox.root, source }),
        Effect.provideService(References.TracerEnabled, false),
      );

const pollWorktreePathsOrNone = Effect.fn("Tools.pollWorktreePathsOrNone")(
  (sandbox: WorktreeSandbox, baseSha: string) =>
    pollWorktreePaths(sandbox, baseSha).pipe(
      Effect.asSome,
      Effect.catch((error) =>
        Effect.logWarning("file-diff poll failed; continuing on the next poll", {
          cause: error.message,
        }).pipe(Effect.map(() => Option.none<Array<string>>())),
      ),
      (effect) => pollingContext(sandbox, "polling", effect),
    ),
);

const watchEvents = ({ paths, pathGenerations }: PollSnapshot) =>
  paths.flatMap((path) => {
    const generation = pathGenerations.get(path);
    return generation === undefined
      ? []
      : [{ _tag: "Update", path, source: "polling", generation } satisfies SourcedWatchEvent];
  });

const pollEvents = (snapshot: Option.Option<PollSnapshot>) =>
  Stream.fromIterable(
    Option.match(snapshot, {
      onNone: () => [],
      onSome: watchEvents,
    }),
  );

const advanceFingerprintGeneration = Effect.fn("Tools.advanceFileDiffFingerprintGeneration")(function* (
  state: Ref.Ref<FingerprintState>,
  paths: ReadonlyArray<string>,
) {
  const dirty = new Set(paths);
  return yield* Ref.modify(state, (previous) => {
    const generation = previous.generation + 1;
    const fingerprints = new Map([...previous.fingerprints].filter(([path]) => dirty.has(path)));
    const pathGenerations = new Map(
      paths.map((path) => [path, previous.pathGenerations.get(path) ?? generation]),
    );
    return [
      { paths, pathGenerations },
      { ...previous, generation, fingerprints, pathGenerations },
    ];
  });
});

const pollingPathSnapshot = Effect.fn("Tools.pollingFileDiffPathSnapshot")(
  (sandbox: WorktreeSandbox, baseSha: string, state: Ref.Ref<FingerprintState>) =>
    pollWorktreePathsOrNone(sandbox, baseSha).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (paths) => advanceFingerprintGeneration(state, paths).pipe(Effect.asSome),
        }),
      ),
    ),
);

const scheduledWorktreeEvents = (
  sandbox: WorktreeSandbox,
  baseSha: string,
  state: Ref.Ref<FingerprintState>,
) =>
  Stream.fromEffectSchedule(
    pollingPathSnapshot(sandbox, baseSha, state),
    Schedule.spaced(fallbackCadence),
  ).pipe(Stream.flatMap(pollEvents));

const pollingWorktreeEvents = (
  sandbox: WorktreeSandbox,
  baseSha: string,
  state: Ref.Ref<FingerprintState>,
  stop?: Effect.Effect<void>,
) => {
  if (!stop) return scheduledWorktreeEvents(sandbox, baseSha, state);
  return Stream.merge(
    Stream.fromEffect(Effect.andThen(stop, pollingPathSnapshot(sandbox, baseSha, state))).pipe(
      Stream.flatMap(pollEvents),
    ),
    scheduledWorktreeEvents(sandbox, baseSha, state),
    { haltStrategy: "left" },
  );
};

const stopSource = <A, E, R>(source: Stream.Stream<A, E, R>, stop?: Effect.Effect<void>) =>
  stop
    ? Stream.merge(source, Stream.fromEffect(stop).pipe(Stream.drain), { haltStrategy: "either" })
    : source;

const continueWithPolling = (
  sandbox: WorktreeSandbox,
  baseSha: string,
  cause: Cause.Cause<unknown>,
  state: Ref.Ref<FingerprintState>,
  stop?: Effect.Effect<void>,
) =>
  Stream.fromEffect(
    Ref.update(state, (previous) => ({ ...previous, pollingActive: true })).pipe(
      Effect.andThen(
        Effect.logWarning("native file watcher failed; continuing with polling", {
          cause: Cause.pretty(cause),
        }),
      ),
      (effect) => pollingContext(sandbox, "polling", effect),
    ),
  ).pipe(Stream.drain, Stream.concat(pollingWorktreeEvents(sandbox, baseSha, state, stop)));

const retainConfiguredEvents = Effect.fn("Tools.retainConfiguredFileDiffEvents")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  events: ReadonlyArray<SourcedWatchEvent>,
) {
  const retained = yield* configuredIgnoredEvents(sandbox, baseSha, events);
  const paths = new Set(retained.map(({ path }) => path));
  return events.filter(({ path }) => paths.has(path));
});

const logPollingStepFailure = Effect.fn("Tools.logPollingFileDiffStepFailure")(
  (sandbox: WorktreeSandbox, error: ToolError) =>
    Effect.logWarning("file-diff polling step failed; continuing", {
      cause: error.message,
    }).pipe((effect) => pollingContext(sandbox, "polling", effect)),
);

const recoverPollingStep = <A>(
  state: Ref.Ref<FingerprintState>,
  sandbox: WorktreeSandbox,
  error: ToolError,
  fallback: A,
) =>
  Ref.get(state).pipe(
    Effect.flatMap(({ pollingActive }) => {
      if (!pollingActive) return Effect.fail(error);
      return logPollingStepFailure(sandbox, error).pipe(Effect.map(() => fallback));
    }),
  );

const filterConfiguredEvents = Effect.fn("Tools.filterConfiguredFileDiffEvents")(
  (
    sandbox: WorktreeSandbox,
    baseSha: string,
    state: Ref.Ref<FingerprintState>,
    events: ReadonlyArray<SourcedWatchEvent>,
  ) => {
    const source = events.some((event) => event.source === "polling") ? "polling" : "native";
    return retainConfiguredEvents(sandbox, baseSha, events).pipe(
      Effect.catch((error) => recoverPollingStep(state, sandbox, error, [])),
      (effect) => pollingContext(sandbox, source, effect),
    );
  },
);

const classifySourcedEvent = Effect.fn("Tools.classifySourcedFileDiffEvent")(function* (
  sandbox: WorktreeSandbox,
  sourced: SourcedWatchEvent,
) {
  const event = yield* classifyWorktreeEvent(sandbox, sourced.path);
  return event === null
    ? null
    : ({ ...event, source: sourced.source, generation: sourced.generation } satisfies SourcedSandboxEvent);
});

const attachSource =
  ({ source, generation }: SourceIdentity) =>
  (diff: FileDiff) =>
    ({ ...diff, source, generation }) satisfies SourcedFileDiff;

const computeSourcedFileDiff = Effect.fn("Tools.computeSourcedFileDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  state: Ref.Ref<FingerprintState>,
  sourced: SourcedSandboxEvent,
) {
  return yield* computeFileDiff(sandbox, baseSha, sourced).pipe(
    Effect.map(attachSource(sourced)),
    Effect.catch((error) => recoverPollingStep(state, sandbox, error, null)),
    (effect) => pollingContext(sandbox, sourced.source, effect),
  );
});

const dedupeWithFingerprints = Effect.fn("Tools.dedupeFileDiffWithFingerprints")(
  (state: Ref.Ref<FingerprintState>, current: SourcedFileDiff) =>
    Ref.modify(state, (previous) => {
      const currentGeneration = previous.pathGenerations.get(current.path);
      const nativeIsCurrent = current.source === "native" && previous.generation === 0;
      const pollingIsCurrent = current.source === "polling" && current.generation === currentGeneration;
      if (!nativeIsCurrent && !pollingIsCurrent) {
        const events: ReadonlyArray<FileDiff> = [];
        return [events, previous];
      }
      const [fingerprints, events] = dedupeFileDiff(previous.fingerprints, current);
      return [events, { ...previous, fingerprints }];
    }),
);

export const watchWorktreeDiffs = (
  sandbox: WorktreeSandbox,
  baseSha: string,
  /** Completes to end the source, flushing the debounce. Omitting it drops whatever the debounce holds. */
  stop?: Effect.Effect<void>,
): Stream.Stream<AgUiEvent, ToolError, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* Ref.make<FingerprintState>({
        pollingActive: false,
        generation: 0,
        fingerprints: new Map(),
        pathGenerations: new Map(),
      });
      return fs.watch(sandbox.root, { recursive: true }).pipe(
        Stream.map((event) => ({ ...event, source: "native", generation: 0 }) satisfies SourcedWatchEvent),
        (source) => stopSource(source, stop),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Stream.fromEffect(Effect.interrupt)
            : continueWithPolling(sandbox, baseSha, cause, state, stop),
        ),
        Stream.filter((event) => !ignored(event.path)),
        Stream.groupedWithin(configuredIgnoreBatchSize, configuredIgnoreWindow),
        Stream.mapEffect((events) => filterConfiguredEvents(sandbox, baseSha, state, events)),
        Stream.flatMap(Stream.fromIterable),
        debounceByPath,
        Stream.mapEffect((event) =>
          classifySourcedEvent(sandbox, event).pipe((effect) =>
            pollingContext(sandbox, event.source, effect),
          ),
        ),
        Stream.filter((event) => event !== null),
        Stream.mapEffect((event) => computeSourcedFileDiff(sandbox, baseSha, state, event)),
        Stream.filter((event) => event !== null),
        Stream.mapEffect((event) =>
          dedupeWithFingerprints(state, event).pipe((effect) =>
            pollingContext(sandbox, event.source, effect),
          ),
        ),
        Stream.flatMap(Stream.fromIterable),
        Stream.map(({ path, diff }) => fileDiffEvent(path, diff)),
      );
    }),
  );
