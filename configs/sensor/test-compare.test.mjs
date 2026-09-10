import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
  analyzeDurations,
  buildReport,
  collectMeasurements,
  measurementOrder,
  parseComparisonArgs,
  withCleanups,
} from "./test-compare.mjs";

const measurements = (durationMs) => Array.from({ length: 5 }, () => ({ durationMs, testCount: 1_800 }));

describe("test comparison statistics", () => {
  it("classifies slower, faster, and indistinguishable measurements", () => {
    assert.equal(analyzeDurations([100, 100, 100, 100, 100], [120, 120, 120, 120, 120]).verdict, "slower");
    assert.equal(analyzeDurations([100, 100, 100, 100, 100], [80, 80, 80, 80, 80]).verdict, "faster");
    assert.equal(analyzeDurations([100, 101, 99, 102, 98], [100, 101, 99, 102, 98]).verdict, "inconclusive");
  });

  it("preserves the operation error while attempting every cleanup", async () => {
    const calls = [];
    const operationError = new Error("measurement failed");
    const result = await withCleanups(async () => {
      throw operationError;
    }, [
      async () => {
        calls.push("worktrees");
        throw new Error("worktree cleanup failed");
      },
      async () => {
        calls.push("directory");
        throw new Error("directory cleanup failed");
      },
    ]).catch((error) => error);

    assert.equal(result, operationError);
    assert.deepEqual(calls, ["worktrees", "directory"]);
  });

  it("keeps a completed comparison when cleanup fails", async () => {
    const report = { verdict: "inconclusive" };
    const writes = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const result = await withCleanups(
      async () => report,
      [
        async () => {
          throw new Error("worktree cleanup failed");
        },
      ],
    );

    assert.equal(result, report);
    assert.equal(writes.join(""), "Cleanup failed: worktree cleanup failed\n");
  });

  it("classifies a narrow interval beyond parity", () => {
    const base = [100, 100, 100, 100, 100];
    assert.equal(analyzeDurations(base, [99, 99, 99, 99, 99]).verdict, "faster");
    assert.equal(analyzeDurations(base, [101, 101, 101, 101, 101]).verdict, "slower");
  });

  it("uses the seeded Effect bootstrap result", () => {
    assert.deepEqual(analyzeDurations([100, 105, 98, 111, 103], [110, 100, 109, 115, 106]), {
      verdict: "inconclusive",
      baseMedianMs: 103,
      headMedianMs: 109,
      ratio: 1.0360360360360361,
      confidenceInterval: {
        lowRatio: 0.9523809523809523,
        highRatio: 1.1122448979591837,
        confidence: 0.95,
      },
      rounds: 5,
      seed: 0x5eed1234,
    });
  });

  it("rejects measurements it cannot compare", () => {
    assert.throws(() => analyzeDurations([], []), /non-empty/);
    assert.throws(() => analyzeDurations([100], [0]), /finite positive/);
    assert.throws(() => analyzeDurations([100], [100, 101]), /same number/);
  });

  it("keeps identical refs inconclusive despite measurement noise", () => {
    const result = buildReport(
      { ref: "HEAD", sha: "same-sha", environment: { TURBO_CONCURRENCY: "1" } },
      { ref: "HEAD", sha: "same-sha", environment: { TURBO_CONCURRENCY: "1" } },
      { base: measurements(100), head: measurements(120) },
    );

    assert.equal(result.verdict, "inconclusive");
  });

  it("classifies different environments on the same commit", () => {
    const result = buildReport(
      { ref: "HEAD", sha: "same-sha", environment: { TURBO_CONCURRENCY: "1" } },
      { ref: "HEAD", sha: "same-sha", environment: { TURBO_CONCURRENCY: "2" } },
      { base: measurements(100), head: measurements(120) },
    );

    assert.equal(result.verdict, "slower");
  });

  it("alternates the first ref in each paired round", () => {
    assert.deepEqual(measurementOrder(5), [
      "base",
      "head",
      "head",
      "base",
      "base",
      "head",
      "head",
      "base",
      "base",
      "head",
    ]);
  });

  it("parses a commit and environment for each side", () => {
    assert.deepEqual(
      parseComparisonArgs([
        "main",
        "HEAD",
        "--base-env",
        "TURBO_CONCURRENCY=1",
        "--head-env",
        "TURBO_CONCURRENCY=2",
        "--head-env",
        "VITEST_MAX_WORKERS=1",
      ]),
      {
        base: { ref: "main", environment: { TURBO_CONCURRENCY: "1" } },
        head: {
          ref: "HEAD",
          environment: { TURBO_CONCURRENCY: "2", VITEST_MAX_WORKERS: "1" },
        },
      },
    );
  });

  it("rejects an environment assignment without a value separator", () => {
    assert.throws(() => parseComparisonArgs(["main", "HEAD", "--head-env", "TURBO_CONCURRENCY"]), /Usage:/);
  });

  it("uses only the selected side environment for each measurement", async () => {
    const calls = [];
    const sides = {
      base: { worktree: "/base", environment: { BASE_ONLY: "base" } },
      head: { worktree: "/head", environment: { HEAD_ONLY: "head" } },
    };
    const measure = async (worktree, environment, mode) => {
      calls.push({ worktree, environment, mode });
      return { durationMs: 100, testCount: 1_800 };
    };
    const expectedEnvironment = {
      base: { BASE_ONLY: "base", SHARED: "shared" },
      head: { HEAD_ONLY: "head", SHARED: "shared" },
    };

    await collectMeasurements(sides, measure, {
      BASE_ONLY: "ambient-base",
      HEAD_ONLY: "ambient-head",
      SHARED: "shared",
    });

    assert.deepEqual(
      calls,
      measurementOrder(5).map((side) => ({
        worktree: `/${side}`,
        environment: expectedEnvironment[side],
        mode: "--configuration-comparison",
      })),
    );
  });

  it("preserves commit comparison measurement mode when neither side configures environment", async () => {
    const modes = [];
    const measure = async (_worktree, _environment, mode) => {
      modes.push(mode);
      return { durationMs: 100, testCount: 1_800 };
    };

    await collectMeasurements(
      {
        base: { worktree: "/base", environment: {} },
        head: { worktree: "/head", environment: {} },
      },
      measure,
      {},
    );

    assert.deepEqual(
      modes,
      Array.from({ length: 10 }, () => "--comparison"),
    );
  });

  it("builds the machine-readable comparison report", () => {
    const report = buildReport(
      { ref: "main", sha: "base-sha", environment: {} },
      { ref: "HEAD", sha: "head-sha", environment: {} },
      { base: measurements(100), head: measurements(120) },
    );

    assert.deepEqual(report, {
      schemaVersion: 1,
      verdict: "slower",
      base: {
        ref: "main",
        sha: "base-sha",
        environment: {},
        medianDurationMs: 100,
        testCount: 1_800,
      },
      head: {
        ref: "HEAD",
        sha: "head-sha",
        environment: {},
        medianDurationMs: 120,
        testCount: 1_800,
      },
      ratio: 1.2,
      confidenceInterval: { lowRatio: 1.2, highRatio: 1.2, confidence: 0.95 },
      rounds: 5,
      seed: 0x5eed1234,
    });
  });
});
