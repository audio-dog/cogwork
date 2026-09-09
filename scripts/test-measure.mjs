#!/usr/bin/env node
import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const countMarker = "cogwork-test-count:";
const measuredTestStates = ["passed", "failed"];
const scriptPath = fileURLToPath(import.meta.url);
const vitestCountPattern = new RegExp(`${countMarker}(\\d+)`, "g");
const nodeTestCountPattern = /^# tests (\d+)$/m;
const turboTaskCountPattern = /Tasks:\s+\d+ successful, (\d+) total/;
const defaultWorkspaceRoot = dirname(dirname(scriptPath));
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
const nodeTestPatterns = ["scripts/*.test.mjs"];
const isMeasuredTest = (testCase) => measuredTestStates.includes(testCase.result().state);

export default class TestCountReporter {
  onTestRunEnd(testModules) {
    const testCount = testModules
      .flatMap((testModule) => [...testModule.children.allTests()])
      .filter(isMeasuredTest).length;
    console.log(`${countMarker}${testCount}`);
  }
}

const describe = (error) => (error instanceof Error ? error.message : String(error));

export const run = (file, args, workspaceRoot = defaultWorkspaceRoot) =>
  new Promise((resolve, reject) => {
    const stdout = [];
    const child = spawn(file, args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (output) => {
      stdout.push(output);
      process.stderr.write(output);
    });
    child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("close", (code) => resolve({ failed: code !== 0, stdout: stdout.join("") }));
  });

const completedVitestRun = (output) => {
  const taskCount = output.match(turboTaskCountPattern)?.[1];
  if (!taskCount) return false;
  return Number(taskCount) === [...output.matchAll(vitestCountPattern)].length;
};

const completedTestRuns = {
  node: (output) => nodeTestCountPattern.test(output),
  vitest: completedVitestRun,
};

const requireCompletedTestRun = (result, suite) => {
  if (!result.failed || completedTestRuns[suite]?.(result.stdout)) return result;
  throw new Error(`${suite} test run did not complete`);
};

const requireSuccess = (result, label) => {
  if (!result.failed) return result;
  throw new Error(`${label} failed`);
};

const runMeasuredTests = async (file, args, workspaceRoot, suite, runTestCommand = run) =>
  requireCompletedTestRun(await runTestCommand(file, args, workspaceRoot), suite);

const vitestCount = (output) => {
  const counts = [...output.matchAll(vitestCountPattern)];
  if (counts.length === 0) throw new Error("Vitest reported no test counts");
  return counts.reduce((total, [, count]) => total + Number(count), 0);
};

const nodeTestCount = (output) => {
  const match = output.match(nodeTestCountPattern);
  if (!match) throw new Error("Node reported no test count");
  return Number(match[1]);
};

const nodeTestFiles = (workspaceRoot) =>
  nodeTestPatterns.flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }));

const nodeTestArgs = (testFiles) => ["--test", "--test-reporter=tap", ...testFiles];

const requiredNodeTestArgs = (workspaceRoot) => {
  const testFiles = nodeTestFiles(workspaceRoot);
  if (testFiles.length === 0) throw new Error(`No root Node test files found in ${workspaceRoot}`);
  return nodeTestArgs(testFiles);
};

const runNodeTests = async (workspaceRoot) =>
  requireSuccess(
    await run(process.execPath, requiredNodeTestArgs(workspaceRoot), workspaceRoot),
    "Root Node tests",
  );

export const runMeasuredNodeTests = (workspaceRoot, runTestCommand = run) => {
  const testFiles = nodeTestFiles(workspaceRoot);
  if (testFiles.length === 0) return Promise.resolve({ failed: false, stdout: "# tests 0\n" });
  return runMeasuredTests(process.execPath, nodeTestArgs(testFiles), workspaceRoot, "node", runTestCommand);
};

export const vitestTestArgs = (turboPath, reporterPath) => [
  turboPath,
  "test",
  "--force",
  "--continue=always",
  "--output-logs=full",
  "--",
  "--reporter=default",
  `--reporter=${reporterPath}`,
];

const runTestSuites = async (runTestCommand, workspaceRoot) => {
  const reporterPath = pathToFileURL(scriptPath).href;
  const turboPath = fileURLToPath(import.meta.resolve("turbo/bin/turbo"));
  const vitest = await runMeasuredTests(
    process.execPath,
    vitestTestArgs(turboPath, reporterPath),
    workspaceRoot,
    "vitest",
    runTestCommand,
  );
  const nodeTests = await runMeasuredNodeTests(workspaceRoot, runTestCommand);
  return { nodeTests, vitest };
};

const buildMeasurement = (startedAt, { nodeTests, vitest }) => ({
  durationMs: Math.round(performance.now() - startedAt),
  testCount: vitestCount(vitest.stdout) + nodeTestCount(nodeTests.stdout),
});

const publishMeasurement = (measurement) => console.log(JSON.stringify(measurement));

export const measureComparison = async (runTestCommand = run, workspaceRoot = defaultWorkspaceRoot) => {
  const startedAt = performance.now();
  const testSuites = await runTestSuites(runTestCommand, workspaceRoot);
  const measurement = buildMeasurement(startedAt, testSuites);
  publishMeasurement(measurement);
  return measurement;
};

export const measure = async (runTestCommand = run, workspaceRoot = defaultWorkspaceRoot) => {
  const startedAt = performance.now();
  const testSuites = await runTestSuites(runTestCommand, workspaceRoot);
  const tsxPath = fileURLToPath(import.meta.resolve("tsx/cli"));
  const gitMeasurement = await runTestCommand(
    process.execPath,
    [tsxPath, "scripts/count-worktree-git-invocations.ts"],
    workspaceRoot,
  );
  requireSuccess(gitMeasurement, "Git measurement");
  const measurement = buildMeasurement(startedAt, testSuites);
  publishMeasurement(measurement);
  if (Object.values(testSuites).some(({ failed }) => failed)) process.exitCode = 1;
  return measurement;
};

const main = async () => {
  const [mode] = process.argv.slice(2);
  if (mode === "--node-only") {
    const result = await runNodeTests(process.cwd());
    process.stdout.write(result.stdout);
    return;
  }
  if (mode === "--comparison") return measureComparison(run, process.cwd());
  if (!mode) return measure(run, process.cwd());
  throw new Error("Usage: test-measure.mjs [--comparison|--node-only]");
};

if (isMain) {
  main().catch((error) => {
    console.error(describe(error));
    process.exitCode = 1;
  });
}
