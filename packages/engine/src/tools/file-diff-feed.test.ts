import { assert, describe, it } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  computeDiff,
  FILE_DIFF_EVENT,
  fileDiffEvent,
  fileDiffExecDuration,
  toFileDiffEvent,
  tolerateFeedDeath,
  watchWorktreeDiffs,
} from "./file-diff-feed";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

const DiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
const decodeDiffValue = Schema.decodeUnknownEffect(DiffValue);
const WatcherFallbackLog = Schema.Struct({
  message: Schema.Tuple([Schema.String, Schema.Struct({ cause: Schema.String })]),
  annotations: Schema.Struct({ checkout: Schema.String, source: Schema.String }),
});
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
const watcherFailure = () =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "watch",
    cause: new Error("EMFILE: too many open files, watch"),
  });
const deniedWatcherLayer = FileSystem.layerNoop({ watch: () => Stream.fail(watcherFailure()) });
const gitFixtureEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "cogwork-test",
  GIT_AUTHOR_EMAIL: "cogwork-test@invalid",
  GIT_COMMITTER_NAME: "cogwork-test",
  GIT_COMMITTER_EMAIL: "cogwork-test@invalid",
};
const emptyOutput: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
};

const advanceUntil = (deferred: Deferred.Deferred<void>, duration: Duration.Input) =>
  Deferred.await(deferred).pipe(Effect.raceFirst(TestClock.adjust(duration).pipe(Effect.forever)));

const awaitLiveEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, duration: Duration.Input) =>
  effect.pipe(Effect.timeout(duration));

class ExecCalls extends Context.Service<ExecCalls, Queue.Queue<string>>()(
  "@cogwork/engine/tools/file-diff-feed.test/ExecCalls",
) {
  static readonly layer = Layer.effect(ExecCalls, Queue.unbounded<string>());
}

type WatcherSignal = FileSystem.WatchEvent | { readonly _tag: "Fail" };

class WatcherSignals extends Context.Service<WatcherSignals, Queue.Queue<WatcherSignal>>()(
  "@cogwork/engine/tools/file-diff-feed.test/WatcherSignals",
) {
  static readonly layer = Layer.effect(WatcherSignals, Queue.unbounded<WatcherSignal>());
}

function queuedWatcherLayer() {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(WatcherSignals, (signals) =>
      FileSystem.makeNoop({
        watch: () =>
          Stream.fromQueue(signals).pipe(
            Stream.mapEffect((event) =>
              event._tag === "Fail" ? Effect.fail(watcherFailure()) : Effect.succeed(event),
            ),
          ),
      }),
    ),
  ).pipe(Layer.provideMerge(WatcherSignals.layer));
}

const deniedWatcherWithExecCalls = Layer.mergeAll(deniedWatcherLayer, ExecCalls.layer);

class FeedLogs extends Context.Service<FeedLogs, MutableRef.MutableRef<ReadonlyArray<unknown>>>()(
  "@cogwork/engine/tools/file-diff-feed.test/FeedLogs",
) {
  static readonly layer = Layer.sync(FeedLogs, () => MutableRef.make<ReadonlyArray<unknown>>([]));
  static readonly captureLayer = Logger.layer([
    Effect.map(FeedLogs, (messages) =>
      Logger.make((options) =>
        MutableRef.update(messages, (current) => [...current, Logger.formatStructured.log(options)]),
      ),
    ),
  ]).pipe(Layer.provideMerge(FeedLogs.layer));
}

const openSandbox = Effect.fn("file-diff-feed.test.openSandbox")(function* () {
  const handle = yield* Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (h) => Effect.promise(() => h.destroy()),
  );
  const sandbox: WorktreeSandbox = { handle, root: handle.id };
  const init = yield* Effect.promise(() =>
    handle.process.exec("git init -q && printf 'seed\\n' > seed.txt && git add -A && git commit -q -m init", {
      env: gitFixtureEnvironment,
    }),
  );
  assert.strictEqual(init.exitCode, 0, init.stderr);
  return sandbox;
});

const withExecProbe = Effect.fn("file-diff-feed.test.withExecProbe")(function* (sandbox: WorktreeSandbox) {
  const calls = yield* ExecCalls;
  const exec: WorktreeSandbox["handle"]["process"]["exec"] = (command, options) => {
    return sandbox.handle.process.exec(command, options).then((result) => {
      Queue.offerUnsafe(calls, command);
      return result;
    });
  };
  const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) =>
    sandbox.handle.process.spawn(command, options).then((process) => ({
      ...process,
      wait: () =>
        process.wait().then((exitCode) => {
          Queue.offerUnsafe(calls, command);
          return exitCode;
        }),
    }));
  return {
    ...sandbox,
    handle: {
      ...sandbox.handle,
      process: {
        ...sandbox.handle.process,
        exec,
        spawn,
      },
    },
  };
});

const settleDiff = Effect.fn("file-diff-feed.test.settleDiff")(function* (calls: Queue.Queue<string>) {
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* TestClock.adjust("100 millis");
  const ignoreCommand = yield* Stream.fromQueue(calls).pipe(
    Stream.filter((command) => command.startsWith("git check-ignore")),
    Stream.runHead,
  );
  if (Option.isNone(ignoreCommand)) return assert.fail("ignore check did not complete");
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* TestClock.adjust("1 second");
  const diffCommand = yield* Stream.fromQueue(calls).pipe(
    Stream.filter((command) => command.startsWith("git diff")),
    Stream.runHead,
  );
  if (Option.isNone(diffCommand)) return assert.fail("diff did not complete");
  return [ignoreCommand.value, diffCommand.value] as const;
});

describe("file diff feed", () => {
  it.effect("renders a new file as an add-patch diff event", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      yield* writeFile(sandbox, { path: "added.ts", content: "export const x = 1;\n" });
      const before = (yield* Metric.value(fileDiffExecDuration)).count;
      const event = yield* toFileDiffEvent(sandbox, baseSha, {
        type: "create",
        path: "/workspace/added.ts",
        timestamp: 0,
      });
      assert.strictEqual((yield* Metric.value(fileDiffExecDuration)).count, before + 1);
      if (event === null) return assert.fail("expected a diff event");
      assert.strictEqual(event.name, FILE_DIFF_EVENT);
      const value = yield* decodeDiffValue(event.value);
      assert.strictEqual(value.path, "added.ts");
      assert.include(value.diff, "new file");
      assert.include(value.diff, "+export const x = 1;");
    }),
  );

  it.effect("diffs a modified tracked file against the baseline", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      yield* writeFile(sandbox, { path: "seed.txt", content: "seed changed\n" });
      const event = yield* toFileDiffEvent(sandbox, baseSha, {
        type: "change",
        path: "/workspace/seed.txt",
        timestamp: 0,
      });
      if (event === null) return assert.fail("expected a diff event");
      const value = yield* decodeDiffValue(event.value);
      assert.include(value.diff, "-seed");
      assert.include(value.diff, "+seed changed");
    }),
  );

  it.effect("emits nothing for an unchanged tracked file", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      const event = yield* toFileDiffEvent(sandbox, baseSha, {
        type: "change",
        path: "/workspace/seed.txt",
        timestamp: 0,
      });
      assert.isNull(event);
    }),
  );

  it.effect("surfaces a rejected diff subprocess as a typed error", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: {
            ...original.handle.process,
            exec: () => Promise.reject(new Error("subprocess unavailable")),
          },
        },
      };
      const error = yield* computeDiff(sandbox, "base", {
        type: "delete",
        path: "/workspace/seed.txt",
        timestamp: 0,
      }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "exec-failed");
      assert.include(error.message, "subprocess unavailable");
    }),
  );

  it.effect("surfaces a git failure instead of faking a create diff", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "seed.txt", content: "seed changed\n" });
      const error = yield* computeDiff(sandbox, "not-a-commit", {
        type: "change",
        path: "/workspace/seed.txt",
        timestamp: 0,
      }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "exec-failed");
      assert.include(error.message, "git diff");
    }),
  );

  it.effect("aborts a diff subprocess when its deadline expires", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const started = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: {
            ...original.handle.process,
            exec: (_command, options) => {
              const pending = Promise.withResolvers<never>();
              Deferred.doneUnsafe(started, Effect.void);
              options?.signal?.addEventListener(
                "abort",
                () => {
                  Deferred.doneUnsafe(aborted, Effect.void);
                  pending.reject(new Error("aborted"));
                },
                { once: true },
              );
              return pending.promise;
            },
          },
        },
      };
      const fiber = yield* computeDiff(sandbox, "base", {
        type: "change",
        path: "/workspace/seed.txt",
        timestamp: 0,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 minutes");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "timeout");
      assert.isTrue(Option.isSome(yield* Deferred.poll(aborted)));
    }),
  );

  it.effect("escalates a timed-out diff subprocess to SIGKILL", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "hung.txt", content: "hung\n" });
      const started = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();
      const killed = yield* Deferred.make<void>();
      const exit = Promise.withResolvers<number>();
      const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = () => {
        Deferred.doneUnsafe(started, Effect.void);
        return Promise.resolve({
          pid: 1,
          stdout: emptyOutput,
          stderr: emptyOutput,
          stdin: {
            write: () => Promise.resolve(),
            end: () => Promise.resolve(),
          },
          wait: () => exit.promise,
          kill: (signal) => {
            if (signal === "SIGTERM") Deferred.doneUnsafe(terminated, Effect.void);
            if (signal === "SIGKILL") {
              Deferred.doneUnsafe(killed, Effect.void);
              exit.resolve(137);
            }
            return Promise.resolve();
          },
        });
      };
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: { ...original.handle.process, spawn },
        },
      };
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, "").pipe(
        Stream.runDrain,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Queue.offer(events, { _tag: "Create", path: "hung.txt" });
      yield* advanceUntil(started, "1 second");
      yield* advanceUntil(terminated, "5 minutes");
      yield* advanceUntil(killed, "5 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "timeout");
    }),
  );

  it.effect("collapses a per-file event burst into one diff subprocess", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const fileEvents = Array.from({ length: 25 }, () => ({ _tag: "Update", path: "seed.txt" }) as const);
      yield* writeFile(original, { path: "seed.txt", content: "a".repeat(fileDiffMaxBytes * 2) });
      const uncappedDiff = yield* computeDiff(original, baseSha, {
        type: "change",
        path: "/workspace/seed.txt",
        timestamp: 0,
      });
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const before = (yield* Metric.value(fileDiffExecDuration)).count;
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offerAll(events, fileEvents);
      const commands = yield* settleDiff(calls);
      assert.strictEqual((yield* Metric.value(fileDiffExecDuration)).count, before + 1);
      const head = yield* Fiber.join(fiber);
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      assert.isAtMost(commands.length, fileEvents.length / 10);
      assert.lengthOf(
        commands.filter((command) => command.startsWith("git diff")),
        1,
      );
      const value = yield* decodeDiffValue(head.value.value);
      assert.isAtMost(
        Buffer.byteLength(value.diff),
        (Buffer.byteLength(uncappedDiff) * fileEvents.length) / 10,
      );
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("honors nested gitignore rules before starting diff subprocesses", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "packages/.gitignore", content: "dist/\n" });
      yield* writeFile(original, { path: "seed.txt", content: "settled\n" });
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offer(events, { _tag: "Create", path: "packages/dist/bundle.js" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      const commands = yield* settleDiff(calls);
      const head = yield* Fiber.join(fiber);
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      const diffCommands = commands.filter((command) => command.startsWith("git diff"));
      assert.lengthOf(diffCommands, 1);
      assert.notInclude(diffCommands[0], "packages/dist/bundle.js");
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("starts no diff work for a burst of ignored-segment churn", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Effect.forEach(
        Array.from({ length: 1_000 }, (_, index) => `.pnpm-store/v11/files/${index}`),
        (path) => Queue.offer(events, { _tag: "Create", path }),
        { discard: true },
      );
      yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      const commands = yield* settleDiff(calls);
      const head = yield* Fiber.join(fiber);

      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.isFalse(commands.some((command) => command.includes(".pnpm-store")));
      assert.lengthOf(
        commands.filter((command) => command.startsWith("git diff")),
        1,
      );
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("flushes a debounced diff when the caller stops the feed", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* writeFile(original, { path: "seed.txt", content: "written just before the stop\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));

      // Clock never reaches the 250ms debounce, so only the flush can produce it.
      yield* Deferred.succeed(stop, undefined);
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      const head = yield* Fiber.join(fiber);

      if (Option.isNone(head)) return assert.fail("stopping the feed dropped the pending diff");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+written just before the stop");
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("skips directory events before starting diff subprocesses", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* Effect.promise(() => original.handle.fs.mkdir("build"));
      yield* writeFile(original, { path: "seed.txt", content: "settled\n" });
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offer(events, { _tag: "Create", path: "build" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* TestClock.adjust("100 millis");
      const ignoreCommand = yield* Stream.fromQueue(calls).pipe(
        Stream.filter((command) => command.startsWith("git check-ignore")),
        Stream.runHead,
      );
      if (Option.isNone(ignoreCommand)) return assert.fail("ignore check did not complete");
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      const head = yield* Fiber.join(fiber);
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      const remainingCommands = yield* Queue.takeAll(calls);
      const commands = [ignoreCommand.value, ...remainingCommands];
      const diffCommands = commands.filter((command) => command.startsWith("git diff"));
      assert.lengthOf(diffCommands, 1);
      assert.include(diffCommands[0], "seed.txt");
      assert.notInclude(diffCommands[0], "build");
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("skips removed directory events before starting diff subprocesses", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "tracked/first.txt", content: "first\n" });
      yield* writeFile(original, { path: "tracked/second.txt", content: "second\n" });
      const commit = yield* Effect.promise(() =>
        original.handle.process.exec("git add -A && git commit -q -m tracked-directory", {
          env: gitFixtureEnvironment,
        }),
      );
      assert.strictEqual(commit.exitCode, 0, commit.stderr);
      const baseSha = yield* resolveBaseSha(original);
      yield* Effect.promise(() => original.handle.fs.remove("tracked"));
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const shipped = yield* Queue.unbounded<ReturnType<typeof fileDiffEvent>>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.runForEach((event) => Queue.offer(shipped, event)),
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offer(events, { _tag: "Remove", path: "tracked" });
      yield* TestClock.adjust("100 millis");
      yield* Stream.fromQueue(calls).pipe(
        Stream.filter((command) => command.startsWith("git check-ignore")),
        Stream.runHead,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      const directoryCommand = yield* Stream.fromQueue(calls).pipe(
        Stream.filter((command) => command.includes("'tracked'")),
        Stream.runHead,
      );
      if (Option.isNone(directoryCommand)) return assert.fail("directory classification did not complete");
      assert.notMatch(directoryCommand.value, /^git diff /);
      assert.isTrue(Option.isNone(yield* Queue.poll(shipped)));
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.live(
    "keeps streaming when an untracked file vanishes before its add patch",
    () =>
      Effect.gen(function* () {
        const original = yield* openSandbox();
        const baseSha = yield* resolveBaseSha(original);
        yield* writeFile(original, { path: "vanished.txt", content: "gone\n" });
        const addPatchStarted = yield* Deferred.make<void>();
        const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) => {
          if (!command.startsWith("git diff --no-index")) {
            return original.handle.process.spawn(command, options);
          }
          return original.handle.fs.remove("vanished.txt").then(() => {
            Deferred.doneUnsafe(addPatchStarted, Effect.void);
            return original.handle.process.spawn(command, options);
          });
        };
        const sandbox: WorktreeSandbox = {
          ...original,
          handle: {
            ...original.handle,
            process: { ...original.handle.process, spawn },
          },
        };
        const events = yield* Queue.make<FileSystem.WatchEvent>();
        const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
          Effect.forkChild,
        );
        yield* Queue.offer(events, { _tag: "Create", path: "vanished.txt" });
        yield* Deferred.await(addPatchStarted).pipe(Effect.timeout("15 seconds"));
        yield* writeFile(sandbox, { path: "seed.txt", content: "still streaming\n" });
        yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
        const head = yield* Fiber.join(fiber).pipe(Effect.timeout("15 seconds"));
        if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
        const value = yield* decodeDiffValue(head.value.value);
        assert.strictEqual(value.path, "seed.txt");
        assert.include(value.diff, "+still streaming");
      }),
    20000,
  );

  it.effect("does not ship the same full diff twice", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));

      yield* writeFile(sandbox, { path: "seed.txt", content: "first\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);

      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);

      yield* writeFile(sandbox, { path: "seed.txt", content: "second\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);

      const shipped = yield* Fiber.join(fiber);
      assert.lengthOf(shipped, 2);
      const values = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
      assert.include(values[0].diff, "+first");
      assert.include(values[1].diff, "+second");
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("does not ship empty diffs when a file returns to baseline", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const shipped = yield* Queue.unbounded<ReturnType<typeof fileDiffEvent>>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.runForEach((event) => Queue.offer(shipped, event)),
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));

      yield* writeFile(sandbox, { path: "seed.txt", content: "first\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);
      const first = yield* Queue.take(shipped);

      yield* writeFile(sandbox, { path: "seed.txt", content: "seed\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      assert.isTrue(Option.isNone(yield* Queue.poll(shipped)));

      yield* writeFile(sandbox, { path: "seed.txt", content: "first\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);
      const repeated = yield* Queue.take(shipped);
      yield* Fiber.interrupt(fiber);

      const values = yield* Effect.forEach([first, repeated], (event) => decodeDiffValue(event.value));
      assert.isTrue(values.every((value) => value.diff !== ""));
      assert.include(values[1].diff, "+first");
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("ships a second large diff when the raw diff changes past the cap", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      const sharedPrefix = "a".repeat(fileDiffMaxBytes);
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));

      yield* writeFile(sandbox, { path: "seed.txt", content: `${sharedPrefix}first\n` });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);

      yield* writeFile(sandbox, { path: "seed.txt", content: `${sharedPrefix}second\n` });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);

      const shipped = yield* Fiber.join(fiber);
      assert.lengthOf(shipped, 2);
      const values = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
      assert.isTrue(values.every((value) => value.diff.endsWith(diffTruncationMarker)));
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("caps diff payload bytes and appends a truncation marker", () =>
    Effect.gen(function* () {
      const event = fileDiffEvent("large.txt", "🙂".repeat(fileDiffMaxBytes));
      const value = yield* decodeDiffValue(event.value);
      assert.isAtMost(Buffer.byteLength(value.diff), fileDiffMaxBytes);
      assert.isTrue(value.diff.endsWith(diffTruncationMarker));
    }),
  );

  it.live(
    "streams a diff event when a tool writes through the sandbox, skipping ignored paths",
    () =>
      Effect.gen(function* () {
        const sandbox = yield* openSandbox();
        const baseSha = yield* resolveBaseSha(sandbox);
        const events = yield* Queue.make<FileSystem.WatchEvent>();
        const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
          Effect.forkChild,
        );
        yield* writeFile(sandbox, { path: "watched.txt", content: "hello from a tool\n" });
        yield* Queue.offer(events, { _tag: "Update", path: "node_modules/dep/index.js" });
        yield* Queue.offer(events, { _tag: "Update", path: "watched.txt" });
        const head = yield* Fiber.join(fiber).pipe(Effect.timeout("15 seconds"));
        if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
        assert.strictEqual(head.value.name, FILE_DIFF_EVENT);
        const value = yield* decodeDiffValue(head.value.value);
        assert.strictEqual(value.path, "watched.txt");
        assert.include(value.diff, "+hello from a tool");
      }),
    20000,
  );

  it.live(
    "diffs a tracked file the watcher reports after it was removed",
    () =>
      Effect.gen(function* () {
        const sandbox = yield* openSandbox();
        const baseSha = yield* resolveBaseSha(sandbox);
        yield* Effect.promise(() => sandbox.handle.fs.remove("seed.txt"));
        const events = yield* Queue.make<FileSystem.WatchEvent>();
        const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
          Effect.forkChild,
        );
        yield* Queue.offer(events, { _tag: "Create", path: "seed.txt" });
        const head = yield* Fiber.join(fiber).pipe(Effect.timeout("15 seconds"));
        if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
        const value = yield* decodeDiffValue(head.value.value);
        assert.strictEqual(value.path, "seed.txt");
        assert.include(value.diff, "-seed");
      }),
    20000,
  );

  it.live(
    "keeps streaming when the existence check rejects",
    () =>
      Effect.gen(function* () {
        const original = yield* openSandbox();
        const sandbox: WorktreeSandbox = {
          ...original,
          handle: {
            ...original.handle,
            fs: { ...original.handle.fs, exists: () => Promise.reject(new Error("stat blew up")) },
          },
        };
        const baseSha = yield* resolveBaseSha(sandbox);
        yield* writeFile(sandbox, { path: "seed.txt", content: "seed changed\n" });
        const events = yield* Queue.make<FileSystem.WatchEvent>();
        const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
          Effect.forkChild,
        );
        yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
        const head = yield* Fiber.join(fiber).pipe(Effect.timeout("15 seconds"));
        if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
        const value = yield* decodeDiffValue(head.value.value);
        assert.strictEqual(value.path, "seed.txt");
        assert.include(value.diff, "+seed changed");
      }),
    20000,
  );

  it.live("falls back when the native watcher fails at open and logs the cause", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      const logs = yield* FeedLogs;
      yield* writeFile(sandbox, { path: "seed.txt", content: "changed before watch opened\n" });

      const head = yield* awaitLiveEffect(
        watchWorktreeDiffs(sandbox, baseSha).pipe(Stream.take(1), Stream.runHead),
        "10 seconds",
      );

      if (Option.isNone(head)) return assert.fail("fallback produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+changed before watch opened");
      const entries = MutableRef.get(logs);
      assert.lengthOf(entries, 1);
      const record = yield* Schema.decodeUnknownEffect(WatcherFallbackLog)(entries[0]);
      assert.include(record.message[1].cause, "EMFILE: too many open files, watch");
      assert.strictEqual(record.annotations.checkout, sandbox.root);
      assert.strictEqual(record.annotations.source, "polling");
    }).pipe(Effect.provide(Layer.mergeAll(FeedLogs.captureLayer, deniedWatcherLayer))),
  );

  it.live("falls back after an asynchronous watcher failure and finds an earlier write", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      const watcher = yield* WatcherSignals;
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* writeFile(sandbox, { path: "seed.txt", content: "changed before watcher failure\n" });
      yield* Queue.offer(watcher, { _tag: "Fail" });

      const head = yield* awaitLiveEffect(Fiber.join(fiber), "10 seconds");
      if (Option.isNone(head)) return assert.fail("fallback produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+changed before watcher failure");
    }).pipe(Effect.provide(queuedWatcherLayer())),
  );

  it.live("keeps polling after a transient fallback command failure", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "changed after a failed poll\n" });
      const failNextPoll = MutableRef.make(true);
      const exec: WorktreeSandbox["handle"]["process"]["exec"] = (command, options) => {
        if (command.startsWith("git diff --name-only") && MutableRef.getAndSet(failNextPoll, false)) {
          return Promise.resolve({ stdout: "", stderr: "temporary poll failure", exitCode: 1 });
        }
        return original.handle.process.exec(command, options);
      };
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: { ...original.handle.process, exec },
        },
      };

      const head = yield* awaitLiveEffect(
        watchWorktreeDiffs(sandbox, baseSha).pipe(Stream.take(1), Stream.runHead),
        "10 seconds",
      );

      if (Option.isNone(head)) return assert.fail("fallback produced no diff event after retry");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+changed after a failed poll");
    }).pipe(Effect.provide(deniedWatcherLayer)),
  );

  it.live("emits an identical diff again after the file returns to baseline", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const stop = yield* Deferred.make<void>();
      const shipped = yield* Queue.unbounded<ReturnType<typeof fileDiffEvent>>();
      yield* writeFile(original, { path: "seed.txt", content: "first change\n" });
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runForEach((event) => Queue.offer(shipped, event)),
        Effect.forkChild,
      );

      yield* awaitLiveEffect(Queue.take(shipped), "10 seconds");
      yield* Queue.takeAll(calls);
      yield* writeFile(original, { path: "seed.txt", content: "seed\n" });
      yield* awaitLiveEffect(
        Stream.fromQueue(calls).pipe(
          Stream.filter((command) => command.startsWith("git diff --name-only")),
          Stream.take(1),
          Stream.runDrain,
        ),
        "10 seconds",
      );
      yield* writeFile(original, { path: "seed.txt", content: "first change\n" });

      const repeated = yield* awaitLiveEffect(Queue.take(shipped), "10 seconds");
      yield* Deferred.succeed(stop, undefined);
      yield* Fiber.join(fiber);
      const value = yield* decodeDiffValue(repeated.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+first change");
    }).pipe(Effect.provide(deniedWatcherWithExecCalls)),
  );

  it.live("reconciles fingerprint state when the watcher misses a baseline restoration before failing", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const stop = yield* Deferred.make<void>();
      const watcher = yield* WatcherSignals;
      const shipped = yield* Queue.unbounded<ReturnType<typeof fileDiffEvent>>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runForEach((event) => Queue.offer(shipped, event)),
        Effect.forkChild,
      );
      yield* writeFile(sandbox, { path: "seed.txt", content: "first change\n" });
      yield* Queue.offer(watcher, { _tag: "Update", path: "seed.txt" });
      yield* awaitLiveEffect(Queue.take(shipped), "10 seconds");
      yield* writeFile(sandbox, { path: "seed.txt", content: "seed\n" });
      yield* Queue.offer(watcher, { _tag: "Fail" });
      yield* awaitLiveEffect(
        Stream.fromQueue(calls).pipe(
          Stream.filter((command) => command.startsWith("git diff --name-only")),
          Stream.take(1),
          Stream.runDrain,
        ),
        "10 seconds",
      );
      yield* writeFile(sandbox, { path: "seed.txt", content: "first change\n" });

      const repeated = yield* awaitLiveEffect(Queue.take(shipped), "10 seconds");
      yield* Deferred.succeed(stop, undefined);
      yield* Fiber.join(fiber);
      const value = yield* decodeDiffValue(repeated.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+first change");
    }).pipe(Effect.provide(Layer.mergeAll(queuedWatcherLayer(), ExecCalls.layer))),
  );

  it.live("drops a native diff that finishes after polling advances the checkout snapshot", () => {
    const releaseDiff = Promise.withResolvers<void>();
    return Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const watcher = yield* WatcherSignals;
      const diffStarted = yield* Deferred.make<void>();
      const delayNextDiff = MutableRef.make(true);
      const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) =>
        original.handle.process.spawn(command, options).then((process) => {
          if (!command.startsWith("git diff '") || !MutableRef.getAndSet(delayNextDiff, false)) {
            return process;
          }
          Deferred.doneUnsafe(diffStarted, Effect.void);
          return {
            ...process,
            wait: () => process.wait().then((exitCode) => releaseDiff.promise.then(() => exitCode)),
          };
        });
      const sandbox = yield* withExecProbe({
        ...original,
        handle: {
          ...original.handle,
          process: { ...original.handle.process, spawn },
        },
      });
      const stop = yield* Deferred.make<void>();
      const shipped = yield* Queue.unbounded<ReturnType<typeof fileDiffEvent>>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runForEach((event) => Queue.offer(shipped, event)),
        Effect.forkChild,
      );
      yield* writeFile(sandbox, { path: "seed.txt", content: "first change\n" });
      yield* Queue.offer(watcher, { _tag: "Update", path: "seed.txt" });
      yield* Deferred.await(diffStarted).pipe(Effect.timeout("10 seconds"));
      yield* Queue.takeAll(calls);
      yield* writeFile(sandbox, { path: "seed.txt", content: "seed\n" });
      yield* Queue.offer(watcher, { _tag: "Fail" });
      yield* Stream.fromQueue(calls).pipe(
        Stream.filter((command) => command.startsWith("git diff --name-only")),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("10 seconds"),
      );
      releaseDiff.resolve();
      yield* writeFile(sandbox, { path: "seed.txt", content: "first change\n" });

      const event = yield* Queue.take(shipped).pipe(Effect.timeout("10 seconds"));
      yield* Deferred.succeed(stop, undefined);
      yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"));
      const value = yield* decodeDiffValue(event.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+first change");
    }).pipe(
      Effect.ensuring(Effect.sync(() => releaseDiff.resolve())),
      Effect.provide(Layer.mergeAll(queuedWatcherLayer(), ExecCalls.layer)),
    );
  });

  it.live(
    "keeps an older polling diff valid while its path stays dirty",
    () => {
      const releaseDiff = Promise.withResolvers<void>();
      return Effect.gen(function* () {
        const original = yield* openSandbox();
        const baseSha = yield* resolveBaseSha(original);
        yield* writeFile(original, { path: "seed.txt", content: "slow polling diff\n" });
        const pollCount = MutableRef.make(0);
        const diffCount = MutableRef.make(0);
        const secondPollCompleted = yield* Deferred.make<void>();
        const blockedPoll = Promise.withResolvers<never>();
        const exec: WorktreeSandbox["handle"]["process"]["exec"] = (command, options) => {
          if (!command.startsWith("git diff --name-only")) {
            return original.handle.process.exec(command, options);
          }
          const current = MutableRef.updateAndGet(pollCount, (count) => count + 1);
          if (current >= 3) return blockedPoll.promise;
          return original.handle.process.exec(command, options).then((result) => {
            if (current === 2) Deferred.doneUnsafe(secondPollCompleted, Effect.void);
            return result;
          });
        };
        const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) => {
          if (!command.startsWith("git diff '")) return original.handle.process.spawn(command, options);
          const current = MutableRef.updateAndGet(diffCount, (count) => count + 1);
          if (current === 2) return Promise.reject(new Error("temporary second diff failure"));
          return original.handle.process.spawn(command, options).then((process) => ({
            ...process,
            wait: () => process.wait().then((exitCode) => releaseDiff.promise.then(() => exitCode)),
          }));
        };
        const sandbox: WorktreeSandbox = {
          ...original,
          handle: {
            ...original.handle,
            process: { ...original.handle.process, exec, spawn },
          },
        };
        const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.await(secondPollCompleted).pipe(Effect.timeout("10 seconds"));
        releaseDiff.resolve();

        const head = yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"));
        if (Option.isNone(head)) return assert.fail("older polling diff was discarded");
        const value = yield* decodeDiffValue(head.value.value);
        assert.strictEqual(value.path, "seed.txt");
        assert.include(value.diff, "+slow polling diff");
      }).pipe(Effect.ensuring(Effect.sync(() => releaseDiff.resolve())), Effect.provide(deniedWatcherLayer));
    },
    15000,
  );

  it.live("keeps polling after a transient fallback diff failure", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "changed after diff failure\n" });
      const failNextDiff = MutableRef.make(true);
      const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) => {
        if (
          command.startsWith("git diff '") &&
          command.endsWith("-- 'seed.txt'") &&
          MutableRef.getAndSet(failNextDiff, false)
        ) {
          return Promise.reject(new Error("temporary diff failure"));
        }
        return original.handle.process.spawn(command, options);
      };
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: { ...original.handle.process, spawn },
        },
      };

      const head = yield* awaitLiveEffect(
        watchWorktreeDiffs(sandbox, baseSha).pipe(Stream.take(1), Stream.runHead),
        "10 seconds",
      );

      if (Option.isNone(head)) return assert.fail("fallback produced no diff event after retry");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+changed after diff failure");
    }).pipe(Effect.provide(deniedWatcherLayer)),
  );

  it.live("applies filtering, capping, and fingerprint dedupe to fallback events", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "packages/.gitignore", content: "dist/\n" });
      const commit = yield* Effect.promise(() =>
        original.handle.process.exec("git add -A && git commit -q -m ignore-fixture", {
          env: gitFixtureEnvironment,
        }),
      );
      assert.strictEqual(commit.exitCode, 0, commit.stderr);
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "packages/dist/bundle.js", content: "ignored\n" });
      yield* writeFile(original, { path: "seed.txt", content: "a".repeat(fileDiffMaxBytes * 2) });
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* awaitLiveEffect(
        Stream.fromQueue(calls).pipe(
          Stream.filter((command) => command.startsWith("git diff --name-only")),
          Stream.take(2),
          Stream.runDrain,
        ),
        "10 seconds",
      );
      yield* Deferred.succeed(stop, undefined);

      const events = [...(yield* Fiber.join(fiber))];
      assert.lengthOf(events, 1);
      const value = yield* decodeDiffValue(events[0]?.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.isAtMost(Buffer.byteLength(value.diff), fileDiffMaxBytes);
    }).pipe(Effect.provide(deniedWatcherWithExecCalls)),
  );

  it.live("debounces overlapping scheduled and final fallback polls by path", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "changed during fallback\n" });
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Stream.fromQueue(calls).pipe(
        Stream.filter((command) => command.startsWith("git diff --name-only")),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* Deferred.succeed(stop, undefined);

      const events = [...(yield* Fiber.join(fiber))];
      const commands = [...(yield* Queue.takeAll(calls))];
      assert.lengthOf(
        commands.filter((command) => command.startsWith("git diff --name-only")),
        1,
      );
      assert.lengthOf(
        commands.filter((command) => command.startsWith("git diff '") && command.endsWith("-- 'seed.txt'")),
        1,
      );
      assert.lengthOf(events, 1);
    }).pipe(Effect.provide(deniedWatcherWithExecCalls)),
  );

  it.effect("does not warn when a consumer tears the feed down", () =>
    Effect.gen(function* () {
      const logs = yield* FeedLogs;
      const events = yield* Stream.fromEffect(Effect.interrupt).pipe(
        tolerateFeedDeath("file diff feed stopped"),
        Stream.runCollect,
      );

      assert.isEmpty([...events]);
      assert.deepStrictEqual(MutableRef.get(logs), []);
    }).pipe(Effect.provide(FeedLogs.captureLayer)),
  );
});
