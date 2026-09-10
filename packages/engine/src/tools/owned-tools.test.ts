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

const processOutput = (chunks: ReadonlyArray<string>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = chunks[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  },
});

const withProcessSpawn = (
  sandbox: WorktreeSandbox,
  spawn: WorktreeSandbox["handle"]["process"]["spawn"],
) => ({
  ...sandbox,
  handle: { ...sandbox.handle, process: { ...sandbox.handle.process, spawn } },
});

const searchOutputSandbox = (
  original: WorktreeSandbox,
  stdout: string,
  kill: (signal: NodeJS.Signals | number | undefined) => Promise<void> = () => Promise.resolve(),
) => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = () =>
    Promise.resolve({
      pid: 1,
      stdout: processOutput([stdout]),
      stderr: processOutput([]),
      stdin: {
        write: () => Promise.resolve(),
        end: () => Promise.resolve(),
      },
      wait: () => Promise.resolve(0),
      kill: (signal) => {
        signals.push(signal);
        return kill(signal);
      },
    });
  return {
    signals,
    sandbox: withProcessSpawn(original, spawn),
  };
};

const stalledSearchSandbox = Effect.fn("owned-tools.test.stalledSearchSandbox")(function* (
  original: WorktreeSandbox,
) {
  const started = yield* Deferred.make<void>();
  const killed = yield* Deferred.make<void>();
  const exit = Promise.withResolvers<number>();
  const blocked: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.withResolvers<IteratorResult<string>>().promise }),
  };
  const stop = () => {
    Deferred.doneUnsafe(killed, Effect.void);
    exit.resolve(143);
  };
  const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (_command, options) => {
    Deferred.doneUnsafe(started, Effect.void);
    options?.signal?.addEventListener("abort", stop, { once: true });
    return Promise.resolve({
      pid: 1,
      stdout: blocked,
      stderr: blocked,
      stdin: {
        write: () => Promise.resolve(),
        end: () => Promise.resolve(),
      },
      wait: () => exit.promise,
      kill: () => {
        stop();
        return Promise.resolve();
      },
    });
  };
  return {
    started,
    killed,
    sandbox: withProcessSpawn(original, spawn),
  };
});

const ripgrepMatchRecord = (path: string) => `${path}\u00001:target`;

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

  it.effect("treats no glob matches as success", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* Effect.promise(() => sandbox.handle.fs.mkdir("empty"));

      const globbed = yield* runGlob(sandbox, { pattern: "**/*", path: "empty" });

      assert.deepStrictEqual(globbed.matches, []);
    }),
  );

  it.effect("searches without traversing files through the sandbox filesystem", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* writeFile(original, { path: "src/match.ts", content: "const target = true;\n" });
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          fs: {
            ...original.handle.fs,
            list: () => Promise.reject(new Error("unexpected filesystem traversal")),
            read: () => Promise.reject(new Error("unexpected file read")),
          },
        },
      };

      const globbed = yield* runGlob(sandbox, { pattern: "**/*.ts" });
      const grepped = yield* runGrep(sandbox, { pattern: "target", include: "**/*.ts" });

      assert.deepStrictEqual(globbed.matches, ["src/match.ts"]);
      assert.deepStrictEqual(grepped.matches, [
        { path: "src/match.ts", line: 1, text: "const target = true;" },
      ]);
    }),
  );

  it.effect("honors search paths, includes, ignores, hidden files, and binary detection", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: ".gitignore", content: "*.ignored.ts\n" });
      yield* writeFile(sandbox, { path: "src/.hidden.ts", content: "target hidden\n" });
      yield* writeFile(sandbox, { path: "src/keep.ts", content: "target keep\n" });
      yield* writeFile(sandbox, { path: "src/skip.js", content: "target skip\n" });
      yield* writeFile(sandbox, { path: "src/nope.ignored.ts", content: "target ignored\n" });
      yield* writeFile(sandbox, { path: "src/binary.ts", content: "\0target binary\n" });
      yield* writeFile(sandbox, { path: "src/node_modules/dependency.ts", content: "target dependency\n" });
      yield* writeFile(sandbox, { path: "outside.ts", content: "target outside\n" });

      const globbed = yield* runGlob(sandbox, { pattern: "**/*.ts", path: "src" });
      const grepped = yield* runGrep(sandbox, {
        pattern: "target",
        path: "src",
        include: "**/*.ts",
      });

      assert.deepStrictEqual([...globbed.matches].sort(), ["src/.hidden.ts", "src/binary.ts", "src/keep.ts"]);
      assert.deepStrictEqual(grepped.matches.map(({ path }) => path).sort(), [
        "src/.hidden.ts",
        "src/keep.ts",
      ]);
    }),
  );

  it.effect("searches a file base", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "src/match.ts", content: "target\n" });

      const globbed = yield* runGlob(sandbox, { pattern: "*.ts", path: "src/match.ts" });
      const grepped = yield* runGrep(sandbox, {
        pattern: "target",
        path: "src/match.ts",
        include: "*.ts",
      });

      assert.deepStrictEqual(globbed.matches, ["src/match.ts"]);
      assert.deepStrictEqual(grepped.matches, [{ path: "src/match.ts", line: 1, text: "target" }]);
    }),
  );

  it.effect("applies each ignore source to search base paths", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: ".gitignore", content: "gitignored/\nreincluded/\n" });
      yield* writeFile(sandbox, { path: ".ignore", content: "ripgrep-ignored/\n" });
      yield* writeFile(sandbox, { path: ".rgignore", content: "!reincluded/\n" });
      yield* writeFile(sandbox, { path: "gitignored/match.ts", content: "target\n" });
      yield* writeFile(sandbox, { path: "ripgrep-ignored/match.ts", content: "target\n" });
      yield* writeFile(sandbox, { path: "reincluded/match.ts", content: "target\n" });

      const gitGlob = yield* runGlob(sandbox, { pattern: "**/*.ts", path: "gitignored" });
      const ripgrepGlob = yield* runGlob(sandbox, {
        pattern: "**/*.ts",
        path: "ripgrep-ignored",
      });
      const gitGrep = yield* runGrep(sandbox, { pattern: "target", path: "gitignored" });
      const ripgrepGrep = yield* runGrep(sandbox, {
        pattern: "target",
        path: "ripgrep-ignored",
      });
      const reincluded = yield* runGrep(sandbox, { pattern: "target", path: "reincluded" });

      assert.deepStrictEqual(gitGlob.matches, []);
      assert.deepStrictEqual(ripgrepGlob.matches, []);
      assert.deepStrictEqual(gitGrep.matches, []);
      assert.deepStrictEqual(ripgrepGrep.matches, []);
      assert.deepStrictEqual(reincluded.matches, [{ path: "reincluded/match.ts", line: 1, text: "target" }]);
    }),
  );

  it.effect("reports a missing search base as not-found", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const globError = yield* Effect.flip(runGlob(sandbox, { pattern: "**/*", path: "missing" }));
      const grepError = yield* Effect.flip(runGrep(sandbox, { pattern: "target", path: "missing" }));

      assert.strictEqual(globError.reason, "not-found");
      assert.strictEqual(grepError.reason, "not-found");
    }),
  );

  it.effect("rejects a search base containing a symbolic link", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          fs: {
            ...original.handle.fs,
            exists: () => Promise.resolve(true),
            lstat: (path) =>
              Promise.resolve(path === "safe" ? { type: "dir", mode: 0 } : { type: "symlink", mode: 0 }),
          },
          process: {
            ...original.handle.process,
            spawn: () => Promise.reject(new Error("search process must not start")),
          },
        },
      };

      const error = yield* Effect.flip(runGrep(sandbox, { pattern: "target", path: "safe/link" }));

      assert.strictEqual(error.reason, "out-of-bounds");
      assert.strictEqual(error.path, "safe/link");
    }),
  );

  it.effect("rejects an explicit search base without symbolic-link inspection", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      yield* Effect.promise(() => original.handle.fs.mkdir("safe"));
      const sandbox: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          fs: {
            ...original.handle.fs,
            lstat: undefined,
          },
          process: {
            ...original.handle.process,
            spawn: () => Promise.reject(new Error("search process must not start")),
          },
        },
      };

      const error = yield* Effect.flip(runGrep(sandbox, { pattern: "target", path: "safe" }));

      assert.strictEqual(error.reason, "out-of-bounds");
      assert.strictEqual(error.path, "safe");
    }),
  );

  it.effect("treats no grep matches as success and rejects invalid regular expressions", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const missing = yield* runGrep(sandbox, { pattern: "absent" });
      const invalid = yield* Effect.flip(runGrep(sandbox, { pattern: "[" }));

      assert.deepStrictEqual(missing.matches, []);
      assert.strictEqual(invalid.reason, "invalid-args");
    }),
  );

  it.effect("skips oversized fallback candidates without dropping later matches", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const oversizedLine = "x".repeat(1024 * 1024);
      yield* writeFile(sandbox, { path: "large.txt", content: `${oversizedLine}\nfoo.bar\n` });

      const grepped = yield* runGrep(sandbox, { pattern: "foo.bar" });

      assert.deepStrictEqual(grepped.matches, [{ path: "large.txt", line: 2, text: "foo.bar" }]);
    }),
  );

  it.effect("preserves JavaScript identity escapes in grep patterns", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* writeFile(sandbox, { path: "identity.txt", content: "q\nk<foo>\n8\na\n😀\néa\n" });

      const identity = yield* runGrep(sandbox, { pattern: "\\q" });
      const namedIdentity = yield* runGrep(sandbox, { pattern: "\\k<foo>" });
      const numericIdentity = yield* runGrep(sandbox, { pattern: "\\8" });
      const unmatchedBackreference = yield* runGrep(sandbox, { pattern: "(a|(b))\\2" });
      const utf16Units = yield* runGrep(sandbox, { pattern: "^..$" });
      const asciiBoundary = yield* runGrep(sandbox, { pattern: "\\ba" });
      const unicodeEscape = yield* runGrep(sandbox, { pattern: "\\u0061" });

      assert.deepStrictEqual(identity.matches, [{ path: "identity.txt", line: 1, text: "q" }]);
      assert.deepStrictEqual(namedIdentity.matches, [{ path: "identity.txt", line: 2, text: "k<foo>" }]);
      assert.deepStrictEqual(numericIdentity.matches, [{ path: "identity.txt", line: 3, text: "8" }]);
      assert.deepStrictEqual(unmatchedBackreference.matches, [
        { path: "identity.txt", line: 4, text: "a" },
        { path: "identity.txt", line: 6, text: "éa" },
      ]);
      assert.deepStrictEqual(utf16Units.matches, [
        { path: "identity.txt", line: 5, text: "😀" },
        { path: "identity.txt", line: 6, text: "éa" },
      ]);
      assert.deepStrictEqual(asciiBoundary.matches, [
        { path: "identity.txt", line: 4, text: "a" },
        { path: "identity.txt", line: 6, text: "éa" },
      ]);
      assert.deepStrictEqual(unicodeEscape.matches, [
        { path: "identity.txt", line: 4, text: "a" },
        { path: "identity.txt", line: 6, text: "éa" },
      ]);
    }),
  );

  it.effect("shell-quotes every model-controlled search argument", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      yield* runGlob(sandbox, { pattern: "**/*.ts'; touch escaped; printf '" });
      yield* runGrep(sandbox, {
        pattern: "target'; touch escaped; printf '",
        include: "**/*.ts'; touch escaped; printf '",
      });

      assert.isFalse(yield* Effect.promise(() => sandbox.handle.fs.exists("escaped")));
    }),
  );

  it.effect("caps glob and grep output and stops each subprocess", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const globPaths = `${Array.from({ length: 1001 }, (_, index) => `file-${index}.ts`).join("\0")}\0`;
      const glob = searchOutputSandbox(original, globPaths);
      const grepEvents = `${Array.from({ length: 2001 }, (_, index) =>
        ripgrepMatchRecord(`file-${index}.${index < 1000 ? "js" : "ts"}`),
      ).join("\n")}\n`;
      const grep = searchOutputSandbox(original, grepEvents);

      const globbed = yield* runGlob(glob.sandbox, { pattern: "**/*.ts" });
      const grepped = yield* runGrep(grep.sandbox, { pattern: "target", include: "**/*.ts" });

      assert.strictEqual(globbed.matches.length, 1000);
      assert.strictEqual(grepped.matches.length, 1000);
      assert.strictEqual(grepped.matches[0]?.path, "file-1000.ts");
      assert.deepStrictEqual(glob.signals, ["SIGTERM"]);
      assert.deepStrictEqual(grep.signals, ["SIGTERM"]);
    }),
  );

  it.effect("returns capped output when stopping an exited subprocess", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const paths = `${Array.from({ length: 1001 }, (_, index) => `file-${index}.ts`).join("\0")}\0`;
      const output = searchOutputSandbox(original, paths, () => Promise.reject(new Error("already exited")));

      const globbed = yield* runGlob(output.sandbox, { pattern: "**/*.ts" });

      assert.strictEqual(globbed.matches.length, 1000);
      assert.deepStrictEqual(output.signals, ["SIGTERM"]);
    }),
  );

  it.effect("stops a timed-out search subprocess", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const stalled = yield* stalledSearchSandbox(original);
      const fiber = yield* runGlob(stalled.sandbox, { pattern: "**/*" }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(stalled.started);
      yield* TestClock.adjust("30 seconds");

      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "timeout");
      assert.isTrue(Option.isSome(yield* Deferred.poll(stalled.killed)));
    }),
  );

  it.effect("stops an interrupted search subprocess", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const stalled = yield* stalledSearchSandbox(original);
      const fiber = yield* runGrep(stalled.sandbox, { pattern: "target" }).pipe(Effect.forkChild);
      yield* Deferred.await(stalled.started);
      yield* Fiber.interrupt(fiber);

      assert.isTrue(Option.isSome(yield* Deferred.poll(stalled.killed)));
    }),
  );

  it.effect("maps search launch and output failures to exec-failed", () =>
    Effect.gen(function* () {
      const original = yield* openSandbox();
      const launchFailure: WorktreeSandbox = {
        ...original,
        handle: {
          ...original.handle,
          process: {
            ...original.handle.process,
            spawn: () => Promise.reject(new Error("launch failed")),
          },
        },
      };
      const malformed = searchOutputSandbox(original, "not-json\n");
      const oversized = searchOutputSandbox(original, `${"x".repeat(1024 * 1024 + 1)}\n`);

      const launchError = yield* Effect.flip(runGlob(launchFailure, { pattern: "**/*" }));
      const parseError = yield* Effect.flip(runGrep(malformed.sandbox, { pattern: "target" }));
      const sizeError = yield* Effect.flip(runGrep(oversized.sandbox, { pattern: "target" }));

      assert.strictEqual(launchError.reason, "exec-failed");
      assert.strictEqual(parseError.reason, "exec-failed");
      assert.strictEqual(sizeError.reason, "exec-failed");
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
