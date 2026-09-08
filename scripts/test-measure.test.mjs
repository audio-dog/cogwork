import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "./test-measure.mjs";

test("a failed test command preserves its measurement output", async () => {
  const result = await run(process.execPath, [
    "-e",
    'process.stdout.write("measurement"); process.exitCode = 1;',
  ]);

  assert.equal(result.failed, true);
  assert.equal(result.stdout, "measurement");
});

test("a failed suite publishes measurement JSON and exits nonzero", () => {
  const script = `
    import { measure } from "./scripts/test-measure.mjs";
    const results = [
      { failed: true, stdout: "cogwork-test-count:2" },
      { failed: false, stdout: "# tests 3" },
    ];
    await measure(async () => results.shift());
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).testCount, 5);
});

test("the summary puts duration beside test count", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-measure-summary-"));
  const measurementPath = path.join(directory, "measurement.json");
  context.after(() => rmSync(directory, { recursive: true }));
  writeFileSync(measurementPath, JSON.stringify({ durationMs: 17_042, testCount: 1_234 }));

  const result = spawnSync(process.execPath, ["scripts/test-measure-summary.mjs", measurementPath], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "## Test suite cost\n\n| Duration | Test count |\n| ---: | ---: |\n| 17.042 s | 1,234 |\n",
  );
});
