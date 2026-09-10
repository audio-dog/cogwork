import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test, vi } from "vitest";
import {
  configurationComparisonVitestTestArgs,
  measure,
  measureComparison,
  run,
  vitestTestArgs,
} from "./test-measure.mjs";

const completeFailedVitest = {
  failed: true,
  stdout: "cogwork-test-count:2\nTasks: 0 successful, 1 total\n",
};
const emptyWorkspaceRoot = mkdtempSync(path.join(tmpdir(), "empty-sensor-workspace-"));

afterAll(() => rmSync(emptyWorkspaceRoot, { recursive: true }));

test("measured Turbo runs every task after a failure", () => {
  assert.ok(vitestTestArgs("turbo").includes("--continue=always"));
});

test("measured Turbo gets test counts without cache-busting passthrough arguments", () => {
  assert.deepEqual(vitestTestArgs("turbo"), ["turbo", "test", "--continue=always", "--output-logs=full"]);
});

test("configuration comparison runs bypass cache and pass each side environment", () => {
  assert.deepEqual(configurationComparisonVitestTestArgs("turbo"), [
    "turbo",
    "test",
    "--continue=always",
    "--output-logs=full",
    "--cache=local:,remote:",
    "--env-mode=loose",
  ]);
});

test("historical worktrees get the extracted count reporter", () => {
  assert.deepEqual(vitestTestArgs("turbo", "file:///count-reporter.ts"), [
    "turbo",
    "test",
    "--continue=always",
    "--output-logs=full",
    "--",
    "--reporter=default",
    "--reporter=file:///count-reporter.ts",
  ]);
});

test("a failed test command preserves its measurement output", async () => {
  const result = await run(process.execPath, [
    "-e",
    'process.stdout.write("measurement"); process.exitCode = 1;',
  ]);

  assert.equal(result.failed, true);
  assert.equal(result.stdout, "measurement");
});

test("a test command streams output before it exits", async () => {
  const script = `
    import { run } from "./configs/sensor/test-measure.mjs";
    const result = await run(process.execPath, ["--eval", 'process.stdout.write("live log")']);
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const resultOutput = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (output) => resultOutput.push(output));
  child.stderr.setEncoding("utf8");
  const firstOutput = once(child.stderr, "data").then(([output]) => ({ kind: "output", output }));
  const exit = once(child, "exit").then(([status]) => ({ kind: "exit", status }));

  assert.deepEqual(await Promise.race([firstOutput, exit]), { kind: "output", output: "live log" });
  assert.deepEqual(await exit, { kind: "exit", status: 0 });
  assert.equal(JSON.parse(resultOutput.join("")).stdout, "live log");
});

test("a completed failed suite publishes measurements and exits nonzero", () => {
  const script = `
    import { measure } from "./configs/sensor/test-measure.mjs";
    const results = [
      { failed: true, stdout: "cogwork-test-count:2\\nTasks: 0 successful, 1 total\\n" },
      { failed: false, stdout: "git measurement" },
    ];
    await measure(async () => results.shift(), ${JSON.stringify(emptyWorkspaceRoot)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).testCount, 2);
  assert.equal(result.stderr, "");
});

test("comparison measurement accepts a completed failed suite", async () => {
  const output = [];
  vi.spyOn(console, "log").mockImplementation((value) => output.push(value));

  const measurement = await measureComparison(async () => completeFailedVitest, emptyWorkspaceRoot);

  assert.equal(measurement.testCount, 2);
  assert.equal(JSON.parse(output[0]).testCount, 2);
});

test("comparison measurement rejects an incomplete failed suite", async () => {
  await assert.rejects(
    () => measureComparison(async () => ({ failed: true, stdout: "cogwork-test-count:2\n" })),
    /did not complete/,
  );
});

test("comparison measurement rejects an incomplete successful suite", async () => {
  await assert.rejects(
    () =>
      measureComparison(async () => ({
        failed: false,
        stdout: "cogwork-test-count:2\nTasks: 2 successful, 2 total\n",
      })),
    /did not complete/,
  );
});

test("comparison measurement includes root script tests", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "root-script-tests-"));
  try {
    mkdirSync(path.join(directory, "scripts"));
    writeFileSync(path.join(directory, "scripts", "legacy.test.mjs"), "");
    const results = [
      { failed: false, stdout: "cogwork-test-count:2\nTasks: 1 successful, 1 total\n" },
      { failed: false, stdout: "# tests 3\n" },
    ];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const measurement = await measureComparison(async () => results.shift(), directory);

    assert.equal(measurement.testCount, 5);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("measurement matches the package test gate", async () => {
  const commands = [];
  const results = [
    { failed: false, stdout: "cogwork-test-count:2\nTasks: 1 successful, 1 total" },
    { failed: false, stdout: "{}" },
  ];
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  await measure(async (_file, args) => {
    commands.push(args);
    return results[commands.length - 1];
  }, emptyWorkspaceRoot);

  assert.equal(commands.length, 2);
  assert.equal(commands[0].includes("test"), true);
  assert.equal(commands[1].at(-1), "configs/sensor/count-worktree-git-invocations.ts");
});

test("the summary puts duration beside test count", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-measure-summary-"));
  const measurementPath = path.join(directory, "measurement.json");
  try {
    writeFileSync(measurementPath, JSON.stringify({ durationMs: 17_042, testCount: 1_234 }));
    const result = spawnSync(process.execPath, ["configs/sensor/test-measure-summary.mjs", measurementPath], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "## Test suite cost\n\n| Duration | Test count |\n| ---: | ---: |\n| 17.042 s | 1,234 |\n",
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
