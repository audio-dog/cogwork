import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { toolError } from "./errors";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

const openSandbox = Effect.fn("sandbox.test.openSandbox")(function* (root?: string) {
  const handle = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) => localProcessSandbox({ dir: root }).create({ signal }),
      catch: (cause) => toolError("exec-failed", String(cause)),
    }),
    (open) =>
      Effect.tryPromise({
        try: () => open.destroy(),
        catch: (cause) => toolError("exec-failed", String(cause)),
      }).pipe(Effect.interruptible, Effect.timeout("5 seconds"), Effect.ignore),
    { interruptible: true },
  );
  return { handle, root: root ?? handle.id } satisfies WorktreeSandbox;
});

describe("worktree sandbox", { timeout: 30_000 }, () => {
  layer(NodeServices.layer)((nodeIt) => {
    nodeIt.effect("returns no base SHA for a repository without commits", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-unborn-head-" });
        const sandbox = yield* openSandbox(root);
        const initialized = yield* Effect.tryPromise({
          try: (signal) => sandbox.handle.process.exec("git init", { signal }),
          catch: (cause) => toolError("exec-failed", String(cause), root),
        });
        assert.strictEqual(initialized.exitCode, 0);
        assert.strictEqual(yield* resolveBaseSha(sandbox), "");
      }),
    );
  });

  it.effect("aborts base SHA resolution when its deadline expires", () =>
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
      const fiber = yield* resolveBaseSha(sandbox).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 minutes");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "timeout");
      assert.isTrue(Option.isSome(yield* Deferred.poll(aborted)));
    }),
  );

  it.effect("surfaces a nonzero base SHA command as a typed error", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: {
            ...original.handle.process,
            exec: () => Promise.resolve({ stdout: "", stderr: "git unavailable", exitCode: 127 }),
          },
        },
      };
      const error = yield* resolveBaseSha(sandbox).pipe(Effect.flip);
      assert.strictEqual(error.reason, "exec-failed");
      assert.include(error.message, "exited 127");
    }),
  );
});
