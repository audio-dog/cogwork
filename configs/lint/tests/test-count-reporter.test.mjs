import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
);

test("reports the Node test count for CI measurement", () => {
  const reporter = path.join(import.meta.dirname, "test-count-reporter.mjs");
  const fixture = path.join(import.meta.dirname, "fixtures", "test-count-reporter.mjs");
  const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, fixture], {
    encoding: "utf8",
    env: environment,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cogwork-test-count:2\n/);
});
