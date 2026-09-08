#!/usr/bin/env node
import { execFile } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const countMarker = "cogwork-test-count:";
const exec = promisify(execFile);
const measuredTestStates = ["passed", "failed"];
const scriptPath = fileURLToPath(import.meta.url);
const vitestCountPattern = new RegExp(`${countMarker}(\\d+)`, "g");
const nodeTestCountPattern = /^# tests (\d+)$/m;
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
const nodeTestPatterns = ["configs/lint/tests/*.test.mjs", "scripts/*.test.mjs"];
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

const run = async (file, args, workspaceRoot) => {
  try {
    return await exec(file, args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(error?.stdout ?? "");
    process.stderr.write(error?.stderr ?? "");
    throw error;
  }
};

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

const runNodeTests = (workspaceRoot) => {
  const testFiles = nodeTestPatterns.flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }));
  return run(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], workspaceRoot);
};

const measure = async (workspaceRoot) => {
  const startedAt = performance.now();
  const reporterPath = pathToFileURL(scriptPath).href;
  const turboPath = fileURLToPath(import.meta.resolve("turbo/bin/turbo"));
  const vitest = await run(
    process.execPath,
    [
      turboPath,
      "test",
      "--force",
      "--output-logs=full",
      "--",
      "--reporter=default",
      `--reporter=${reporterPath}`,
    ],
    workspaceRoot,
  );
  const nodeTests = await runNodeTests(workspaceRoot);
  const durationMs = Math.round(performance.now() - startedAt);
  const testCount = vitestCount(vitest.stdout) + nodeTestCount(nodeTests.stdout);
  console.log(JSON.stringify({ durationMs, testCount }));
};

const main = async () => {
  const [mode] = process.argv.slice(2);
  if (mode === "--node-only") {
    const result = await runNodeTests(process.cwd());
    process.stdout.write(result.stdout);
    return;
  }
  if (!mode) return measure(process.cwd());
  throw new Error("Usage: test-measure.mjs [--node-only]");
};

if (isMain) {
  main().catch((error) => {
    console.error(describe(error));
    process.exitCode = 1;
  });
}
