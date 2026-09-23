#!/usr/bin/env node
import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testCountMarker, testTimingMarker } from "../test/test-count-reporter.ts";

const vitestCountPattern = new RegExp(`${testCountMarker}(\\d+)`, "g");
const vitestTimingPattern = new RegExp(`${testTimingMarker}(\\{[^\\r\\n]*\\})`, "g");
const turboTaskCountPattern = /Tasks:\s+\d+ successful, (\d+) total/g;
const defaultWorkspaceRoot = resolve(import.meta.dirname, "../..");
const measurementReporterPath = pathToFileURL(
  join(import.meta.dirname, "legacy-test-count-reporter.ts"),
).href;
const nodeMeasurementReporterPath = join(import.meta.dirname, "../lint/tests/test-count-reporter.mjs");
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
  const taskCount = [...output.matchAll(turboTaskCountPattern)].at(-1)?.[1];
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

const legacyRootTestFiles = (workspaceRoot) => globSync("scripts/*.test.mjs", { cwd: workspaceRoot });

const runLegacyRootTests = async (runTestCommand, workspaceRoot) => {
  const testFiles = legacyRootTestFiles(workspaceRoot);
  if (testFiles.length === 0) return { failed: false, stdout: `${testCountMarker}0\n` };
  const result = await runTestCommand(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      `--test-reporter=${nodeMeasurementReporterPath}`,
      "--test-reporter-destination=stdout",
      "--test-reporter-destination=stdout",
      ...testFiles,
    ],
    workspaceRoot,
  );
  const countReportCount = [...result.stdout.matchAll(vitestCountPattern)].length;
  const timingReportCount = [...result.stdout.matchAll(vitestTimingPattern)].length;
  const completedRootRun = countReportCount === 1 && timingReportCount === 1;
  if (completedRootRun) return result;
  throw new Error("Node test run did not complete");
};

const reportedTestCount = (output) => {
  const counts = [...output.matchAll(vitestCountPattern)];
  if (counts.length === 0) throw new Error("Test run reported no test counts");
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

const runTests = async (runTestCommand, workspaceRoot, testArgsFor = vitestTestArgs) => {
  const turboPath = fileURLToPath(import.meta.resolve("turbo/bin/turbo"));
  const startedAt = performance.now();
  const vitest = requireCompletedTestRun(
    await runTestCommand(process.execPath, testArgsFor(turboPath, measurementReporterPath), workspaceRoot),
  );
  const durationMs = Math.round(performance.now() - startedAt);
  const countReportCount = [...vitest.stdout.matchAll(vitestCountPattern)].length;
  const timingReportCount = [...vitest.stdout.matchAll(vitestTimingPattern)].length;
  const missingTimingReport = timingReportCount < countReportCount;
  const supplementalTiming = missingTimingReport ? await runLintTiming(runTestCommand, workspaceRoot) : "";
  const legacy = await runLegacyRootTests(runTestCommand, workspaceRoot);
  return {
    durationMs,
    legacy,
    vitest: {
      failed: vitest.failed,
      stdout: `${vitest.stdout}\n${supplementalTiming}`,
    },
  };
};

const runLintTiming = async (runTestCommand, workspaceRoot) => {
  const lintRoot = join(workspaceRoot, "configs/lint");
  const lintFiles = globSync("tests/*.test.mjs", { cwd: lintRoot });
  const result = await runTestCommand(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      `--test-reporter=${nodeMeasurementReporterPath}`,
      "--test-reporter-destination=stdout",
      "--test-reporter-destination=stdout",
      ...lintFiles,
    ],
    lintRoot,
  );
  const countReportCount = [...result.stdout.matchAll(vitestCountPattern)].length;
  const timingReports = [...result.stdout.matchAll(vitestTimingPattern)];
  const completedLintRun = countReportCount === 1 && timingReports.length === 1;
  if (!completedLintRun) throw new Error("Node package test run did not complete");
  return timingReports[0][0];
};

const slowestFirst = (left, right) =>
  right.durationMs - left.durationMs || left.path.localeCompare(right.path);

const parseTimingReport = (serialized) => {
  const report = JSON.parse(serialized);
  const validTestFiles =
    Array.isArray(report?.testFiles) &&
    report.testFiles.every(
      (testFile) =>
        typeof testFile?.path === "string" &&
        Number.isFinite(testFile.durationMs) &&
        testFile.durationMs >= 0 &&
        Number.isInteger(testFile.testCount) &&
        testFile.testCount >= 0,
    );
  const validReport =
    typeof report?.packagePath === "string" &&
    Number.isFinite(report.durationMs) &&
    report.durationMs >= 0 &&
    Number.isInteger(report.testCount) &&
    report.testCount >= 0 &&
    validTestFiles;
  if (!validReport) throw new Error("Vitest reported invalid test timings");
  return report;
};

const workspacePath = (workspaceRoot, absolutePath) => {
  const path = relative(workspaceRoot, absolutePath);
  const outsideWorkspace = path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  if (outsideWorkspace) throw new Error("Vitest reported timings outside the workspace");
  return path || ".";
};

const vitestTimings = (output, workspaceRoot) => {
  const packageReports = [...output.matchAll(vitestTimingPattern)].map(([, report]) =>
    parseTimingReport(report),
  );
  const expectedReportCount = [...output.matchAll(vitestCountPattern)].length;
  if (packageReports.length !== expectedReportCount) {
    throw new Error("Package tests reported incomplete test timings");
  }
  const packages = packageReports.map((report) => ({
    path: workspacePath(workspaceRoot, report.packagePath),
    durationMs: report.durationMs,
    testCount: report.testCount,
  }));
  const testFiles = packageReports.flatMap((report) => {
    const packagePath = workspacePath(workspaceRoot, report.packagePath);
    return report.testFiles.map((testFile) => ({
      ...testFile,
      path: join(packagePath, testFile.path),
    }));
  });
  return {
    packages: packages.toSorted(slowestFirst),
    testFiles: testFiles.toSorted(slowestFirst),
  };
};

const buildMeasurement = ({ durationMs, legacy, vitest }, workspaceRoot) => {
  const vitestCount = reportedTestCount(vitest.stdout);
  const legacyCount = reportedTestCount(legacy.stdout);
  const vitestTiming = vitestTimings(vitest.stdout, workspaceRoot);
  const legacyTiming =
    legacyCount === 0 ? { packages: [], testFiles: [] } : vitestTimings(legacy.stdout, workspaceRoot);
  const timings = {
    packages: [...vitestTiming.packages, ...legacyTiming.packages].toSorted(slowestFirst),
    testFiles: [...vitestTiming.testFiles, ...legacyTiming.testFiles].toSorted(slowestFirst),
  };
  const reportedCount = timings.packages.reduce((total, report) => total + report.testCount, 0);
  const testCount = vitestCount + legacyCount;
  if (reportedCount !== testCount) {
    throw new Error("Test timing count disagrees with the test count");
  }
  return {
    durationMs: durationMs + legacyTiming.packages.reduce((total, report) => total + report.durationMs, 0),
    testCount,
    ...timings,
  };
};

const publishMeasurement = (measurement) => {
  console.log(JSON.stringify(measurement));
  return measurement;
};

export const measureComparison = async (
  runTestCommand = run,
  workspaceRoot = defaultWorkspaceRoot,
  testArgsFor = vitestTestArgs,
) => {
  const result = await runTests(runTestCommand, workspaceRoot, testArgsFor);
  return publishMeasurement(buildMeasurement(result, workspaceRoot));
};

export const measure = async (runTestCommand = run, workspaceRoot = defaultWorkspaceRoot) => {
  const results = await runTests(runTestCommand, workspaceRoot);
  const tsxPath = fileURLToPath(import.meta.resolve("tsx/cli"));
  const gitMeasurement = await runTestCommand(
    process.execPath,
    [tsxPath, "configs/sensor/count-worktree-git-invocations.ts"],
    workspaceRoot,
  );
  requireSuccess(gitMeasurement, "Git measurement");
  const measurement = publishMeasurement(buildMeasurement(results, workspaceRoot));
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
