#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const countMarker = "cogwork-test-count:";
const measuredTestStates = ["passed", "failed"];
const scriptPath = fileURLToPath(import.meta.url);
const vitestCountPattern = new RegExp(`${countMarker}(\\d+)`, "g");
const nodeTestCountPattern = /^# tests (\d+)$/m;
const workspaceRoot = dirname(dirname(scriptPath));
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

export const run = (file, args) =>
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

export const measure = async (runTestCommand = run) => {
  const startedAt = performance.now();
  const reporterPath = pathToFileURL(scriptPath).href;
  const turboPath = fileURLToPath(import.meta.resolve("turbo/bin/turbo"));
  const tsxPath = fileURLToPath(import.meta.resolve("tsx/cli"));
  const vitest = await runTestCommand(process.execPath, [
    turboPath,
    "test",
    "--force",
    "--output-logs=full",
    "--",
    "--reporter=default",
    `--reporter=${reporterPath}`,
  ]);
  const nodeTests = await runTestCommand(process.execPath, [
    "--test",
    "--test-reporter=tap",
    "scripts/test-measure.test.mjs",
  ]);
  const gitMeasurement = await runTestCommand(process.execPath, [
    tsxPath,
    "scripts/count-worktree-git-invocations.ts",
  ]);
  const durationMs = Math.round(performance.now() - startedAt);
  const testCount = vitestCount(vitest.stdout) + nodeTestCount(nodeTests.stdout);
  console.log(JSON.stringify({ durationMs, testCount }));

  if ([vitest, nodeTests, gitMeasurement].some(({ failed }) => failed)) process.exitCode = 1;
};

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  measure().catch((error) => {
    console.error(describe(error));
    process.exitCode = 1;
  });
}
