import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
);

test("reports Node test count and file timing for CI measurement", () => {
  const reporter = path.join(import.meta.dirname, "test-count-reporter.mjs");
  const fixture = path.join(import.meta.dirname, "fixtures", "test-count-reporter.mjs");
  const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, fixture], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: environment,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cogwork-test-count:2\n/);
  const timing = result.stdout.match(/cogwork-test-timing:(\{.*\})\n/)?.[1];
  assert.ok(timing);
  const report = JSON.parse(timing);
  assert.equal(report.packagePath, path.resolve(import.meta.dirname, ".."));
  assert.equal(report.testCount, 2);
  assert.ok(report.durationMs > 0);
  assert.equal(report.testFiles.length, 1);
  assert.equal(report.testFiles[0].path, "tests/fixtures/test-count-reporter.mjs");
  assert.equal(report.testFiles[0].testCount, 2);
  assert.ok(report.testFiles[0].durationMs > 0);
});
