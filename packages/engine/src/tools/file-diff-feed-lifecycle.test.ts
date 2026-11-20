import type { AgUiEvent } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { watchWorktreeDiffs } from "./file-diff-feed";
import {
  advanceUntil,
  decodeDiffValue,
  ExecCalls,
  fileDiffMaxBytes,
  gitDiffCommand,
  gitFixtureEnvironment,
  HeldListCalls,
  isBatchDiffCommand,
  isExternalDiffProbe,
  isGitDiffCommand,
  isGitIgnoreCommand,
  openSandbox,
  settleDiff,
  settleWhileAdvancingClock,
  startBlockedBatch,
  takeAllCalls,
  testProcessSignal,
  withExecProbe,
  withHeldListCalls,
  yieldToHost,
} from "./file-diff-fixtures";
import { computeDiff, fileDiffExecDuration } from "./file-diff-git";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

describe("file diff lifecycle", { timeout: 30_000 }, () => {
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

  it.effect("escalates a timed-out batched diff subprocess to SIGKILL", () =>
    Effect.gen(function* () {
      const { fiber, terminated, killed } = yield* startBlockedBatch("SIGKILL");
      yield* advanceUntil(terminated, "5 minutes");
      yield* advanceUntil(killed, "5 seconds");
      yield* TestClock.adjust("100 millis");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.strictEqual(error.reason, "timeout");
    }),
  );

  it.effect("terminates an interrupted batched diff subprocess", () =>
    Effect.gen(function* () {
      const { fiber, terminated } = yield* startBlockedBatch("SIGTERM");
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(terminated);
    }),
  );

  it.effect("starts no external-diff probe for a single settled path", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = [{ _tag: "Update", path: "seed.txt" }] satisfies ReadonlyArray<FileSystem.WatchEvent>;
      const shipped = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromIterable(events) })),
      );
      assert.lengthOf(shipped, 1);
      const gitCommands = (yield* takeAllCalls(calls)).filter((command) => command.startsWith("git "));
      assert.isFalse(gitCommands.some(isBatchDiffCommand));
      assert.isFalse(gitCommands.some(isExternalDiffProbe));
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("probes for an external diff helper once across batches", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "other.txt", content: "other\n" });
      yield* writeFile(original, { path: "third.txt", content: "third\n" });
      const commit = yield* Effect.promise((signal) =>
        original.handle.process.exec("git add -A && git commit -q -m probe-reuse-fixture", {
          env: gitFixtureEnvironment,
          signal: testProcessSignal(signal),
        }),
      );
      assert.strictEqual(commit.exitCode, 0, commit.stderr);
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const shipped = yield* Queue.make<AgUiEvent>();
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runForEach((event) => Queue.offer(shipped, event)),
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* yieldToHost();
      const round = Effect.fn("file-diff-feed.test.round")(function* (label: string) {
        yield* writeFile(original, { path: "seed.txt", content: `seed ${label}\n` });
        yield* writeFile(original, { path: "other.txt", content: `other ${label}\n` });
        yield* writeFile(original, { path: "third.txt", content: `third ${label}\n` });
        yield* Queue.offerAll(events, [
          { _tag: "Update", path: "seed.txt" },
          { _tag: "Update", path: "other.txt" },
          { _tag: "Update", path: "third.txt" },
        ]);
        return yield* settleWhileAdvancingClock(
          Stream.fromQueue(shipped).pipe(Stream.take(3), Stream.runCollect),
        );
      });
      assert.lengthOf(yield* round("first"), 3);
      assert.lengthOf(yield* round("second"), 3);
      yield* Deferred.succeed(stop, undefined);
      yield* Fiber.join(fiber);
      const commands = yield* takeAllCalls(calls);
      assert.lengthOf(commands.filter(isExternalDiffProbe), 1);
      assert.isAtLeast(commands.filter(isBatchDiffCommand).length, 2);
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("batches a burst whose classification outlasts the batch window", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const paths = ["seed.txt", "other.txt", "third.txt"];
      yield* Effect.forEach(paths, (path) => writeFile(original, { path, content: `${path} changed\n` }));
      const calls = yield* ExecCalls;
      const held = yield* HeldListCalls;
      const sandbox = yield* withHeldListCalls(yield* withExecProbe(original));
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(paths.length),
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* yieldToHost();
      yield* Queue.offerAll(
        events,
        paths.map((path) => ({ _tag: "Update", path }) as const),
      );
      yield* yieldToHost();
      // Holding the clock at 50ms while `check-ignore` runs keeps the debounce off a batch-window tick.
      yield* TestClock.adjust("50 millis");
      yield* Stream.fromQueue(calls).pipe(Stream.filter(isGitIgnoreCommand), Stream.runHead);
      yield* yieldToHost();
      yield* settleWhileAdvancingClock(Queue.take(held)).pipe(
        Effect.tap(() => TestClock.adjust("300 millis")),
        Effect.flatMap((release) => Effect.sync(release)),
        Effect.repeat({ times: paths.length - 1 }),
      );
      assert.lengthOf(yield* settleWhileAdvancingClock(Fiber.join(fiber)), paths.length);
      const batchCommands = (yield* takeAllCalls(calls)).filter(isBatchDiffCommand);
      assert.lengthOf(batchCommands, 1);
      paths.forEach((path) => {
        assert.include(batchCommands[0], `'${path}'`);
      });
    }).pipe(Effect.provide(Layer.merge(ExecCalls.layer, HeldListCalls.layer))),
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
      yield* yieldToHost();
      yield* Queue.offerAll(events, fileEvents);
      const commands = yield* settleDiff(calls);
      assert.strictEqual((yield* Metric.value(fileDiffExecDuration)).count, before + 1);
      const head = yield* Fiber.join(fiber);
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      assert.isAtMost(commands.length, fileEvents.length / 10);
      assert.lengthOf(commands.filter(isGitDiffCommand), 1);
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
      yield* yieldToHost();
      yield* Queue.offer(events, { _tag: "Create", path: "packages/dist/bundle.js" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      const commands = yield* settleDiff(calls);
      const head = yield* Fiber.join(fiber);
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      const diffCommands = commands.filter(isGitDiffCommand);
      assert.lengthOf(diffCommands, 1);
      assert.notInclude(diffCommands[0], "packages/dist/bundle.js");
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("starts no diff work for a burst of ignored-segment churn", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = [
        ...Array.from({ length: 1_000 }, (_, index) => ({
          _tag: "Create" as const,
          path: `.pnpm-store/v11/files/${index}`,
        })),
        { _tag: "Update" as const, path: "seed.txt" },
      ];
      const head = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromIterable(events) })),
      );
      const commands = yield* takeAllCalls(calls);

      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.isFalse(commands.some((command) => command.includes(".pnpm-store")));
      assert.lengthOf(commands.filter(isGitDiffCommand), 1);
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
      yield* yieldToHost();
      yield* writeFile(original, { path: "seed.txt", content: "written just before the stop\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* yieldToHost();

      // Clock never reaches the 250ms debounce, so only the flush can produce it.
      yield* Deferred.succeed(stop, undefined);
      yield* yieldToHost();
      yield* TestClock.adjust("100 millis");
      yield* yieldToHost();
      yield* TestClock.adjust("100 millis");
      yield* yieldToHost();
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
      const events = [
        { _tag: "Create", path: "build" },
        { _tag: "Update", path: "seed.txt" },
      ] satisfies ReadonlyArray<FileSystem.WatchEvent>;
      const head = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromIterable(events) })),
      );
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      const commands = yield* takeAllCalls(calls);
      const diffCommands = commands.filter(isGitDiffCommand);
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
      const shipped = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.runCollect,
        Effect.provide(
          FileSystem.layerNoop({
            watch: () => Stream.make({ _tag: "Remove", path: "tracked" }),
          }),
        ),
      );
      const commands = yield* takeAllCalls(calls);
      const directoryCommand = commands.find((command) => command.includes("'tracked'"));
      if (!directoryCommand) return assert.fail("directory classification did not complete");
      assert.isFalse(isGitDiffCommand(directoryCommand));
      assert.lengthOf(shipped, 0);
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.live("keeps streaming when an untracked file vanishes before its add patch", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "vanished.txt", content: "gone\n" });
      const addPatchStarted = yield* Deferred.make<void>();
      const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) => {
        if (!command.startsWith(`${gitDiffCommand} --no-index`)) {
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
  );
});
