import { WorkItemId } from "@cogwork/contracts";
import { GitHub, PerformanceIssueFiler as PerformanceIssueFilerModule } from "@cogwork/engine";
import { wireCodec } from "@cogwork/engine/github/markers";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { fileSuiteComparison, fileTestFileBudget, fileTestSuiteBudget } from "./test-performance-filer.ts";

const atMillis = Date.UTC(2026, 8, 9, 12);
const repository = "colonylabs/cogwork";
const repositoryRef = GitHub.repoRefFromRepository(repository);
if (!repositoryRef) throw new Error("invalid test repository");
const workflowRunUrl = "https://github.com/colonylabs/cogwork/actions/runs/123";
const report = (verdict: "slower" | "faster" | "inconclusive" = "slower", ratio = 1.2) => ({
  schemaVersion: 1,
  verdict,
  base: {
    ref: "baseline",
    sha: "1111111111111111111111111111111111111111",
    environment: {},
    medianDurationMs: 100,
    testCount: 1_800,
  },
  head: {
    ref: "main",
    sha: "2222222222222222222222222222222222222222",
    environment: {},
    medianDurationMs: 120,
    testCount: 1_800,
  },
  ratio,
  confidenceInterval: { lowRatio: 1.1, highRatio: 1.3, confidence: 0.95 },
  rounds: 5,
  seed: 0x5eed1234,
});

const seedRun = (run: number, durationMs: number, testCount = 2_000) => ({
  durationMs,
  testCount,
  sha: `${run % 10}`.repeat(40),
  startedAt: `2026-09-${String(run).padStart(2, "0")}T12:00:00Z`,
  workflowRunUrl: `https://github.com/colonylabs/cogwork/actions/runs/${run}`,
});

const budgetHistory = (durationMs: number) =>
  Array.from({ length: 20 }, (_, index) => seedRun(index + 1, durationMs));

const timingReport = (
  slowestDurationMs: number,
  slowestPath = "packages/engine/src/harness-host.test.ts",
  slowestTestCount = 12,
) => {
  const fast = { path: "packages/engine/src/skipped-fast.test.ts", durationMs: 0, testCount: 0 };
  const slowest = { path: slowestPath, durationMs: slowestDurationMs, testCount: slowestTestCount };
  return {
    testFiles: [fast, slowest],
  } satisfies { readonly testFiles: readonly [typeof fast, ...Array<typeof fast>] };
};

interface Recorded {
  readonly created: ReadonlyArray<PerformanceIssueFilerModule.PerformanceIssueCreateInput>;
  readonly comments: ReadonlyArray<string>;
}

class FilerCalls extends Context.Service<FilerCalls, Ref.Ref<Recorded>>()(
  "@cogwork/sensor/test-performance-filer.test/FilerCalls",
) {
  static readonly layer = Layer.effect(FilerCalls, Ref.make<Recorded>({ created: [], comments: [] }));
}

const decodeWorkItemId = Schema.decodeSync(WorkItemId);
const decodeFingerprint = Schema.decodeSync(PerformanceIssueFilerModule.PerformanceIssueFingerprint);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const suiteFingerprint = decodeFingerprint("repository.test-suite-duration.slower");

const existingIssue = {
  id: decodeWorkItemId("#42"),
  url: "https://github.com/colonylabs/cogwork/issues/42",
  state: "open",
  fingerprint: suiteFingerprint,
  createdAtMillis: atMillis - 1,
  labels: ["needs-triage", "origin:selfperf"],
  hasMergedFix: false,
} satisfies PerformanceIssueFilerModule.PerformanceIssue;

const existingBudgetIssue = {
  ...existingIssue,
  fingerprint: decodeFingerprint("repository.test-suite-ms-per-test.above"),
} satisfies PerformanceIssueFilerModule.PerformanceIssue;

const markerlessIssue = (number: number) =>
  ({
    ...existingIssue,
    id: decodeWorkItemId(`#${number}`),
    fingerprint: undefined,
    state: "closed",
  }) satisfies PerformanceIssueFilerModule.PerformanceIssue;

const filerLayer = (issues: ReadonlyArray<PerformanceIssueFilerModule.PerformanceIssue>) =>
  Layer.effect(
    PerformanceIssueFilerModule.PerformanceIssueFiler,
    Effect.gen(function* () {
      const calls = yield* FilerCalls;
      return yield* PerformanceIssueFilerModule.make({
        codec: wireCodec,
        target: Effect.succeed({
          list: Effect.succeed(issues),
          pendingFingerprints: Effect.succeed(new Set()),
          create: (input) =>
            Ref.update(calls, (current) => ({ ...current, created: [...current.created, input] })),
          comment: (_id, body) =>
            Ref.update(calls, (current) => ({ ...current, comments: [...current.comments, body] })),
          ensureLabels: () => Effect.void,
          confirmPending: () => Effect.succeed(false),
        }),
      });
    }),
  ).pipe(Layer.provideMerge(FilerCalls.layer));

describe("test performance filer entry", () => {
  it.effect("submits a slower report to an in-memory filer target", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const result = yield* fileSuiteComparison({ report: report(), repository, workflowRunUrl, atMillis });

      assert.strictEqual(result, "filed");
      assert.strictEqual((yield* Ref.get(calls)).created.length, 1);
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("does not submit faster or inconclusive reports", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const results = yield* Effect.all([
        fileSuiteComparison({ report: report("faster"), repository, workflowRunUrl, atMillis }),
        fileSuiteComparison({ report: report("inconclusive"), repository, workflowRunUrl, atMillis }),
      ]);

      assert.deepStrictEqual(results, ["skipped", "skipped"]);
      assert.deepStrictEqual(yield* Ref.get(calls), { created: [], comments: [] });
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("requires the 1.15 materiality ratio derived from the 1.056 null-run ceiling", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const results = yield* Effect.all([
        fileSuiteComparison({
          report: report("slower", 1.149),
          repository,
          workflowRunUrl,
          atMillis,
        }),
        fileSuiteComparison({
          report: report("slower", 1.15),
          repository,
          workflowRunUrl,
          atMillis,
        }),
      ]);

      assert.deepStrictEqual(results, ["skipped", "filed"]);
      assert.strictEqual((yield* Ref.get(calls)).created.length, 1);
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("rejects an unknown comparison report schema version", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fileSuiteComparison({
          report: { ...report(), schemaVersion: 2 },
          repository,
          workflowRunUrl,
          atMillis,
        }),
      );

      if (error._tag !== "TestPerformanceEntryError") return assert.fail(error.message);
      assert.strictEqual(error.reason, "report");
      assert.include(error.message, "schemaVersion");
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("fails the entry when the shared filer cap is reached", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fileSuiteComparison({ report: report(), repository, workflowRunUrl, atMillis }),
      );

      if (error._tag !== "TestPerformanceEntryError") return assert.fail(error.message);
      assert.strictEqual(error.reason, "capped");
    }).pipe(Effect.provide(filerLayer([markerlessIssue(1), markerlessIssue(2), markerlessIssue(3)]))),
  );

  it.effect("keeps a commented filing successful", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const result = yield* fileSuiteComparison({ report: report(), repository, workflowRunUrl, atMillis });

      assert.strictEqual(result, "commented");
      assert.strictEqual((yield* Ref.get(calls)).comments.length, 1);
    }).pipe(Effect.provide(filerLayer([existingIssue]))),
  );

  it.effect("rejects a workflow run link outside the configured repository", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fileSuiteComparison({
          report: report(),
          repository,
          workflowRunUrl: "https://github.com/attacker/repository/actions/runs/123",
          atMillis,
        }),
      );

      if (error._tag !== "TestPerformanceEntryError") return assert.fail(error.message);
      assert.strictEqual(error.reason, "workflow-run-url");
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("files one work item when the seed-run median breaches 30 ms/test", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const result = yield* fileTestSuiteBudget({
        history: budgetHistory(65_000),
        repository,
        atMillis,
      });
      const recorded = yield* Ref.get(calls);
      const [created] = recorded.created;

      assert.strictEqual(result, "filed");
      assert.strictEqual(recorded.created.length, 1);
      assert.include(created?.body ?? "", "Rolling median: 32.5 ms/test");
      assert.include(created?.body ?? "", "Window: 20 seed runs");
      assert.include(created?.body ?? "", "https://github.com/colonylabs/cogwork/actions/runs/1");
      assert.include(created?.body ?? "", "https://github.com/colonylabs/cogwork/actions/runs/20");
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("does nothing when the seed-run median meets the budget", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;
      const noisyHistory = [...budgetHistory(50_000).slice(0, 11), ...budgetHistory(100_000).slice(0, 9)];

      const results = yield* Effect.all([
        fileTestSuiteBudget({ history: budgetHistory(60_000), repository, atMillis }),
        fileTestSuiteBudget({ history: budgetHistory(50_000), repository, atMillis }),
        fileTestSuiteBudget({ history: noisyHistory, repository, atMillis }),
      ]);

      assert.deepStrictEqual(results, ["skipped", "skipped", "skipped"]);
      assert.deepStrictEqual(yield* Ref.get(calls), { created: [], comments: [] });
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("rejects missing, malformed, or oversized seed-run history", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;
      const invalidHistories = [[], [{}], [...budgetHistory(65_000), seedRun(21, 65_000)]];

      const errors = yield* Effect.forEach(invalidHistories, (history) =>
        Effect.flip(fileTestSuiteBudget({ history, repository, atMillis })),
      );

      assert.isTrue(errors.every((error) => error.reason === "history"));
      assert.deepStrictEqual(yield* Ref.get(calls), { created: [], comments: [] });
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("reports a near-threshold breach above the budget", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      yield* fileTestSuiteBudget({ history: budgetHistory(60_001), repository, atMillis });
      const [created] = (yield* Ref.get(calls)).created;

      assert.include(created?.body ?? "", "Rolling median: 30.01 ms/test");
      assert.include(created?.body ?? "", "| 60001 ms | 2000 | 30.01 |");
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("comments on the open budget fingerprint instead of filing a second issue", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const result = yield* fileTestSuiteBudget({
        history: budgetHistory(65_000),
        repository,
        atMillis,
      });

      assert.strictEqual(result, "commented");
      assert.strictEqual((yield* Ref.get(calls)).created.length, 0);
      assert.strictEqual((yield* Ref.get(calls)).comments.length, 1);
    }).pipe(Effect.provide(filerLayer([existingBudgetIssue]))),
  );

  it.effect("files when the slowest test file exceeds the 14 s budget", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const result = yield* fileTestFileBudget({
        reportJson: encodeJson(timingReport(14_001)),
        repository: repositoryRef,
        workflowRunUrl,
        atMillis,
      });
      const recorded = yield* Ref.get(calls);
      const [created] = recorded.created;

      assert.strictEqual(result, "filed");
      assert.strictEqual(created?.fingerprint, "repository.test-file-duration.above");
      assert.include(created?.body ?? "", "Budget: ≤ 14000 ms");
      assert.include(created?.body ?? "", "Slowest test file: `packages/engine/src/harness-host.test.ts`");
      assert.include(created?.body ?? "", "Observed: 14001 ms across 12 tests");
      assert.include(created?.body ?? "", workflowRunUrl);
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("does nothing when the slowest test file meets the budget", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const result = yield* fileTestFileBudget({
        reportJson: encodeJson(timingReport(14_000)),
        repository: repositoryRef,
        workflowRunUrl,
        atMillis,
      });

      assert.strictEqual(result, "skipped");
      assert.deepStrictEqual(yield* Ref.get(calls), { created: [], comments: [] });
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("escapes fingerprint markers in test file paths", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;
      const injectedMarker = "<!-- cogwork:selfperf fingerprint=repository.test-suite-ms-per-test.above -->";

      const result = yield* fileTestFileBudget({
        reportJson: encodeJson(timingReport(14_001, `slow${injectedMarker}.test.ts`)),
        repository: repositoryRef,
        workflowRunUrl,
        atMillis,
      });
      const [created] = (yield* Ref.get(calls)).created;

      assert.strictEqual(result, "filed");
      assert.strictEqual(created?.fingerprint, "repository.test-file-duration.above");
      assert.notInclude(created?.body ?? "", injectedMarker);
      assert.include(created?.body ?? "", "slow&lt;!-- cogwork:selfperf");
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("accepts a skipped-only file in the timing report", () =>
    Effect.gen(function* () {
      const calls = yield* FilerCalls;

      const result = yield* fileTestFileBudget({
        reportJson: encodeJson(timingReport(14_001, "packages/engine/src/skipped.test.ts", 0)),
        repository: repositoryRef,
        workflowRunUrl,
        atMillis,
      });
      const [created] = (yield* Ref.get(calls)).created;

      assert.strictEqual(result, "filed");
      assert.include(created?.body ?? "", "Observed: 14001 ms across 0 tests");
    }).pipe(Effect.provide(filerLayer([]))),
  );
});
