import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { type fileDiffEvent, tolerateFeedDeath, watchWorktreeDiffs } from "./file-diff-feed";
import {
  decodeDiffValue,
  ExecCalls,
  fileDiffMaxBytes,
  gitFixtureEnvironment,
  isExternalDiffProbe,
  isGitDiffCommand,
  openSandbox,
  settleWhileAdvancingClock,
  takeAllCalls,
  testProcessSignal,
  withExecProbe,
  yieldToHost,
} from "./file-diff-fixtures";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

const WatcherFallbackLog = Schema.Struct({
  message: Schema.Tuple([Schema.String, Schema.Struct({ cause: Schema.String })]),
  annotations: Schema.Struct({ checkout: Schema.String, source: Schema.String }),
});

const watcherFailure = () =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "watch",
    cause: new Error("EMFILE: too many open files, watch"),
  });

const deniedWatcherLayer = FileSystem.layerNoop({ watch: () => Stream.fail(watcherFailure()) });

const awaitTestEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.raceFirst(
      TestClock.adjust("50 millis").pipe(
        Effect.andThen(TestClock.withLive(Effect.sleep("1 millis"))),
        Effect.forever,
      ),
    ),
  );

type WatcherSignal = FileSystem.WatchEvent | { readonly _tag: "Fail" };

class WatcherSignals extends Context.Service<WatcherSignals, Queue.Queue<WatcherSignal>>()(
  "@cogwork/engine/tools/file-diff-feed-fallback.test/WatcherSignals",
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
  "@cogwork/engine/tools/file-diff-feed-fallback.test/FeedLogs",
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

describe("file diff fallback", { timeout: 30_000 }, () => {
  it.effect("falls back when the native watcher fails at open and logs the cause", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      const logs = yield* FeedLogs;
      yield* writeFile(sandbox, { path: "seed.txt", content: "changed before watch opened\n" });

      const head = yield* awaitTestEffect(
        watchWorktreeDiffs(sandbox, baseSha).pipe(Stream.take(1), Stream.runHead),
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

  it.effect("falls back after an asynchronous watcher failure and finds an earlier write", () =>
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

      const head = yield* awaitTestEffect(Fiber.join(fiber));
      if (Option.isNone(head)) return assert.fail("fallback produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+changed before watcher failure");
    }).pipe(Effect.provide(queuedWatcherLayer())),
  );

  it.effect(
    "keeps polling when native diff work fails just before watcher fallback",
    () =>
      Effect.gen(function* () {
        const original = yield* openSandbox();
        const baseSha = yield* resolveBaseSha(original);
        const watcher = yield* WatcherSignals;
        const diffFailed = yield* Deferred.make<void>();
        const failNextDiff = MutableRef.make(true);
        const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) =>
          original.handle.process.spawn(command, options).then((process) => {
            if (!isGitDiffCommand(command) || !MutableRef.getAndSet(failNextDiff, false)) return process;
            return {
              ...process,
              wait: () =>
                process.wait().then(() => {
                  Deferred.doneUnsafe(diffFailed, Effect.void);
                  return Promise.reject(new Error("concurrent native diff failure"));
                }),
            };
          });
        const sandbox: WorktreeSandbox = {
          ...original,
          handle: {
            ...original.handle,
            process: { ...original.handle.process, spawn },
          },
        };
        yield* writeFile(sandbox, { path: "seed.txt", content: "changed before concurrent failure\n" });
        const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Queue.offer(watcher, { _tag: "Update", path: "seed.txt" });
        yield* settleWhileAdvancingClock(Deferred.await(diffFailed));
        yield* yieldToHost();
        yield* Queue.offer(watcher, { _tag: "Fail" });

        const head = yield* settleWhileAdvancingClock(Fiber.join(fiber));
        if (Option.isNone(head)) return assert.fail("fallback produced no diff event");
        const value = yield* decodeDiffValue(head.value.value);
        assert.strictEqual(value.path, "seed.txt");
        assert.include(value.diff, "+changed before concurrent failure");
      }).pipe(Effect.provide(queuedWatcherLayer())),
    10_000,
  );

  it.effect("emits both sides of a rename through fallback polling", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const moved = yield* Effect.promise((signal) =>
        original.handle.process.exec("git mv seed.txt renamed.txt", {
          env: gitFixtureEnvironment,
          signal: testProcessSignal(signal),
        }),
      );
      assert.strictEqual(moved.exitCode, 0, moved.stderr);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* awaitTestEffect(
        Stream.fromQueue(calls).pipe(Stream.filter(isGitDiffCommand), Stream.take(1), Stream.runDrain),
      );
      yield* Deferred.succeed(stop, undefined);

      const events = yield* Fiber.join(fiber);
      const values = yield* Effect.forEach(events, (event) => decodeDiffValue(event.value));
      assert.deepStrictEqual(values.map(({ path }) => path).sort(), ["renamed.txt", "seed.txt"]);
    }).pipe(Effect.provide(deniedWatcherWithExecCalls)),
  );

  it.effect("keeps polling after a transient fallback command failure", () =>
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

      const head = yield* awaitTestEffect(
        watchWorktreeDiffs(sandbox, baseSha).pipe(Stream.take(1), Stream.runHead),
      );

      if (Option.isNone(head)) return assert.fail("fallback produced no diff event after retry");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+changed after a failed poll");
    }).pipe(Effect.provide(deniedWatcherLayer)),
  );

  it.effect(
    "emits an identical diff again after the file returns to baseline",
    () =>
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

        yield* awaitTestEffect(Queue.take(shipped));
        yield* Queue.takeAll(calls);
        yield* writeFile(original, { path: "seed.txt", content: "seed\n" });
        yield* awaitTestEffect(
          Stream.fromQueue(calls).pipe(
            Stream.filter((command) => command.startsWith("git diff --name-only")),
            Stream.take(2),
            Stream.runDrain,
          ),
        );
        yield* writeFile(original, { path: "seed.txt", content: "first change\n" });

        const repeated = yield* awaitTestEffect(Queue.take(shipped));
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        const value = yield* decodeDiffValue(repeated.value);
        assert.strictEqual(value.path, "seed.txt");
        assert.include(value.diff, "+first change");
      }).pipe(Effect.provide(deniedWatcherWithExecCalls)),
    10_000,
  );

  it.effect(
    "reconciles fingerprint state when the watcher misses a baseline restoration before failing",
    () =>
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
        yield* awaitTestEffect(Queue.take(shipped));
        yield* writeFile(sandbox, { path: "seed.txt", content: "seed\n" });
        yield* Queue.offer(watcher, { _tag: "Fail" });
        yield* awaitTestEffect(
          Stream.fromQueue(calls).pipe(
            Stream.filter((command) => command.startsWith("git diff --name-only")),
            Stream.take(1),
            Stream.runDrain,
          ),
        );
        yield* writeFile(sandbox, { path: "seed.txt", content: "first change\n" });

        const repeated = yield* awaitTestEffect(Queue.take(shipped));
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        const value = yield* decodeDiffValue(repeated.value);
        assert.strictEqual(value.path, "seed.txt");
        assert.include(value.diff, "+first change");
      }).pipe(Effect.provide(Layer.mergeAll(queuedWatcherLayer(), ExecCalls.layer))),
  );

  const verifyLateNativeDiffDoesNotWin = (settle: (exitCode: number) => Promise<number>) => {
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
          if (!isGitDiffCommand(command) || !MutableRef.getAndSet(delayNextDiff, false)) {
            return process;
          }
          Deferred.doneUnsafe(diffStarted, Effect.void);
          return {
            ...process,
            wait: () => process.wait().then((exitCode) => releaseDiff.promise.then(() => settle(exitCode))),
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
      yield* awaitTestEffect(Deferred.await(diffStarted));
      yield* Queue.takeAll(calls);
      yield* writeFile(sandbox, { path: "seed.txt", content: "seed\n" });
      yield* Queue.offer(watcher, { _tag: "Fail" });
      yield* awaitTestEffect(
        Stream.fromQueue(calls).pipe(
          Stream.filter((command) => command.startsWith("git diff --name-only")),
          Stream.take(1),
          Stream.runDrain,
        ),
      );
      releaseDiff.resolve();
      yield* writeFile(sandbox, { path: "seed.txt", content: "first change\n" });

      const event = yield* awaitTestEffect(Queue.take(shipped));
      yield* Deferred.succeed(stop, undefined);
      yield* awaitTestEffect(Fiber.join(fiber));
      const value = yield* decodeDiffValue(event.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+first change");
    }).pipe(
      Effect.ensuring(Effect.sync(() => releaseDiff.resolve())),
      Effect.provide(Layer.mergeAll(queuedWatcherLayer(), ExecCalls.layer)),
    );
  };

  it.effect("drops a native diff that finishes after polling advances the checkout snapshot", () =>
    verifyLateNativeDiffDoesNotWin((exitCode) => Promise.resolve(exitCode)),
  );

  it.effect("keeps polling when an earlier native diff fails", () =>
    verifyLateNativeDiffDoesNotWin(() => Promise.reject(new Error("late native diff failed"))),
  );

  it.effect("keeps an older polling diff valid while its path stays dirty", () => {
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
        if (!isGitDiffCommand(command)) return original.handle.process.spawn(command, options);
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
      yield* awaitTestEffect(Deferred.await(secondPollCompleted));
      releaseDiff.resolve();

      const head = yield* awaitTestEffect(Fiber.join(fiber));
      if (Option.isNone(head)) return assert.fail("older polling diff was discarded");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+slow polling diff");
    }).pipe(Effect.ensuring(Effect.sync(() => releaseDiff.resolve())), Effect.provide(deniedWatcherLayer));
  });

  it.effect("keeps polling after a transient fallback diff failure", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "changed after diff failure\n" });
      const failNextDiff = MutableRef.make(true);
      const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) => {
        if (
          isGitDiffCommand(command) &&
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

      const head = yield* awaitTestEffect(
        watchWorktreeDiffs(sandbox, baseSha).pipe(Stream.take(1), Stream.runHead),
      );

      if (Option.isNone(head)) return assert.fail("fallback produced no diff event after retry");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.include(value.diff, "+changed after diff failure");
    }).pipe(Effect.provide(deniedWatcherLayer)),
  );

  it.effect("retries fallback batch setup after a transient failure", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "changed after setup failure\n" });
      yield* writeFile(original, { path: "second.txt", content: "new after setup failure\n" });
      const probeAttempts = MutableRef.make(0);
      const exec: WorktreeSandbox["handle"]["process"]["exec"] = (command, options) => {
        if (!isExternalDiffProbe(command)) return original.handle.process.exec(command, options);
        const attempt = MutableRef.updateAndGet(probeAttempts, (count) => count + 1);
        if (attempt > 1) return original.handle.process.exec(command, options);
        return Promise.reject(new Error("temporary external diff probe failure"));
      };
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: { ...original.handle.process, exec },
        },
      };

      const events = yield* awaitTestEffect(
        watchWorktreeDiffs(sandbox, baseSha).pipe(Stream.take(2), Stream.runCollect),
      );

      assert.strictEqual(MutableRef.get(probeAttempts), 2);
      assert.lengthOf(events, 2);
    }).pipe(Effect.provide(deniedWatcherLayer)),
  );

  it.effect("applies filtering, capping, and fingerprint dedupe to fallback events", () =>
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
      yield* awaitTestEffect(
        Stream.fromQueue(calls).pipe(
          Stream.filter((command) => command.startsWith("git diff --name-only")),
          Stream.take(2),
          Stream.runDrain,
        ),
      );
      yield* Deferred.succeed(stop, undefined);

      const events = [...(yield* Fiber.join(fiber))];
      assert.lengthOf(events, 1);
      const value = yield* decodeDiffValue(events[0]?.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.isAtMost(Buffer.byteLength(value.diff), fileDiffMaxBytes);
    }).pipe(Effect.provide(deniedWatcherWithExecCalls)),
  );

  it.effect("debounces overlapping scheduled and final fallback polls by path", () =>
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
      yield* awaitTestEffect(
        Stream.fromQueue(calls).pipe(
          Stream.filter((command) => command.startsWith("git diff --name-only")),
          Stream.take(1),
          Stream.runDrain,
        ),
      );
      yield* Deferred.succeed(stop, undefined);

      const events = [...(yield* Fiber.join(fiber))];
      const commands = [...(yield* takeAllCalls(calls))];
      assert.lengthOf(
        commands.filter((command) => command.startsWith("git diff --name-only")),
        1,
      );
      assert.lengthOf(
        commands.filter((command) => isGitDiffCommand(command) && command.endsWith("-- 'seed.txt'")),
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
