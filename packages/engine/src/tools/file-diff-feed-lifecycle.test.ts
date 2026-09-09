import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { computeDiff, type fileDiffEvent, fileDiffExecDuration, watchWorktreeDiffs } from "./file-diff-feed";
import {
  advanceUntil,
  decodeDiffValue,
  ExecCalls,
  emptyOutput,
  fileDiffMaxBytes,
  gitFixtureEnvironment,
  openSandbox,
  settleDiff,
  withExecProbe,
} from "./file-diff-fixtures";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

describe("file diff lifecycle", () => {
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

  it.effect(
    "escalates a timed-out diff subprocess to SIGKILL",
    () =>
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
    10_000,
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
});
