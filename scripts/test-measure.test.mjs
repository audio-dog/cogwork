import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { measure, measureComparison, run, runMeasuredNodeTests, vitestTestArgs } from "./test-measure.mjs";

const exec = promisify(execFile);
const execEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
);
const scriptPath = path.join(import.meta.dirname, "test-measure.mjs");
const completeFailedVitest = {
  failed: true,
  stdout: "cogwork-test-count:2\nTasks: 0 successful, 1 total\n",
};

test("node-only rejects a workspace with no configured root tests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cogwork-test-measure-"));
  const discoveredTestDirectory = path.join(root, "test");

  try {
    await mkdir(discoveredTestDirectory);
    await writeFile(
      path.join(discoveredTestDirectory, "surprise.test.mjs"),
      'throw new Error("unexpected discovery");\n',
    );
    await assert.rejects(
      exec(process.execPath, [scriptPath, "--node-only"], { cwd: root, env: execEnvironment }),
      /No root Node test files found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node-only excludes lint-rule tests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cogwork-test-measure-"));
  const lintTestDirectory = path.join(root, "configs", "lint", "tests");
  const scriptDirectory = path.join(root, "scripts");

  try {
    await mkdir(lintTestDirectory, { recursive: true });
    await mkdir(scriptDirectory);
    await writeFile(path.join(lintTestDirectory, "rules.test.mjs"), 'throw new Error("lint test ran");\n');
    await writeFile(
      path.join(scriptDirectory, "script.test.mjs"),
      'import test from "node:test";\ntest("script", () => {});\n',
    );
    const result = await exec(process.execPath, [scriptPath, "--node-only"], {
      cwd: root,
      env: execEnvironment,
    });

    assert.match(result.stdout, /# tests 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measurement treats missing root Node tests as zero", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cogwork-test-measure-"));

  try {
    assert.deepEqual(await runMeasuredNodeTests(root), {
      failed: false,
      stdout: "# tests 0\n",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measured Turbo runs every task after a failure", () => {
  assert.ok(vitestTestArgs("turbo", "reporter").includes("--continue=always"));
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
    import { run } from "./scripts/test-measure.mjs";
    const result = await run(process.execPath, ["--eval", 'process.stdout.write("live log")']);
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
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
    import { measure } from "./scripts/test-measure.mjs";
    const results = [
      { failed: true, stdout: "cogwork-test-count:2\\nTasks: 0 successful, 1 total\\n" },
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
  assert.equal(result.stderr, "");
});

test("comparison measurement accepts a completed failed suite", async (context) => {
  const results = [completeFailedVitest, { failed: false, stdout: "# tests 3" }];
  const output = [];
  context.mock.method(console, "log", (value) => output.push(value));

  const measurement = await measureComparison(async () => results.shift());

  assert.equal(measurement.testCount, 5);
  assert.equal(JSON.parse(output[0]).testCount, 5);
});

test("comparison measurement rejects an incomplete failed suite", async () => {
  const results = [
    { failed: true, stdout: "cogwork-test-count:2\n" },
    { failed: false, stdout: "# tests 3" },
  ];

  await assert.rejects(() => measureComparison(async () => results.shift()), /did not complete/);
});

test("measurement matches the root test gate", async (context) => {
  const commands = [];
  const results = [
    { failed: false, stdout: "cogwork-test-count:2" },
    { failed: false, stdout: "# tests 3" },
    { failed: false, stdout: "{}" },
  ];
  context.mock.method(console, "log", () => undefined);

  await measure(async (_file, args) => {
    commands.push(args);
    return results[commands.length - 1];
  });

  assert.equal(commands.length, 3);
  assert.equal(commands[1].includes("scripts/test-compare.test.mjs"), true);
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
