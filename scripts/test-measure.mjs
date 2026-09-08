#!/usr/bin/env node
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const countMarker = "cogwork-test-count:";
const exec = promisify(execFile);
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

export const run = async (file, args) => {
  try {
    const result = await exec(file, args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { failed: false, ...result };
  } catch (error) {
    const stdout = error?.stdout ?? "";
    process.stderr.write(stdout);
    process.stderr.write(error?.stderr ?? "");
    return { failed: true, stdout };
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

const measure = async () => {
  const startedAt = performance.now();
  const reporterPath = pathToFileURL(scriptPath).href;
  const turboPath = fileURLToPath(import.meta.resolve("turbo/bin/turbo"));
  const vitest = await run(process.execPath, [
    turboPath,
    "test",
    "--force",
    "--output-logs=full",
    "--",
    "--reporter=default",
    `--reporter=${reporterPath}`,
  ]);
  const nodeTests = await run(process.execPath, [
    "--test",
    "--test-reporter=tap",
    "configs/lint/tests/rules.test.mjs",
    "scripts/test-measure.test.mjs",
  ]);
  const durationMs = Math.round(performance.now() - startedAt);
  const testCount = vitestCount(vitest.stdout) + nodeTestCount(nodeTests.stdout);
  console.log(JSON.stringify({ durationMs, testCount }));

  if (vitest.failed || nodeTests.failed) process.exitCode = 1;
};

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  measure().catch((error) => {
    console.error(describe(error));
    process.exitCode = 1;
  });
}
