import { assert, describe, it } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  boundedDiff,
  computeDiff,
  FILE_DIFF_EVENT,
  fileDiffEvent,
  fileDiffExecDuration,
  toFileDiffEvent,
  watchWorktreeDiffs,
} from "./file-diff-feed";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

const DiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
const decodeDiffValue = Schema.decodeUnknownEffect(DiffValue);
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
const testProcessSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
const gitCommand = "git --literal-pathspecs";
const gitDiffCommand = `${gitCommand} diff`;
const isGitDiffCommand = (command: string) => command.startsWith(gitDiffCommand);
const isGitIgnoreCommand = (command: string) => command.startsWith("git check-ignore");
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

const coalesceOutput = (output: AsyncIterable<string>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = Array.fromAsync(output).then((chunks) => ["", chunks.join("")][Symbol.iterator]());
    return { next: () => iterator.then((chunks) => chunks.next()) };
  },
});

class ExecCalls extends Context.Service<ExecCalls, Queue.Queue<string>>()(
  "@cogwork/engine/tools/file-diff-feed.test/ExecCalls",
) {
  static readonly layer = Layer.effect(ExecCalls, Queue.unbounded<string>());
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
      stdout: command.includes("--raw -z --patch") ? coalesceOutput(process.stdout) : process.stdout,
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
    Stream.filter(isGitIgnoreCommand),
    Stream.runHead,
  );
  if (Option.isNone(ignoreCommand)) return assert.fail("ignore check did not complete");
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* TestClock.adjust("1 second");
  const diffCommand = yield* Stream.fromQueue(calls).pipe(Stream.filter(isGitDiffCommand), Stream.runHead);
  if (Option.isNone(diffCommand)) return assert.fail("diff did not complete");
  return [ignoreCommand.value, diffCommand.value] as const;
});

const startBlockedBatch = Effect.fn("file-diff-feed.test.startBlockedBatch")(function* (
  exitOn: "SIGTERM" | "SIGKILL",
) {
  const original = yield* openSandbox();
  yield* writeFile(original, { path: "other.txt", content: "other\n" });
  const commit = yield* Effect.promise((signal) =>
    original.handle.process.exec("git add -A && git commit -q -m blocked-batch-fixture", {
      env: gitFixtureEnvironment,
      signal: testProcessSignal(signal),
    }),
  );
  assert.strictEqual(commit.exitCode, 0, commit.stderr);
  const baseSha = yield* resolveBaseSha(original);
  yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
  yield* writeFile(original, { path: "other.txt", content: "other changed\n" });
  const started = yield* Deferred.make<void>();
  const terminated = yield* Deferred.make<void>();
  const killed = yield* Deferred.make<void>();
  const exit = Promise.withResolvers<number>();
  const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) => {
    if (!command.includes("--raw -z --patch")) return original.handle.process.spawn(command, options);
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
        if (signal === "SIGKILL") Deferred.doneUnsafe(killed, Effect.void);
        if (signal === exitOn) exit.resolve(signal === "SIGKILL" ? 137 : 143);
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
  const stop = yield* Deferred.make<void>();
  const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
    Stream.runDrain,
    Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
    Effect.forkChild,
  );
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* Queue.offerAll(events, [
    { _tag: "Update", path: "seed.txt" },
    { _tag: "Update", path: "other.txt" },
  ]);
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* TestClock.adjust("100 millis");
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* TestClock.adjust("1 second");
  yield* Deferred.succeed(stop, undefined);
  yield* Deferred.await(started);
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  return { fiber, terminated, killed };
});

describe("file diff feed", { timeout: 30_000 }, () => {
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
      assert.include(error.message, " diff ");
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

  it.effect("escalates a timed-out batched diff subprocess to SIGKILL", () =>
    Effect.gen(function* () {
      const { fiber, terminated, killed } = yield* startBlockedBatch("SIGKILL");
      yield* advanceUntil(terminated, "5 minutes");
      yield* advanceUntil(killed, "5 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.strictEqual(error.reason, "timeout");
    }),
  );

  it.effect("terminates an interrupted batched diff subprocess", () =>
    Effect.gen(function* () {
      const { fiber, terminated } = yield* startBlockedBatch("SIGTERM");
      yield* Fiber.interrupt(fiber);
      assert.isTrue(Option.isSome(yield* Deferred.poll(terminated)));
    }),
  );

  it.effect("batches distinct paths across empty and coalesced output chunks", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const addedPath = ":(exclude)added file*";
      const config = yield* Effect.promise((signal) =>
        original.handle.process.exec("git config color.ui always", { signal: testProcessSignal(signal) }),
      );
      assert.strictEqual(config.exitCode, 0, config.stderr);
      yield* writeFile(original, { path: "removed.txt", content: "removed\n" });
      yield* writeFile(original, { path: "unchanged.txt", content: "unchanged\n" });
      yield* writeFile(original, { path: "capped.txt", content: "small\n" });
      const commit = yield* Effect.promise((signal) =>
        original.handle.process.exec("git add -A && git commit -q -m batch-fixture", {
          env: gitFixtureEnvironment,
          signal: testProcessSignal(signal),
        }),
      );
      assert.strictEqual(commit.exitCode, 0, commit.stderr);
      const baseSha = yield* resolveBaseSha(original);

      yield* writeFile(original, { path: "seed.txt", content: "seed changed🙂123456789\n" });
      yield* writeFile(original, { path: addedPath, content: "added\n" });
      yield* writeFile(original, { path: "capped.txt", content: `${"a".repeat(fileDiffMaxBytes * 2)}\n` });
      yield* Effect.promise(() => original.handle.fs.remove("removed.txt"));

      const expected = yield* Effect.forEach(
        [
          { path: "seed.txt", command: `${gitDiffCommand} '${baseSha}' -- 'seed.txt'`, exitCodes: [0] },
          {
            path: addedPath,
            command: `${gitDiffCommand} --no-index -- /dev/null '${addedPath}'`,
            exitCodes: [0, 1],
          },
          {
            path: "removed.txt",
            command: `${gitDiffCommand} '${baseSha}' -- 'removed.txt'`,
            exitCodes: [0],
          },
          { path: "capped.txt", command: `${gitDiffCommand} '${baseSha}' -- 'capped.txt'`, exitCodes: [0] },
        ],
        ({ path, command, exitCodes }) =>
          Effect.promise((signal) =>
            original.handle.process.exec(command, { signal: testProcessSignal(signal) }),
          ).pipe(
            Effect.map((result) => {
              assert.include(exitCodes, result.exitCode, result.stderr);
              return [path, boundedDiff(result.stdout)] satisfies [string, string];
            }),
          ),
      );

      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const before = yield* Metric.value(fileDiffExecDuration);
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offerAll(events, [
        { _tag: "Update", path: "seed.txt" },
        { _tag: "Create", path: addedPath },
        { _tag: "Remove", path: "removed.txt" },
        { _tag: "Update", path: "unchanged.txt" },
        { _tag: "Update", path: "capped.txt" },
        { _tag: "Update", path: "seed.txt" },
        { _tag: "Create", path: "node_modules/ignored.txt" },
      ]);
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(stop, undefined);
      const shipped = yield* Fiber.join(fiber);
      const after = yield* Metric.value(fileDiffExecDuration);

      const actual = yield* Effect.forEach(shipped, (event) =>
        decodeDiffValue(event.value).pipe(
          Effect.map((value) => [value.path, value.diff] satisfies [string, string]),
        ),
      );
      assert.lengthOf(actual, expected.length);
      assert.deepEqual(Object.fromEntries(actual), Object.fromEntries(expected));
      const gitCommands = (yield* Queue.takeAll(calls)).filter((command) => command.startsWith("git "));
      const beforeGitProcessCount = 10;
      assert.isAtMost(gitCommands.length, beforeGitProcessCount * 0.8);
      assert.lengthOf(gitCommands, 5);
      const diffCommands = gitCommands.filter(isGitDiffCommand);
      assert.lengthOf(diffCommands, 2);
      assert.isTrue(diffCommands.some((command) => command.includes("--raw -z --patch")));
      assert.strictEqual(after.count - before.count, 2);
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("preserves external diff output by falling back to per-path commands", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "other.txt", content: "other\n" });
      yield* writeFile(original, {
        path: "external-diff.sh",
        content:
          '#!/bin/sh\nprintf \'diff --git a/%s b/%s\\npaths=%s/%s\\n\' "$1" "$1" "$GIT_DIFF_PATH_COUNTER" "$GIT_DIFF_PATH_TOTAL"\n',
      });
      const setup = yield* Effect.promise((signal) =>
        original.handle.process.exec(
          "chmod +x external-diff.sh && git add -A && git commit -q -m external-diff-fixture && git config diff.external ./external-diff.sh",
          { env: gitFixtureEnvironment, signal: testProcessSignal(signal) },
        ),
      );
      assert.strictEqual(setup.exitCode, 0, setup.stderr);
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
      yield* writeFile(original, { path: "other.txt", content: "other changed\n" });
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha, Deferred.await(stop)).pipe(
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offerAll(events, [
        { _tag: "Update", path: "seed.txt" },
        { _tag: "Update", path: "other.txt" },
      ]);
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(stop, undefined);
      const shipped = yield* Fiber.join(fiber);
      const actual = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
      assert.deepEqual(
        actual.map(({ path, diff }) => [path, diff]),
        [
          ["seed.txt", "diff --git a/seed.txt b/seed.txt\npaths=1/1\n"],
          ["other.txt", "diff --git a/other.txt b/other.txt\npaths=1/1\n"],
        ],
      );
      const diffCommands = (yield* Queue.takeAll(calls)).filter(isGitDiffCommand);
      assert.lengthOf(diffCommands, 2);
      assert.isFalse(diffCommands.some((command) => command.includes("--raw -z --patch")));
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("preserves a directory-to-file diff when it shares a batch", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "tracked/first.txt", content: "first\n" });
      yield* writeFile(original, { path: "tracked/second.txt", content: "second\n" });
      const commit = yield* Effect.promise((signal) =>
        original.handle.process.exec("git add -A && git commit -q -m directory-fixture", {
          env: gitFixtureEnvironment,
          signal: testProcessSignal(signal),
        }),
      );
      assert.strictEqual(commit.exitCode, 0, commit.stderr);
      const baseSha = yield* resolveBaseSha(original);
      yield* Effect.promise(() => original.handle.fs.remove("tracked"));
      yield* writeFile(original, { path: "tracked", content: "replacement\n" });
      yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
      const expected = yield* Effect.promise((signal) =>
        original.handle.process.exec(`${gitDiffCommand} '${baseSha}' -- 'tracked'`, {
          signal: testProcessSignal(signal),
        }),
      );
      assert.strictEqual(expected.exitCode, 0, expected.stderr);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const stop = yield* Deferred.make<void>();
      const fiber = yield* watchWorktreeDiffs(original, baseSha, Deferred.await(stop)).pipe(
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offerAll(events, [
        { _tag: "Update", path: "tracked" },
        { _tag: "Update", path: "seed.txt" },
      ]);
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(stop, undefined);
      const shipped = yield* Fiber.join(fiber);
      const actual = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
      assert.strictEqual(actual.find(({ path }) => path === "tracked")?.diff, boundedDiff(expected.stdout));
      assert.isTrue(actual.some(({ path }) => path === "seed.txt"));
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
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
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
        Stream.filter(isGitIgnoreCommand),
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
      yield* Stream.fromQueue(calls).pipe(Stream.filter(isGitIgnoreCommand), Stream.runHead);
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      const directoryCommand = yield* Stream.fromQueue(calls).pipe(
        Stream.filter((command) => command.includes("'tracked'")),
        Stream.runHead,
      );
      if (Option.isNone(directoryCommand)) return assert.fail("directory classification did not complete");
      assert.isFalse(isGitDiffCommand(directoryCommand.value));
      assert.isTrue(Option.isNone(yield* Queue.poll(shipped)));
      yield* Fiber.interrupt(fiber);
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

  it.live("streams a diff event when a tool writes through the sandbox, skipping ignored paths", () =>
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
  );

  it.live("diffs a tracked file the watcher reports after it was removed", () =>
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
  );

  it.live("keeps streaming when the existence check rejects", () =>
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
  );

  it.effect("surfaces a watcher failure as a typed tool error", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      const failure = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "watch",
        cause: new Error("EMFILE: too many open files, watch"),
      });
      const result = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.runDrain,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fail(failure) })),
        Effect.flip,
      );
      assert.strictEqual(result.reason, "exec-failed");
      assert.include(result.message, "file watcher failed");
    }),
  );
});
