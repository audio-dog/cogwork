import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, test, vi } from "vitest";

import { testTimingMarker } from "../test/test-count-reporter.ts";
import {
  configurationComparisonVitestTestArgs,
  measure,
  measureComparison,
  run,
  vitestTestArgs,
} from "./test-measure.mjs";

const emptyWorkspaceRoot = mkdtempSync(path.join(tmpdir(), "empty-sensor-workspace-"));
const completeFailedVitest = {
  failed: true,
  stdout: `cogwork-test-count:2\n${testTimingMarker}${JSON.stringify({
    packagePath: emptyWorkspaceRoot,
    durationMs: 50,
    testCount: 2,
    testFiles: [{ path: "src/engine.test.ts", durationMs: 50, testCount: 2 }],
  })}\nTasks: 0 successful, 1 total\n`,
};
const packageResults = (vitest, ...remaining) => {
  const results = [vitest, ...remaining];
  return async () => results.shift();
};

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
  const timingReport = JSON.stringify({
    packagePath: emptyWorkspaceRoot,
    durationMs: 50,
    testCount: 2,
    testFiles: [{ path: "src/example.test.ts", durationMs: 50, testCount: 2 }],
  });
  const script = `
    import { measure } from "./configs/sensor/test-measure.mjs";
    const results = [
      { failed: true, stdout: ${JSON.stringify(`cogwork-test-count:2\n${testTimingMarker}${timingReport}\nTasks: 0 successful, 1 total\n`)} },
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

  const measurement = await measureComparison(packageResults(completeFailedVitest), emptyWorkspaceRoot);

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
    const vitest = {
      failed: false,
      stdout: `cogwork-test-count:2\n${testTimingMarker}${JSON.stringify({
        packagePath: directory,
        durationMs: 50,
        testCount: 2,
        testFiles: [{ path: "src/example.test.ts", durationMs: 50, testCount: 2 }],
      })}\nTasks: 1 successful, 1 total\n`,
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const legacy = {
      failed: false,
      stdout: `cogwork-test-count:3\n${testTimingMarker}${JSON.stringify({
        packagePath: directory,
        durationMs: 30,
        testCount: 3,
        testFiles: [{ path: "scripts/legacy.test.mjs", durationMs: 25, testCount: 3 }],
      })}\n`,
    };

    const measurement = await measureComparison(packageResults(vitest, legacy), directory);

    assert.equal(measurement.testCount, 5);
    assert.ok(measurement.durationMs >= 30);
    assert.deepEqual(measurement.testFiles, [
      { path: "src/example.test.ts", durationMs: 50, testCount: 2 },
      { path: "scripts/legacy.test.mjs", durationMs: 25, testCount: 3 },
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("measurement ranks packages and test files slowest-first", async () => {
  const packageReports = [
    {
      packagePath: path.join(emptyWorkspaceRoot, "packages", "fast"),
      durationMs: 40,
      testCount: 2,
      testFiles: [{ path: "src/fast.test.ts", durationMs: 40, testCount: 2 }],
    },
    {
      packagePath: path.join(emptyWorkspaceRoot, "packages", "slow"),
      durationMs: 310,
      testCount: 3,
      testFiles: [
        { path: "src/middle.test.ts", durationMs: 110, testCount: 1 },
        { path: "src/slow.test.ts", durationMs: 200, testCount: 2 },
      ],
    },
  ];
  const stdout = [
    "cogwork-test-count:2",
    `${testTimingMarker}${JSON.stringify(packageReports[0])}`,
    "cogwork-test-count:3",
    `${testTimingMarker}${JSON.stringify(packageReports[1])}`,
    "Tasks: 2 successful, 2 total",
  ].join("\n");
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  const measurement = await measureComparison(packageResults({ failed: false, stdout }), emptyWorkspaceRoot);

  assert.deepEqual(measurement.packages, [
    { path: "packages/slow", durationMs: 310, testCount: 3 },
    { path: "packages/fast", durationMs: 40, testCount: 2 },
  ]);
  assert.deepEqual(measurement.testFiles, [
    { path: "packages/slow/src/slow.test.ts", durationMs: 200, testCount: 2 },
    { path: "packages/slow/src/middle.test.ts", durationMs: 110, testCount: 1 },
    { path: "packages/fast/src/fast.test.ts", durationMs: 40, testCount: 2 },
  ]);
});

test("measurement uses current lint timings with historical package output", async () => {
  const timingReport = JSON.stringify({
    packagePath: emptyWorkspaceRoot,
    durationMs: 50,
    testCount: 2,
    testFiles: [{ path: "src/example.test.ts", durationMs: 50, testCount: 2 }],
  });
  const stdout = [
    "cogwork-test-count:2",
    `${testTimingMarker}${timingReport}`,
    "cogwork-test-count:3",
    "Tasks: 2 successful, 2 total",
  ].join("\n");
  const lint = {
    failed: false,
    stdout: `cogwork-test-count:3\n${testTimingMarker}${JSON.stringify({
      packagePath: path.join(emptyWorkspaceRoot, "configs/lint"),
      durationMs: 70,
      testCount: 3,
      testFiles: [{ path: "tests/rules.test.mjs", durationMs: 60, testCount: 3 }],
    })}\n`,
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  const measurement = await measureComparison(
    packageResults({ failed: false, stdout }, lint),
    emptyWorkspaceRoot,
  );

  assert.equal(measurement.testCount, 5);
  assert.deepEqual(measurement.packages.at(0), {
    path: "configs/lint",
    durationMs: 70,
    testCount: 3,
  });
});

test("measurement rejects a complete timing count mismatch", async () => {
  const timingReport = JSON.stringify({
    packagePath: emptyWorkspaceRoot,
    durationMs: 50,
    testCount: 3,
    testFiles: [{ path: "src/example.test.ts", durationMs: 50, testCount: 3 }],
  });
  const stdout = [
    "cogwork-test-count:2",
    `${testTimingMarker}${timingReport}`,
    "Tasks: 1 successful, 1 total",
  ].join("\n");

  await assert.rejects(
    () => measureComparison(packageResults({ failed: false, stdout }), emptyWorkspaceRoot),
    /disagrees/,
  );
});

test("measurement rejects extra timing reports", async () => {
  const timingReport = JSON.stringify({
    packagePath: emptyWorkspaceRoot,
    durationMs: 50,
    testCount: 2,
    testFiles: [{ path: "src/example.test.ts", durationMs: 50, testCount: 2 }],
  });
  const stdout = [
    "cogwork-test-count:2",
    `${testTimingMarker}${timingReport}`,
    `${testTimingMarker}${timingReport}`,
    "Tasks: 1 successful, 1 total",
  ].join("\n");

  await assert.rejects(
    () => measureComparison(packageResults({ failed: false, stdout }), emptyWorkspaceRoot),
    /incomplete/,
  );
});

test("measurement uses the final Turbo task summary", async () => {
  const timingReport = JSON.stringify({
    packagePath: emptyWorkspaceRoot,
    durationMs: 50,
    testCount: 2,
    testFiles: [{ path: "src/example.test.ts", durationMs: 50, testCount: 2 }],
  });
  const stdout = [
    "Tasks: 2 successful, 2 total",
    "cogwork-test-count:2",
    `${testTimingMarker}${timingReport}`,
    "Tasks: 1 successful, 1 total",
  ].join("\n");
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  const measurement = await measureComparison(packageResults({ failed: false, stdout }), emptyWorkspaceRoot);

  assert.equal(measurement.testCount, 2);
});

test("measurement matches the package test gate", async () => {
  const commands = [];
  const timingReport = JSON.stringify({
    packagePath: emptyWorkspaceRoot,
    durationMs: 50,
    testCount: 2,
    testFiles: [{ path: "src/example.test.ts", durationMs: 50, testCount: 2 }],
  });
  const vitest = {
    failed: false,
    stdout: `cogwork-test-count:2\n${testTimingMarker}${timingReport}\nTasks: 1 successful, 1 total`,
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  await measure(async (_file, args) => {
    commands.push(args);
    return [vitest, { failed: false, stdout: "{}" }][commands.length - 1];
  }, emptyWorkspaceRoot);

  assert.equal(commands.length, 2);
  assert.equal(commands[0].includes("test"), true);
  assert.equal(commands[1].at(-1), "configs/sensor/count-worktree-git-invocations.ts");
});
