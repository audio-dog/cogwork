#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const defaultConfidence = 0.95;
const defaultIterations = 10_000;
const defaultSeed = 0x5eed1234;
const commandTimeoutMs = 15 * 60 * 1_000;
const exec = promisify(execFile);
const rounds = 5;
const scriptPath = fileURLToPath(import.meta.url);
const usage = "Usage: pnpm test:compare <base-ref> <head-ref>\n";
const workspaceRoot = dirname(dirname(scriptPath));
const measurementScriptPath = join(workspaceRoot, "scripts", "test-measure.mjs");

const assertPositiveNumbers = (values, label) => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${label} must contain finite positive numbers`);
  }
};

const median = (values) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
};

const percentile = (values, probability) => {
  const sorted = values.toSorted((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const randomAt = (seed, index) => {
  const state = (seed + Math.imul(index + 1, 0x6d2b79f5)) >>> 0;
  const mixed = Math.imul(state ^ (state >>> 15), state | 1);
  const remixed = mixed ^ (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61));
  return ((remixed ^ (remixed >>> 14)) >>> 0) / 4_294_967_296;
};

const bootstrapMedianLogRatio = (ratios) => {
  const logRatios = ratios.map(Math.log);
  const samples = Array.from({ length: defaultIterations }, (_, iteration) =>
    median(
      Array.from(
        { length: logRatios.length },
        (_, sample) =>
          logRatios[
            Math.floor(randomAt(defaultSeed, iteration * logRatios.length + sample) * logRatios.length)
          ],
      ),
    ),
  );
  const tail = (1 - defaultConfidence) / 2;
  return {
    ratio: Math.exp(median(logRatios)),
    lowRatio: Math.exp(percentile(samples, tail)),
    highRatio: Math.exp(percentile(samples, 1 - tail)),
  };
};

const verdictFrom = ({ highRatio, lowRatio }) => {
  if (highRatio < 1) return "faster";
  if (lowRatio > 1) return "slower";
  return "inconclusive";
};

export const analyzeDurations = (baseDurationsMs, headDurationsMs) => {
  assertPositiveNumbers(baseDurationsMs, "base durations");
  assertPositiveNumbers(headDurationsMs, "head durations");
  if (baseDurationsMs.length !== headDurationsMs.length) {
    throw new Error("base and head durations must contain the same number of observations");
  }

  const ratios = baseDurationsMs.map((duration, index) => headDurationsMs[index] / duration);
  const interval = bootstrapMedianLogRatio(ratios);
  return {
    verdict: verdictFrom(interval),
    baseMedianMs: median(baseDurationsMs),
    headMedianMs: median(headDurationsMs),
    ratio: interval.ratio,
    confidenceInterval: {
      lowRatio: interval.lowRatio,
      highRatio: interval.highRatio,
      confidence: defaultConfidence,
    },
    rounds: baseDurationsMs.length,
    seed: defaultSeed,
  };
};

export const measurementOrder = (rounds) => {
  if (!Number.isInteger(rounds) || rounds <= 0) throw new Error("rounds must be a positive integer");
  return Array.from({ length: rounds }, (_, round) =>
    round % 2 === 0 ? ["base", "head"] : ["head", "base"],
  ).flat();
};

const summarizeMeasurements = (measurements, label) => {
  const durationsMs = measurements.map(({ durationMs }) => durationMs);
  assertPositiveNumbers(durationsMs, `${label} durations`);
  const testCounts = new Set(measurements.map(({ testCount }) => testCount));
  const [testCount] = testCounts;
  if (testCounts.size !== 1 || !Number.isInteger(testCount) || testCount <= 0) {
    throw new Error(`${label} measurements must contain one stable positive test count`);
  }
  return { durationsMs, testCount };
};

export const buildReport = (baseRef, headRef, measurements) => {
  const base = summarizeMeasurements(measurements.base, "base");
  const head = summarizeMeasurements(measurements.head, "head");
  const comparison = analyzeDurations(base.durationsMs, head.durationsMs);
  const verdict = baseRef.sha === headRef.sha ? "inconclusive" : comparison.verdict;
  return {
    schemaVersion: 1,
    verdict,
    base: {
      ...baseRef,
      medianDurationMs: comparison.baseMedianMs,
      testCount: base.testCount,
    },
    head: {
      ...headRef,
      medianDurationMs: comparison.headMedianMs,
      testCount: head.testCount,
    },
    ratio: comparison.ratio,
    confidenceInterval: comparison.confidenceInterval,
    rounds: comparison.rounds,
    seed: comparison.seed,
  };
};

const describe = (error) => (error instanceof Error ? error.message : String(error));

const run = async (file, args, cwd) => {
  try {
    return await exec(file, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: commandTimeoutMs,
    });
  } catch (error) {
    process.stderr.write(error?.stdout ?? "");
    process.stderr.write(error?.stderr ?? "");
    throw error;
  }
};

const runGit = async (args) => (await run("git", args, workspaceRoot)).stdout.trim();

const resolveRef = async (ref) => ({
  ref,
  sha: await runGit(["rev-parse", "--verify", `${ref}^{commit}`]),
});

const addWorktree = async (root, side, sha) => {
  const path = join(root, side);
  await runGit(["worktree", "add", "--detach", path, sha]);
  return path;
};

const installWorktree = async (path) => {
  process.stderr.write(`Preparing ${path}\n`);
  await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"], path);
};

const removeWorktree = async (path) => runGit(["worktree", "remove", "--force", path]);

const removeWorktrees = async (paths) => {
  const results = [];
  for (const path of paths.toReversed()) {
    results.push(
      await removeWorktree(path).then(
        () => undefined,
        (error) => error,
      ),
    );
  }
  const failure = results.find((result) => result !== undefined);
  if (failure) throw failure;
};

const parseMeasurement = (stdout) => {
  const measurement = JSON.parse(stdout.trim());
  if (
    typeof measurement !== "object" ||
    measurement === null ||
    !Number.isFinite(measurement.durationMs) ||
    measurement.durationMs <= 0 ||
    !Number.isInteger(measurement.testCount) ||
    measurement.testCount <= 0
  ) {
    throw new Error("test:measure returned an invalid measurement");
  }
  return measurement;
};

const collectMeasurements = async (worktrees) => {
  const measurements = { base: [], head: [] };
  const order = measurementOrder(rounds);
  for (const [index, side] of order.entries()) {
    process.stderr.write(`Measuring ${side}, run ${index + 1}/${order.length}\n`);
    const result = await run(process.execPath, [measurementScriptPath], worktrees[side]);
    measurements[side].push(parseMeasurement(result.stdout));
  }
  return measurements;
};

const compareRefs = async (baseName, headName) => {
  const [baseRef, headRef] = await Promise.all([resolveRef(baseName), resolveRef(headName)]);
  const root = await mkdtemp(join(tmpdir(), "cogwork-test-compare-"));
  const worktrees = [];
  try {
    const base = await addWorktree(root, "base", baseRef.sha);
    worktrees.push(base);
    await installWorktree(base);
    const head = await addWorktree(root, "head", headRef.sha);
    worktrees.push(head);
    await installWorktree(head);
    const measurements = await collectMeasurements({ base, head });
    return buildReport(baseRef, headRef, measurements);
  } finally {
    await removeWorktrees(worktrees);
    await rm(root, { recursive: true, force: true });
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(usage);
    return;
  }
  if (args.length !== 2) throw new Error(usage.trim());
  const report = await compareRefs(args[0], args[1]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
};

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(describe(error));
    process.exitCode = 1;
  });
}
