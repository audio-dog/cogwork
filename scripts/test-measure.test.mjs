import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { measure, run } from "./test-measure.mjs";

test("a failed test command preserves its measurement output", async () => {
  const result = await run(process.execPath, [
    "-e",
    'process.stdout.write("measurement"); process.exitCode = 1;',
  ]);

  assert.equal(result.failed, true);
  assert.equal(result.stdout, "measurement");
});

test("a failed suite publishes both measurements and exits nonzero", () => {
  const script = `
    import { measure } from "./scripts/test-measure.mjs";
    const results = [
      { failed: true, stdout: "cogwork-test-count:2" },
      { failed: false, stdout: "# tests 3" },
      { failed: false, stdout: "git measurement" },
    ];
    await measure(async () => results.shift());
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).testCount, 5);
  assert.equal(result.stderr, "cogwork-test-count:2# tests 3git measurement");
});

test("a passing suite publishes its logs outside the measurement output", () => {
  const script = `
    import { measure } from "./scripts/test-measure.mjs";
    const results = [
      { failed: false, stdout: "vitest logs\\ncogwork-test-count:2\\n", stderr: "vitest warning\\n" },
      { failed: false, stdout: "node logs\\n# tests 3\\n", stderr: "" },
      { failed: false, stdout: "git measurement\\n", stderr: "" },
    ];
    await measure(async () => results.shift());
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).testCount, 5);
  assert.equal(
    result.stderr,
    "vitest logs\ncogwork-test-count:2\nvitest warning\nnode logs\n# tests 3\ngit measurement\n",
  );
});

test("measurement matches the root test gate", async () => {
  const commands = [];
  const results = [
    { failed: false, stdout: "cogwork-test-count:2" },
    { failed: false, stdout: "# tests 3" },
    { failed: false, stdout: "{}" },
  ];

  await measure(async (_file, args) => {
    commands.push(args);
    return results[commands.length - 1];
  });

  assert.equal(commands.length, 3);
  assert.equal(commands[1].includes("configs/lint/tests/rules.test.mjs"), false);
  assert.equal(commands[2].at(-1), "scripts/count-worktree-git-invocations.ts");
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
