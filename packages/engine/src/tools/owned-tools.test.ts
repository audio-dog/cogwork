import { RunId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RunControl from "../run-control";
import {
  editFile,
  makeOwnedToolSet,
  readFile,
  runBash,
  runGlob,
  runGrep,
  webFetch,
  writeFile,
} from "./owned-tools";
import { fullProfile } from "./policy";
import type { WorktreeSandbox } from "./sandbox";

const runId = Schema.decodeSync(RunId)("run-tool-cancel");
const interruptionGate = Latch.makeUnsafe();
const gitFixtureEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "cogwork-test",
  GIT_AUTHOR_EMAIL: "cogwork-test@invalid",
  GIT_COMMITTER_NAME: "cogwork-test",
  GIT_COMMITTER_EMAIL: "cogwork-test@invalid",
};

const openSandbox = Effect.fn("owned-tools.test.openSandbox")(function* () {
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

const makeTools = Effect.fn("owned-tools.test.makeTools")(function* (
  sandbox: WorktreeSandbox,
  profile = fullProfile,
) {
  const runPromise = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>().pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  return makeOwnedToolSet(sandbox, runPromise, profile);
});

interface SpanProbeService {
  readonly record: (span: Tracer.NativeSpan) => void;
  readonly find: (name: string) => Tracer.NativeSpan | undefined;
}

class SpanProbe extends Context.Service<SpanProbe, SpanProbeService>()(
  "@cogwork/engine/tools/owned-tools.test/SpanProbe",
) {
  static readonly layer = Layer.sync(SpanProbe, () => {
    const spans: Array<Tracer.NativeSpan> = [];
    return {
      record: (span) => {
        spans.push(span);
      },
      find: (name) => spans.find((span) => span.name === name),
    };
  });

  static readonly testLayer = Layer.effect(
    Tracer.Tracer,
    Effect.map(SpanProbe, (probe) =>
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          probe.record(span);
          return span;
        },
      }),
    ),
  ).pipe(Layer.provideMerge(SpanProbe.layer));
}

const hasAncestor = (span: Tracer.NativeSpan, ancestor: Tracer.NativeSpan): boolean =>
  Option.match(span.parent, {
    onNone: () => false,
    onSome: (parent) =>
      parent.spanId === ancestor.spanId ||
      (parent instanceof Tracer.NativeSpan && hasAncestor(parent, ancestor)),
  });

describe("owned tools", () => {
  it.effect("writes and reads a file back through the sandbox", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const written = yield* writeFile(sandbox, { path: "src/hello.ts", content: "export const hi = 1;\n" });
      assert.strictEqual(written.path, "src/hello.ts");
      assert.isAbove(written.bytesWritten, 0);
      const read = yield* readFile(sandbox, { path: "src/hello.ts" });
      assert.strictEqual(read.content, "export const hi = 1;\n");
    }),
  );

  it.effect("reads a line slice with offset and limit", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "lines.txt", content: "a\nb\nc\nd\n" });
      const read = yield* readFile(sandbox, { path: "lines.txt", offset: 1, limit: 2 });
      assert.strictEqual(read.content, "b\nc");
    }),
  );

  it.effect("fails a read outside the worktree", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const error = yield* Effect.flip(readFile(sandbox, { path: "../escape.txt" }));
      assert.strictEqual(error.reason, "out-of-bounds");
    }),
  );

  it.effect("reports a missing file as not-found", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const error = yield* Effect.flip(readFile(sandbox, { path: "nope.txt" }));
      assert.strictEqual(error.reason, "not-found");
    }),
  );

  it.effect("classifies a missing file from its error code", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          fs: {
            ...original.handle.fs,
            read: () => Promise.reject({ code: "ENOENT", message: "opaque storage failure" }),
          },
        },
      };
      const error = yield* Effect.flip(readFile(sandbox, { path: "missing.txt" }));
      assert.strictEqual(error.reason, "not-found");
    }),
  );

  it.effect("edits an exact string in place", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "edit.txt", content: "one two three" });
      const edited = yield* editFile(sandbox, { path: "edit.txt", oldString: "two", newString: "TWO" });
      assert.strictEqual(edited.replacements, 1);
      const read = yield* readFile(sandbox, { path: "edit.txt" });
      assert.strictEqual(read.content, "one TWO three");
    }),
  );

  it.effect("refuses an edit whose target is missing", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "edit.txt", content: "alpha" });
      const error = yield* Effect.flip(
        editFile(sandbox, { path: "edit.txt", oldString: "beta", newString: "x" }),
      );
      assert.strictEqual(error.reason, "edit-no-match");
    }),
  );

  it.effect("refuses an ambiguous edit unless replaceAll is set", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "edit.txt", content: "x x x" });
      const error = yield* Effect.flip(
        editFile(sandbox, { path: "edit.txt", oldString: "x", newString: "y" }),
      );
      assert.strictEqual(error.reason, "edit-ambiguous");
      const edited = yield* editFile(sandbox, {
        path: "edit.txt",
        oldString: "x",
        newString: "y",
        replaceAll: true,
      });
      assert.strictEqual(edited.replacements, 3);
      const read = yield* readFile(sandbox, { path: "edit.txt" });
      assert.strictEqual(read.content, "y y y");
    }),
  );

  it.effect("runs a shell command and captures its exit code", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const ok = yield* runBash(sandbox, { command: "printf hi" });
      assert.strictEqual(ok.stdout, "hi");
      assert.strictEqual(ok.exitCode, 0);
      const failed = yield* runBash(sandbox, { command: "exit 3" });
      assert.strictEqual(failed.exitCode, 3);
    }),
  );

  it.effect("aborts a shell command when its deadline expires", () =>
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
      const fiber = yield* runBash(sandbox, { command: "wait" }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 minutes");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "timeout");
      assert.isTrue(Option.isSome(yield* Deferred.poll(aborted)));
    }),
  );

  it.effect("RunControl.cancel interrupts in-flight tool work", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const started = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      const controlled: WorktreeSandbox = {
        ...sandbox,
        handle: {
          ...sandbox.handle,
          process: {
            ...sandbox.handle.process,
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
      const control = yield* RunControl.RunControl;
      yield* Effect.forkScoped(
        control.run(
          runId,
          undefined,
          Effect.scoped(
            makeTools(controlled).pipe(
              Effect.flatMap((tools) => {
                const bash = tools.bash.execute;
                if (bash === undefined) return Effect.die("bash tool is missing a server executor");
                return Effect.promise(() => Promise.resolve(bash({ command: "wait" })));
              }),
            ),
          ),
        ),
      );
      yield* Deferred.await(started);

      const cancellation = yield* control.cancel(runId);
      assert.strictEqual(cancellation._tag, "Interrupting");
      if (cancellation._tag === "Interrupting") yield* cancellation.awaitTermination;
      yield* Effect.yieldNow;
      assert.isTrue(Option.isSome(yield* Deferred.poll(aborted)));
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
  );

  it.effect("tool handler spans stay under the run span", () =>
    Effect.gen(function* () {
      const probe = yield* SpanProbe;
      const sandbox = yield* openSandbox();
      const tools = yield* makeTools(sandbox);
      const read = tools.read.execute;
      assert.isDefined(read);
      yield* Effect.promise(() => Promise.resolve(read({ path: "seed.txt" })));

      const runSpan = probe.find("run");
      const toolSpan = probe.find("Tools.read");
      assert.isDefined(runSpan);
      assert.isDefined(toolSpan);
      assert.isTrue(hasAncestor(toolSpan, runSpan));
    }).pipe(Effect.withSpan("run"), Effect.provide(SpanProbe.testLayer), Effect.scoped),
  );

  it.effect("globs files across the worktree", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "a.ts", content: "" });
      yield* writeFile(sandbox, { path: "sub/c.ts", content: "" });
      yield* writeFile(sandbox, { path: "readme.md", content: "" });
      const globbed = yield* runGlob(sandbox, { pattern: "**/*.ts" });
      assert.deepStrictEqual([...globbed.matches].sort(), ["a.ts", "sub/c.ts"]);
    }),
  );

  it.effect("greps file contents with line numbers", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "code.ts", content: "const a = 1;\nconst target = 2;\n" });
      const grepped = yield* runGrep(sandbox, { pattern: "target", include: "**/*.ts" });
      assert.strictEqual(grepped.matches.length, 1);
      assert.strictEqual(grepped.matches[0]?.path, "code.ts");
      assert.strictEqual(grepped.matches[0]?.line, 2);
    }),
  );

  it.effect("surfaces a webfetch failure as a typed error", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const error = yield* webFetch(sandbox, { url: "http://not-a-real-host.invalid" }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.flip,
      );
      assert.strictEqual(error.reason, "fetch-failed");
    }),
  );

  it.effect("aborts webfetch when its deadline expires", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const started = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      const client = HttpClient.make((_request, _url, signal) =>
        Effect.suspend(() => {
          Deferred.doneUnsafe(started, Effect.void);
          signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void), { once: true });
          return interruptionGate.await.pipe(Effect.flatMap(() => Effect.die("interruption gate opened")));
        }),
      );
      const fiber = yield* webFetch(sandbox, { url: "https://example.com" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "timeout");
      assert.isTrue(Option.isSome(yield* Deferred.poll(aborted)));
    }),
  );

  it.effect("exposes the seven tools as server tool definitions", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const tools = yield* makeTools(sandbox);
      assert.deepStrictEqual(Object.keys(tools).sort(), [
        "bash",
        "edit",
        "glob",
        "grep",
        "read",
        "webfetch",
        "write",
      ]);
      const execute = tools.write.execute;
      if (execute === undefined) throw new Error("write tool is missing a server executor");
      const result = yield* Effect.promise(() =>
        Promise.resolve(execute({ path: "via-tool.txt", content: "ok" })),
      );
      assert.deepStrictEqual(result, { path: "via-tool.txt", bytesWritten: 2 });
    }),
  );
});
