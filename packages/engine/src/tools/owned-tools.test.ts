import { assert, describe, it } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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
import type { WorktreeSandbox } from "./sandbox";

const openSandbox = Effect.fn("owned-tools.test.openSandbox")(function* () {
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

  it.effect("exposes the seven tools as server tool definitions", () =>
    Effect.gen(function* () {
      const sandbox = yield* openSandbox();
      const tools = makeOwnedToolSet(sandbox);
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
      const result = yield* Effect.promise(() => execute({ path: "via-tool.txt", content: "ok" }));
      assert.deepStrictEqual(result, { path: "via-tool.txt", bytesWritten: 2 });
    }),
  );
});
