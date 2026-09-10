#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testCountMarker } from "../test/test-count-reporter.ts";

const vitestCountPattern = new RegExp(`${testCountMarker}(\\d+)`, "g");
const nodeTestCountPattern = /^# tests (\d+)$/m;
const turboTaskCountPattern = /Tasks:\s+\d+ successful, (\d+) total/;
const defaultWorkspaceRoot = resolve(import.meta.dirname, "../..");
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
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

const requireCompletedTestRun = (result) => {
  if (completedVitestRun(result.stdout)) return result;
  throw new Error("Vitest test run did not complete");
};

const requireSuccess = (result, label) => {
  if (!result.failed) return result;
  throw new Error(`${label} failed`);
};

const nodeTestCount = (output) => {
  const count = output.match(nodeTestCountPattern)?.[1];
  if (!count) throw new Error("Node reported no test count");
  return Number(count);
};

const legacyRootTestFiles = (workspaceRoot) => globSync("scripts/*.test.mjs", { cwd: workspaceRoot });

const runLegacyRootTests = async (runTestCommand, workspaceRoot) => {
  const testFiles = legacyRootTestFiles(workspaceRoot);
  if (testFiles.length === 0) return { failed: false, stdout: "# tests 0\n" };
  const result = await runTestCommand(
    process.execPath,
    ["--test", "--test-reporter=tap", ...testFiles],
    workspaceRoot,
  );
  if (nodeTestCountPattern.test(result.stdout)) return result;
  throw new Error("Node test run did not complete");
};

const vitestTestCount = (output) => {
  const counts = [...output.matchAll(vitestCountPattern)];
  if (counts.length === 0) throw new Error("Vitest reported no test counts");
  return counts.reduce((total, [, count]) => total + Number(count), 0);
};

const withReporters = (args, reporterPath) => {
  if (!reporterPath) return args;
  return [...args, "--", "--reporter=default", `--reporter=${reporterPath}`];
};

const turboTestArgs = (turboPath) => [turboPath, "test", "--continue=always", "--output-logs=full"];

export const vitestTestArgs = (turboPath, reporterPath) =>
  withReporters(turboTestArgs(turboPath), reporterPath);

export const configurationComparisonVitestTestArgs = (turboPath, reporterPath) =>
  withReporters([...turboTestArgs(turboPath), "--cache=local:,remote:", "--env-mode=loose"], reporterPath);

const legacyReporterPath = (workspaceRoot) => {
  const configuredReporter = join(workspaceRoot, "configs", "test", "test-count-reporter.ts");
  if (existsSync(configuredReporter)) return undefined;
  return pathToFileURL(join(import.meta.dirname, "legacy-test-count-reporter.ts")).href;
};

const runTests = async (runTestCommand, workspaceRoot, testArgsFor = vitestTestArgs) => {
  const turboPath = fileURLToPath(import.meta.resolve("turbo/bin/turbo"));
  const vitest = requireCompletedTestRun(
    await runTestCommand(
      process.execPath,
      testArgsFor(turboPath, legacyReporterPath(workspaceRoot)),
      workspaceRoot,
    ),
  );
  const legacy = await runLegacyRootTests(runTestCommand, workspaceRoot);
  return { legacy, vitest };
};

const buildMeasurement = (startedAt, { legacy, vitest }) => ({
  durationMs: Math.round(performance.now() - startedAt),
  testCount: vitestTestCount(vitest.stdout) + nodeTestCount(legacy.stdout),
});

const publishMeasurement = (measurement) => {
  console.log(JSON.stringify(measurement));
  return measurement;
};

export const measureComparison = async (
  runTestCommand = run,
  workspaceRoot = defaultWorkspaceRoot,
  testArgsFor = vitestTestArgs,
) => {
  const startedAt = performance.now();
  const result = await runTests(runTestCommand, workspaceRoot, testArgsFor);
  return publishMeasurement(buildMeasurement(startedAt, result));
};

export const measure = async (runTestCommand = run, workspaceRoot = defaultWorkspaceRoot) => {
  const startedAt = performance.now();
  const results = await runTests(runTestCommand, workspaceRoot);
  const tsxPath = fileURLToPath(import.meta.resolve("tsx/cli"));
  const gitMeasurement = await runTestCommand(
    process.execPath,
    [tsxPath, "configs/sensor/count-worktree-git-invocations.ts"],
    workspaceRoot,
  );
  requireSuccess(gitMeasurement, "Git measurement");
  const measurement = publishMeasurement(buildMeasurement(startedAt, results));
  if (results.vitest.failed || results.legacy.failed) process.exitCode = 1;
  return measurement;
};

const main = async () => {
  const [mode] = process.argv.slice(2);
  if (mode === "--comparison") return measureComparison(run, process.cwd());
  if (mode === "--configuration-comparison") {
    return measureComparison(run, process.cwd(), configurationComparisonVitestTestArgs);
  }
  if (!mode) return measure(run, process.cwd());
  throw new Error("Usage: test-measure.mjs [--comparison|--configuration-comparison]");
};

if (isMain) {
  main().catch((error) => {
    console.error(describe(error));
    process.exitCode = 1;
  });
}
