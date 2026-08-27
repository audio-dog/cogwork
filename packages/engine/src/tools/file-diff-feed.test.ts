import { assert, describe, it } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FILE_DIFF_EVENT, toFileDiffEvent, watchWorktreeDiffs } from "./file-diff-feed";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

const DiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
const decodeDiffValue = Schema.decodeUnknownEffect(DiffValue);

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
