import {
  type AgUiEvent,
  agUiFileDiffEvent,
  agUiFileDiffUnavailableEvent,
  FILE_DIFF_EVENT,
} from "@cogwork/contracts";
import { DEFAULT_WORKSPACE_ROOT, type SandboxFileEvent } from "@tanstack/ai-sandbox";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { ToolError } from "./errors";
import {
  computeFileDiffBatch,
  type ExternalDiffScope,
  externalDiffScope,
  type FileDiff,
} from "./file-diff-batch";
import {
  boundedDiff,
  collectProcessOutput,
  computeDiff,
  exec,
  execFailure,
  quote,
  readText,
  relTo,
} from "./file-diff-git";
import type { WorktreeSandbox } from "./sandbox";

export { FILE_DIFF_EVENT };
export const fileDiffFeedFailures = Metric.counter("cogwork_file_diff_feed_failures_total", {
  description: "Unexpected file-diff feed failures.",
});

const diffDebounce = "250 millis";
const debouncedPathConcurrency = 32;
const diffBatchSize = 32;
const diffBatchWindow = "250 millis";
const configuredIgnoreBatchSize = 256;
const configuredIgnoreWindow = "50 millis";
const fallbackCadence = "1 second";
const concurrentWatcherFailureWindow = "50 millis";

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
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Stream.empty;
        return Stream.fromEffect(
          Effect.logWarning(message, { cause: Cause.pretty(cause) }).pipe(
            Effect.andThen(Metric.update(fileDiffFeedFailures, 1)),
            Effect.map(() => agUiFileDiffUnavailableEvent()),
          ),
        );
      }),
    );

const changedPathsCommand = (baseSha: string) =>
  baseSha === ""
    ? "git diff --name-only -z --no-renames --cached -- . && git diff --name-only -z --no-renames -- . && git ls-files --others --exclude-standard -z -- ."
    : `git diff --name-only -z --no-renames ${quote(baseSha)} -- . && git ls-files --others --exclude-standard -z -- .`;

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
  readonly generation: number;
  readonly fingerprints: ReadonlyMap<string, string>;
  readonly pathGenerations: ReadonlyMap<string, number>;
};
type PollSnapshot = {
  readonly paths: ReadonlyArray<string>;
  readonly pathGenerations: ReadonlyMap<string, number>;
};

const feedSource = (events: ReadonlyArray<SourceIdentity>): FeedSource =>
  events.some(({ source }) => source === "polling") ? "polling" : "native";

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
    Effect.logWarning("native file watcher failed; continuing with polling", {
      cause: Cause.pretty(cause),
    }).pipe((effect) => pollingContext(sandbox, "polling", effect)),
  ).pipe(Stream.drain, Stream.concat(pollingWorktreeEvents(sandbox, baseSha, state, stop)));

const continueAfterNativeFailure = (
  sandbox: WorktreeSandbox,
  baseSha: string,
  cause: Cause.Cause<unknown>,
  state: Ref.Ref<FingerprintState>,
  fallbackStarted: Deferred.Deferred<void>,
  stop?: Effect.Effect<void>,
) => {
  if (Cause.hasInterruptsOnly(cause)) return Stream.fromEffect(Effect.interrupt);
  Deferred.doneUnsafe(fallbackStarted, Effect.void);
  return continueWithPolling(sandbox, baseSha, cause, state, stop);
};

const retainConfiguredEvents = Effect.fn("Tools.retainConfiguredFileDiffEvents")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  events: ReadonlyArray<SourcedWatchEvent>,
) {
  const retained = yield* configuredIgnoredEvents(sandbox, baseSha, events);
  const paths = new Set(retained.map(({ path }) => path));
  return events.filter(({ path }) => paths.has(path));
});

const awaitFallback = (fallbackStarted: Deferred.Deferred<void>, error: ToolError) =>
  Deferred.await(fallbackStarted).pipe(
    Effect.timeoutOrElse({
      duration: concurrentWatcherFailureWindow,
      orElse: () => Effect.fail(error),
    }),
  );

const recoverFeedStep = <A>(
  sandbox: WorktreeSandbox,
  source: FeedSource,
  fallbackStarted: Deferred.Deferred<void>,
  error: ToolError,
  fallback: A,
) =>
  awaitFallback(fallbackStarted, error).pipe(
    Effect.andThen(
      Effect.logWarning("file-diff processing step failed; continuing", {
        cause: error.message,
      }),
    ),
    (effect) => pollingContext(sandbox, source, effect),
    Effect.map(() => fallback),
  );

const filterConfiguredEvents = Effect.fn("Tools.filterConfiguredFileDiffEvents")(
  (
    sandbox: WorktreeSandbox,
    baseSha: string,
    fallbackStarted: Deferred.Deferred<void>,
    events: ReadonlyArray<SourcedWatchEvent>,
  ) => {
    const source = feedSource(events);
    return retainConfiguredEvents(sandbox, baseSha, events).pipe(
      Effect.catch((error) => recoverFeedStep(sandbox, source, fallbackStarted, error, [])),
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

const computeSourcedFileDiffBatch = Effect.fn("Tools.computeSourcedFileDiffBatch")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  externalDiff: Effect.Effect<ExternalDiffScope, ToolError>,
  fallbackStarted: Deferred.Deferred<void>,
  events: ReadonlyArray<SourcedSandboxEvent>,
) {
  const source = feedSource(events);
  return yield* computeFileDiffBatch(sandbox, baseSha, externalDiff, events).pipe(
    Effect.map((diffs) => Arr.zipWith(events, diffs, (event, diff) => attachSource(event)(diff))),
    Effect.catch((error) => recoverFeedStep(sandbox, source, fallbackStarted, error, [])),
    (effect) => pollingContext(sandbox, source, effect),
  );
});

const classifySourcedEvents = Effect.fn("Tools.classifySourcedFileDiffEvents")(
  (sandbox: WorktreeSandbox, events: ReadonlyArray<SourcedWatchEvent>) =>
    Effect.forEach(
      events,
      (event) =>
        classifySourcedEvent(sandbox, event).pipe((effect) => pollingContext(sandbox, event.source, effect)),
      { concurrency: "unbounded" },
    ).pipe(Effect.map(Arr.filter(Predicate.isNotNull))),
);

const computeSettledFileDiffBatch = Effect.fn("Tools.computeSettledFileDiffBatch")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  externalDiff: Effect.Effect<ExternalDiffScope, ToolError>,
  fallbackStarted: Deferred.Deferred<void>,
  events: ReadonlyArray<SourcedWatchEvent>,
) {
  const classified = yield* classifySourcedEvents(sandbox, events);
  if (classified.length === 0) return [];
  return yield* computeSourcedFileDiffBatch(sandbox, baseSha, externalDiff, fallbackStarted, classified);
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
      const [cachedExternalDiff, invalidateExternalDiff] = yield* Effect.cachedInvalidateWithTTL(
        externalDiffScope(sandbox),
        Duration.infinity,
      );
      const fallbackStarted = yield* Deferred.make<void>();
      const state = yield* Ref.make<FingerprintState>({
        generation: 0,
        fingerprints: new Map(),
        pathGenerations: new Map(),
      });
      return fs.watch(sandbox.root, { recursive: true }).pipe(
        Stream.map((event) => ({ ...event, source: "native", generation: 0 }) satisfies SourcedWatchEvent),
        (source) => stopSource(source, stop),
        Stream.catchCause((cause) =>
          continueAfterNativeFailure(sandbox, baseSha, cause, state, fallbackStarted, stop),
        ),
        Stream.filter((event) => !ignored(event.path)),
        Stream.groupedWithin(configuredIgnoreBatchSize, configuredIgnoreWindow),
        Stream.mapEffect((events) => filterConfiguredEvents(sandbox, baseSha, fallbackStarted, events)),
        Stream.flatMap(Stream.fromIterable),
        debounceByPath,
        Stream.groupedWithin(diffBatchSize, diffBatchWindow),
        Stream.mapEffect((events) =>
          computeSettledFileDiffBatch(
            sandbox,
            baseSha,
            cachedExternalDiff.pipe(Effect.tapError(() => invalidateExternalDiff)),
            fallbackStarted,
            events,
          ),
        ),
        Stream.flatMap(Stream.fromIterable),
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
