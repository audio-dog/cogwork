import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "test-measure.mjs");

test("node-only rejects a workspace with no configured root tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogwork-test-measure-"));
  const discoveredTestDirectory = join(root, "test");

  try {
    await mkdir(discoveredTestDirectory);
    await writeFile(
      join(discoveredTestDirectory, "surprise.test.mjs"),
      'throw new Error("unexpected discovery");\n',
    );
    await assert.rejects(
      exec(process.execPath, [scriptPath, "--node-only"], { cwd: root }),
      /No root Node test files found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
