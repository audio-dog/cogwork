import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeDurations, buildReport, measurementOrder, withCleanups } from "./test-compare.mjs";

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
      { ref: "HEAD", sha: "same-sha" },
      { ref: "HEAD", sha: "same-sha" },
      { base: measurements(100), head: measurements(120) },
    );

    assert.equal(result.verdict, "inconclusive");
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

  it("builds the machine-readable comparison report", () => {
    const report = buildReport(
      { ref: "main", sha: "base-sha" },
      { ref: "HEAD", sha: "head-sha" },
      { base: measurements(100), head: measurements(120) },
    );

    assert.deepEqual(report, {
      schemaVersion: 1,
      verdict: "slower",
      base: { ref: "main", sha: "base-sha", medianDurationMs: 100, testCount: 1_800 },
      head: { ref: "HEAD", sha: "head-sha", medianDurationMs: 120, testCount: 1_800 },
      ratio: 1.2,
      confidenceInterval: { lowRatio: 1.2, highRatio: 1.2, confidence: 0.95 },
      rounds: 5,
      seed: 0x5eed1234,
    });
  });
});
