import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { eligibleFiles, pathsFromPayload } from "./format-edited-files.mjs";

const runHook = (checkout, payload) =>
  spawnSync(process.execPath, [join(checkout, "scripts/format-edited-files.mjs")], {
    cwd: checkout,
    encoding: "utf8",
    input: JSON.stringify(payload),
  });

test("reads the file from a Cursor afterFileEdit payload", () => {
  assert.deepEqual(pathsFromPayload({ file_path: "/checkout/src/one.ts", edits: [] }), [
    "/checkout/src/one.ts",
  ]);
});

test("reads one file from a Codex Write payload", () => {
  assert.deepEqual(
    pathsFromPayload({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/checkout/src/one.ts", content: "export const one = 1;" },
    }),
    ["/checkout/src/one.ts"],
  );
});

test("reads every file from a Codex apply_patch payload", () => {
  const patch = `*** Begin Patch
*** Update File: /checkout/src/one.ts
@@
-one
+two
*** Add File: /checkout/src/path with spaces.ts
+export const value = 1;
*** Update File: /checkout/src/old-name.ts
*** Move to: /checkout/src/new-name.ts
*** Delete File: /checkout/src/removed.ts
*** End Patch`;

  assert.deepEqual(
    pathsFromPayload({
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: patch },
    }),
    [
      "/checkout/src/one.ts",
      "/checkout/src/path with spaces.ts",
      "/checkout/src/old-name.ts",
      "/checkout/src/new-name.ts",
      "/checkout/src/removed.ts",
    ],
  );
});

test("ignores malformed hook payloads", () => {
  assert.deepEqual(pathsFromPayload({ hook_event_name: "afterFileEdit", file_path: 3 }), []);
  assert.deepEqual(
    pathsFromPayload({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: null }),
    [],
  );
  assert.deepEqual(
    pathsFromPayload({
      hook_event_name: "PostToolUse",
      tool_name: "Shell",
      tool_input: { file_path: "one.ts" },
    }),
    [],
  );
});

test("keeps only existing checkout files, including paths with spaces", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "cogwork-edit-hook-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const checkout = join(parent, "checkout");
  const source = join(checkout, "src");
  const edited = join(source, "path with spaces.ts");
  const outside = join(parent, "outside.ts");
  await mkdir(source, { recursive: true });
  await writeFile(edited, "export const edited = true;\n");
  await writeFile(outside, "export const outside = true;\n");

  assert.deepEqual(await eligibleFiles([edited, join(source, "deleted.ts"), outside], checkout), [
    await realpath(edited),
  ]);
});

test("skips checkout symlinks that resolve outside the checkout", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "cogwork-edit-hook-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const checkout = join(parent, "checkout");
  const outside = join(parent, "outside.ts");
  const linked = join(checkout, "linked.ts");
  await mkdir(checkout, { recursive: true });
  await writeFile(outside, "export const outside = true;\n");
  await symlink(outside, linked);

  assert.deepEqual(await eligibleFiles([linked], checkout), []);
});

test("skips checkout hard links that also address files outside the checkout", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "cogwork-edit-hook-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const checkout = join(parent, "checkout");
  const outside = join(parent, "outside.ts");
  const linked = join(checkout, "linked.ts");
  await mkdir(checkout, { recursive: true });
  await writeFile(outside, "export const outside = true;\n");
  await link(outside, linked);

  assert.deepEqual(await eligibleFiles([linked], checkout), []);
});

test("does not change an unsupported edited file", async (context) => {
  const checkout = process.cwd();
  const directory = await mkdtemp(join(checkout, ".format-edited-files-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "notes.unsupported");
  const contents = "keep this text\n";
  await writeFile(file, contents);

  const result = runHook(checkout, { hook_event_name: "afterFileEdit", file_path: file });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(file, "utf8"), contents);
});

test("formats every patched file without changing an unrelated file", async (context) => {
  const checkout = process.cwd();
  const directory = await mkdtemp(join(checkout, "format-edited-files-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "one.ts");
  const second = join(directory, "path with spaces.ts");
  const unrelated = join(directory, "unrelated.ts");
  const unformatted = "export const value={nested:true}\n";
  await Promise.all([
    writeFile(first, unformatted),
    writeFile(second, unformatted),
    writeFile(unrelated, unformatted),
  ]);

  const command = `*** Begin Patch
*** Update File: ${first}
*** Update File: ${second}
*** End Patch`;
  const result = runHook(checkout, {
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: { command },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(first, "utf8"), "export const value = { nested: true };\n");
  assert.equal(await readFile(second, "utf8"), "export const value = { nested: true };\n");
  assert.equal(await readFile(unrelated, "utf8"), unformatted);
});
