import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");

const summarize = (report, directory) => {
  const measurementPath = path.join(directory, "measurement.json");
  writeFileSync(measurementPath, JSON.stringify(report));
  return spawnSync(process.execPath, ["configs/sensor/test-measure-summary.mjs", measurementPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
};

test("the summary ranks package and file timings", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-measure-summary-"));
  try {
    const result = summarize(
      {
        durationMs: 17_042,
        testCount: 1_234,
        packages: [
          { path: "packages/slow", durationMs: 310, testCount: 3 },
          { path: "packages/fast", durationMs: 40, testCount: 2 },
        ],
        testFiles: [
          { path: "packages/slow/src/slow.test.ts", durationMs: 200, testCount: 2 },
          { path: "packages/fast/src/fast.test.ts", durationMs: 40, testCount: 2 },
        ],
      },
      directory,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "## Test suite timing",
        "",
        "| Duration | Test count |",
        "| ---: | ---: |",
        "| 17.042 s | 1,234 |",
        "",
        "### Packages",
        "",
        "| Duration | Tests | Package |",
        "| ---: | ---: | --- |",
        "| 0.310 s | 3 | `packages/slow` |",
        "| 0.040 s | 2 | `packages/fast` |",
        "",
        "### Test files",
        "",
        "| Duration | Tests | Test file |",
        "| ---: | ---: | --- |",
        "| 0.200 s | 2 | `packages/slow/src/slow.test.ts` |",
        "| 0.040 s | 2 | `packages/fast/src/fast.test.ts` |",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("the summary renders both sides of a comparison", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-comparison-summary-"));
  const timing = {
    testCount: 3,
    packages: [{ path: "packages/engine", durationMs: 310, testCount: 3 }],
    testFiles: [{ path: "packages/engine/src/slow.test.ts", durationMs: 200, testCount: 2 }],
  };
  try {
    const result = summarize(
      {
        schemaVersion: 1,
        base: { ref: "main", sha: "base-sha", medianDurationMs: 1_000, ...timing },
        head: { ref: "HEAD", sha: "head-sha", medianDurationMs: 1_200, ...timing },
      },
      directory,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^## Test suite comparison timing/m);
    assert.match(result.stdout, /### Base: `main` \(`base-sha`\)/);
    assert.match(result.stdout, /### Head: `HEAD` \(`head-sha`\)/);
    assert.equal(result.stdout.match(/`packages\/engine\/src\/slow\.test\.ts`/g)?.length, 2);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("the summary keeps paths inside their table cell", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-path-summary-"));
  try {
    const result = summarize(
      {
        durationMs: 1_000,
        testCount: 1,
        packages: [{ path: "packages/`evil|\n### forged", durationMs: 310, testCount: 1 }],
        testFiles: [],
      },
      directory,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\n### forged/);
    assert.match(result.stdout, /``packages\/`evil\\\| ### forged``/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
