import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { FILE_DIFF_EVENT, fileDiffEvent, watchWorktreeDiffs } from "./file-diff-feed";
import {
  decodeDiffValue,
  diffTruncationMarker,
  ExecCalls,
  fileDiffMaxBytes,
  openSandbox,
  settleDiff,
  withExecProbe,
  yieldToHost,
} from "./file-diff-fixtures";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

describe("file diff delivery", { timeout: 30_000 }, () => {
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
      yield* yieldToHost();

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
      yield* yieldToHost();

      yield* writeFile(sandbox, { path: "seed.txt", content: "first\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);
      const first = yield* Queue.take(shipped);

      yield* writeFile(sandbox, { path: "seed.txt", content: "seed\n" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* settleDiff(calls);
      yield* yieldToHost();
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
      yield* yieldToHost();

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
});
