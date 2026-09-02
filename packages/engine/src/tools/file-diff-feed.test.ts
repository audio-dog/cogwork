import { assert, describe, it } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
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
  toFileDiffEvent,
  watchWorktreeDiffs,
} from "./file-diff-feed";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

const DiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
const decodeDiffValue = Schema.decodeUnknownEffect(DiffValue);
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";

const openSandbox = Effect.fn("file-diff-feed.test.openSandbox")(function* () {
  const handle = yield* Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (h) => Effect.promise(() => h.destroy()),
  );
  const sandbox: WorktreeSandbox = { handle, root: handle.id };
  const init = yield* Effect.promise(() =>
    handle.process.exec(
      "git init -q && git config user.email t@example.com && git config user.name test && printf 'seed\\n' > seed.txt && git add -A && git commit -q -m init",
    ),
  );
  assert.strictEqual(init.exitCode, 0, init.stderr);
  return sandbox;
});

const withExecProbe = (sandbox: WorktreeSandbox, calls: Queue.Queue<string>) => {
  const exec: WorktreeSandbox["handle"]["process"]["exec"] = (command, options) => {
    Queue.offerUnsafe(calls, command);
    return sandbox.handle.process.exec(command, options);
  };
  return {
    ...sandbox,
    handle: {
      ...sandbox.handle,
      process: {
        ...sandbox.handle.process,
        exec,
      },
    },
  };
};

describe("file diff feed", () => {
  it.effect("renders a new file as an add-patch diff event", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(sandbox);
      yield* writeFile(sandbox, { path: "added.ts", content: "export const x = 1;\n" });
      const event = yield* toFileDiffEvent(sandbox, baseSha, {
        type: "create",
        path: "/workspace/added.ts",
        timestamp: 0,
      });
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

  it.effect("collapses a per-file event burst into one diff subprocess", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* Queue.unbounded<string>();
      const sandbox = withExecProbe(original, calls);
      yield* writeFile(sandbox, { path: "seed.txt", content: "settled\n" });
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offerAll(
        events,
        Array.from({ length: 25 }, () => ({ _tag: "Update", path: "seed.txt" }) as const),
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      const head = yield* Fiber.join(fiber);
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      assert.strictEqual(yield* Queue.size(calls), 1);
    }),
  );

  it.effect("honors gitignored build output before starting diff subprocesses", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: ".gitignore", content: "dist/\n" });
      yield* writeFile(original, { path: "seed.txt", content: "settled\n" });
      const baseSha = yield* resolveBaseSha(original);
      const calls = yield* Queue.unbounded<string>();
      const sandbox = withExecProbe(original, calls);
      const events = yield* Queue.make<FileSystem.WatchEvent>();
      const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromQueue(events) })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* Queue.offer(events, { _tag: "Create", path: "dist/bundle.js" });
      yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
      yield* TestClock.adjust("1 second");
      const head = yield* Fiber.join(fiber);
      if (Option.isNone(head)) return assert.fail("watcher produced no diff event");
      const value = yield* decodeDiffValue(head.value.value);
      assert.strictEqual(value.path, "seed.txt");
      assert.strictEqual(yield* Queue.size(calls), 1);
    }),
  );

  it.live(
    "does not ship the same full diff twice",
    () =>
      Effect.gen(function* () {
        const original = yield* openSandbox();
        const baseSha = yield* resolveBaseSha(original);
        const calls = yield* Queue.unbounded<string>();
        const sandbox = withExecProbe(original, calls);
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
        yield* Effect.sleep("400 millis");
        yield* Queue.take(calls);

        yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
        yield* Effect.sleep("400 millis");
        yield* Queue.take(calls);

        yield* writeFile(sandbox, { path: "seed.txt", content: "second\n" });
        yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
        yield* Effect.sleep("400 millis");
        yield* Queue.take(calls);

        const shipped = yield* Fiber.join(fiber);
        assert.lengthOf(shipped, 2);
        const values = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
        assert.include(values[0].diff, "+first");
        assert.include(values[1].diff, "+second");
      }),
    20000,
  );

  it.live(
    "ships a second large diff when the raw diff changes past the cap",
    () =>
      Effect.gen(function* () {
        const original = yield* openSandbox();
        const baseSha = yield* resolveBaseSha(original);
        const calls = yield* Queue.unbounded<string>();
        const sandbox = withExecProbe(original, calls);
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
        yield* Effect.sleep("400 millis");
        yield* Queue.take(calls);

        yield* writeFile(sandbox, { path: "seed.txt", content: `${sharedPrefix}second\n` });
        yield* Queue.offer(events, { _tag: "Update", path: "seed.txt" });
        yield* Effect.sleep("400 millis");
        yield* Queue.take(calls);

        const shipped = yield* Fiber.join(fiber);
        assert.lengthOf(shipped, 2);
        const values = yield* Effect.forEach(shipped, (event) => decodeDiffValue(event.value));
        assert.isTrue(values.every((value) => value.diff.endsWith(diffTruncationMarker)));
      }),
    20000,
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

  // The watcher misreports create/remove (it stats paths relative to the
  // process cwd), so the feed classifies through the sandbox handle instead;
  // a tracked file gone from disk must still surface as a deletion diff.
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

  // A rejected exists() is a transient stat failure, not the feed's end: the
  // event classifies as a deletion and the stream keeps flowing.
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

  // The crash-proof property this feed exists for: a watcher failure — e.g.
  // FSEvents denied under a Codex seatbelt sandbox, surfaced as an async
  // EMFILE — must arrive on the typed error channel, never as an uncaught
  // exception.
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
