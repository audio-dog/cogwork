import { WorkItemId } from "@cogwork/contracts";
import { PerformanceIssueFiler as PerformanceIssueFilerModule } from "@cogwork/engine";
import { wireCodec } from "@cogwork/engine/github/markers";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { fileSuiteComparison } from "./test-performance-filer.ts";

const atMillis = Date.UTC(2026, 8, 9, 12);
const repository = "colonylabs/cogwork";
const workflowRunUrl = "https://github.com/colonylabs/cogwork/actions/runs/123";
const report = (verdict: "slower" | "faster" | "inconclusive" = "slower") => ({
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
  ratio: 1.2,
  confidenceInterval: { lowRatio: 1.1, highRatio: 1.3, confidence: 0.95 },
  rounds: 5,
  seed: 0x5eed1234,
});

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

      if (error._tag !== "SuiteComparisonEntryError") return assert.fail(error.message);
      assert.strictEqual(error.reason, "report");
      assert.include(error.message, "schemaVersion");
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("fails the entry when the shared filer cap is reached", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fileSuiteComparison({ report: report(), repository, workflowRunUrl, atMillis }),
      );

      if (error._tag !== "SuiteComparisonEntryError") return assert.fail(error.message);
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

      if (error._tag !== "SuiteComparisonEntryError") return assert.fail(error.message);
      assert.strictEqual(error.reason, "workflow-run-url");
    }).pipe(Effect.provide(filerLayer([]))),
  );
});
