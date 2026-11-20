import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { FILE_DIFF_EVENT, toFileDiffEvent, watchWorktreeDiffs } from "./file-diff-feed";
import {
  decodeDiffValue,
  ExecCalls,
  fileDiffMaxBytes,
  gitDiffCommand,
  gitFixtureEnvironment,
  isGitDiffCommand,
  openSandbox,
  takeAllCalls,
  testProcessSignal,
  withExecProbe,
  yieldToHost,
} from "./file-diff-fixtures";
import { boundedDiff, computeDiff, fileDiffExecDuration, fileDiffGitChildren } from "./file-diff-git";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

describe("file diff content", { timeout: 30_000 }, () => {
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
      const events = [
        { _tag: "Update", path: "seed.txt" },
        { _tag: "Create", path: addedPath },
        { _tag: "Remove", path: "removed.txt" },
        { _tag: "Update", path: "unchanged.txt" },
        { _tag: "Update", path: "capped.txt" },
        { _tag: "Update", path: "seed.txt" },
        { _tag: "Create", path: "node_modules/ignored.txt" },
      ] satisfies ReadonlyArray<FileSystem.WatchEvent>;
      const before = yield* Metric.value(fileDiffExecDuration);
      const beforeChildren = yield* Metric.value(fileDiffGitChildren);
      const shipped = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromIterable(events) })),
      );
      const after = yield* Metric.value(fileDiffExecDuration);
      const afterChildren = yield* Metric.value(fileDiffGitChildren);

      const actual = yield* Effect.forEach(shipped, (event) =>
        decodeDiffValue(event.value).pipe(
          Effect.map((value) => [value.path, value.diff] satisfies [string, string]),
        ),
      );
      assert.lengthOf(actual, expected.length);
      assert.deepEqual(Object.fromEntries(actual), Object.fromEntries(expected));
      const gitCommands = (yield* takeAllCalls(calls)).filter((command) => command.startsWith("git "));
      const beforeGitProcessCount = 10;
      assert.isAtMost(gitCommands.length, beforeGitProcessCount * 0.8);
      assert.lengthOf(gitCommands, 5);
      assert.strictEqual(afterChildren.count - beforeChildren.count, gitCommands.length);
      const diffCommands = gitCommands.filter(isGitDiffCommand);
      assert.lengthOf(diffCommands, 2);
      assert.isTrue(diffCommands.some((command) => command.includes("--raw -z --patch")));
      assert.strictEqual(after.count - before.count, 2);
    }).pipe(Effect.provide(ExecCalls.layer)),
  );

  it.effect("matches Git output to watcher paths with dot segments", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "other.txt", content: "other\n" });
      const commit = yield* Effect.promise((signal) =>
        original.handle.process.exec("git add -A && git commit -q -m dot-segment-fixture", {
          env: gitFixtureEnvironment,
          signal: testProcessSignal(signal),
        }),
      );
      assert.strictEqual(commit.exitCode, 0, commit.stderr);
      const baseSha = yield* resolveBaseSha(original);
      yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
      yield* writeFile(original, { path: "other.txt", content: "other changed\n" });
      const expected = yield* Effect.promise((signal) =>
        original.handle.process.exec(`${gitDiffCommand} '${baseSha}' -- 'seed.txt'`, {
          signal: testProcessSignal(signal),
        }),
      );
      assert.strictEqual(expected.exitCode, 0, expected.stderr);
      const calls = yield* ExecCalls;
      const sandbox = yield* withExecProbe(original);
      const events = [
        { _tag: "Update", path: "./seed.txt" },
        { _tag: "Update", path: "other.txt" },
      ] satisfies ReadonlyArray<FileSystem.WatchEvent>;
      const shipped = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.runCollect,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromIterable(events) })),
      );
      const actual = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
      const seed = actual.find(({ path }) => path === "seed.txt");
      assert.strictEqual(seed?.diff, boundedDiff(expected.stdout));
      const diffCommands = (yield* takeAllCalls(calls)).filter(isGitDiffCommand);
      assert.lengthOf(diffCommands, 1);
      assert.include(diffCommands[0], "--raw -z --patch");
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
      yield* yieldToHost();
      yield* Queue.offerAll(events, [
        { _tag: "Update", path: "seed.txt" },
        { _tag: "Update", path: "other.txt" },
      ]);
      yield* yieldToHost();
      yield* TestClock.adjust("100 millis");
      yield* yieldToHost();
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
      const diffCommands = (yield* takeAllCalls(calls)).filter(isGitDiffCommand);
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
      yield* yieldToHost();
      yield* Queue.offerAll(events, [
        { _tag: "Update", path: "tracked" },
        { _tag: "Update", path: "seed.txt" },
      ]);
      yield* yieldToHost();
      yield* TestClock.adjust("100 millis");
      yield* yieldToHost();
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(stop, undefined);
      const shipped = yield* Fiber.join(fiber);
      const actual = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
      assert.strictEqual(actual.find(({ path }) => path === "tracked")?.diff, boundedDiff(expected.stdout));
      assert.isTrue(actual.some(({ path }) => path === "seed.txt"));
    }),
  );
});
