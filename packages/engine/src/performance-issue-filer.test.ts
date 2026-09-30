import { WorkItemId, type WorkItemId as WorkItemIdType } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { wireCodec } from "./github/markers";
import {
  GitCommitSha,
  GitHubWorkflowRunUrl,
  make,
  type PerformanceIssue,
  type PerformanceIssueCreateInput,
  PerformanceIssueFiler,
  type PerformanceIssueFilerHost,
  PerformanceIssueFingerprint,
  type PerformanceVerdict,
} from "./performance-issue-filer";

const decodeWorkItemId = Schema.decodeSync(WorkItemId);
const decodeGitCommitSha = Schema.decodeSync(GitCommitSha);
const decodeGitHubWorkflowRunUrl = Schema.decodeSync(GitHubWorkflowRunUrl);
const decodeStartedAt = Schema.decodeSync(Schema.DateTimeUtcFromString);
const decodeFingerprint = Schema.decodeSync(PerformanceIssueFingerprint);
const fingerprint = decodeFingerprint("daemon.event-loop-delay-p99.above");
const marker = wireCodec.encode({ name: "selfperf", pairs: `fingerprint=${fingerprint}` });
const pendingFingerprint = decodeFingerprint("renderer.heap-headroom.below");
const unconfirmedFingerprint = decodeFingerprint("daemon.heap-headroom.below");

interface Recorded {
  readonly created: ReadonlyArray<PerformanceIssueCreateInput>;
  readonly comments: ReadonlyArray<{ readonly id: WorkItemIdType; readonly body: string }>;
  readonly labelRepairs: ReadonlyArray<WorkItemIdType>;
}

const verdict = {
  kind: "health-signal",
  signal: "event-loop-delay-p99",
  subsystem: "daemon",
  direction: "above",
  observed: 140,
  threshold: 100,
  unit: "ms",
  windowMillis: 10_000,
  consecutiveBreaches: 3,
  evidence: {
    path: "/tmp/daemon.event-loop-delay-p99.above.json",
    appVersion: "0.0.1-test",
    runsInFlight: 2,
    workspaceCount: 1,
    machineLoad: { cpuCount: 8, loadAverage: [1, 0.5, 0.25], freeMemoryBytes: 1_000 },
  },
} satisfies PerformanceVerdict;

const suiteComparisonVerdict = {
  kind: "suite-comparison",
  signal: "test-suite-duration",
  subsystem: "repository",
  direction: "slower",
  base: {
    medianDurationMs: 100,
    sha: decodeGitCommitSha("1111111111111111111111111111111111111111"),
  },
  head: {
    medianDurationMs: 120,
    sha: decodeGitCommitSha("2222222222222222222222222222222222222222"),
  },
  ratio: 1.005,
  confidenceInterval: { lowRatio: 1.004, highRatio: 1.006, confidence: 0.95 },
  rounds: 5,
  workflowRunUrl: decodeGitHubWorkflowRunUrl("https://github.com/colonylabs/cogwork/actions/runs/123"),
} satisfies PerformanceVerdict;

const budgetVerdict = {
  kind: "budget",
  signal: "test-suite-ms-per-test",
  subsystem: "repository",
  direction: "above",
  observed: 32.5,
  budget: 30,
  unit: "ms/test",
  window: [
    {
      durationMs: 65_000,
      testCount: 2_000,
      sha: decodeGitCommitSha("2222222222222222222222222222222222222222"),
      startedAt: decodeStartedAt("2026-09-22T12:00:00Z"),
      workflowRunUrl: decodeGitHubWorkflowRunUrl("https://github.com/colonylabs/cogwork/actions/runs/123"),
    },
  ],
} satisfies PerformanceVerdict;

const recurrenceBody = [
  "Fired again.",
  "Observed: 140 ms",
  "Threshold: > 100 ms",
  "Window: 10 seconds",
  "Consecutive breaches: 3",
  "Evidence: /tmp/daemon.event-loop-delay-p99.above.json",
].join("\n\n");

class PerformanceIssueCalls extends Context.Service<PerformanceIssueCalls, Ref.Ref<Recorded>>()(
  "@cogwork/engine/performance-issue-filer.test/PerformanceIssueCalls",
) {
  static readonly layer = Layer.effect(
    PerformanceIssueCalls,
    Ref.make<Recorded>({ created: [], comments: [], labelRepairs: [] }),
  );
}

const filerLayer = (
  issues: ReadonlyArray<PerformanceIssue>,
  pendingFingerprints: ReadonlySet<PerformanceIssueFingerprint> = new Set(),
) =>
  Layer.effect(
    PerformanceIssueFiler,
    Effect.gen(function* () {
      const recorded = yield* PerformanceIssueCalls;
      const host: PerformanceIssueFilerHost = {
        codec: wireCodec,
        target: Effect.succeed({
          list: Effect.succeed(issues),
          pendingFingerprints: Effect.succeed(pendingFingerprints),
          create: (created) =>
            Ref.update(recorded, (current) => ({ ...current, created: [...current.created, created] })),
          comment: (id, body) =>
            Ref.update(recorded, (current) => ({
              ...current,
              comments: [...current.comments, { id, body }],
            })),
          ensureLabels: (currentIssue) =>
            Ref.update(recorded, (current) => ({
              ...current,
              labelRepairs: [...current.labelRepairs, currentIssue.id],
            })),
          confirmPending: (currentIssue) =>
            Ref.update(recorded, (current) => ({
              ...current,
              labelRepairs: [...current.labelRepairs, currentIssue.id],
            })).pipe(Effect.map(() => true)),
        }),
      };
      return yield* make(host, 3);
    }),
  ).pipe(Layer.provideMerge(PerformanceIssueCalls.layer));

const issue = (overrides: Partial<PerformanceIssue> = {}) =>
  ({
    id: decodeWorkItemId("#10"),
    url: "https://github.com/colonylabs/cogwork/issues/10",
    state: "open",
    fingerprint,
    createdAtMillis: Date.UTC(2026, 8, 9, 12),
    labels: ["needs-triage", "origin:selfperf"],
    hasMergedFix: false,
    ...overrides,
  }) satisfies PerformanceIssue;

const today = Date.UTC(2026, 8, 9, 15);
const filedToday = issue({
  id: decodeWorkItemId("#1"),
  fingerprint: undefined,
  createdAtMillis: today - 1,
});
const cappedIssues = [
  filedToday,
  issue({ id: decodeWorkItemId("#2"), fingerprint: undefined, createdAtMillis: today - 2 }),
  issue({ id: decodeWorkItemId("#3"), fingerprint: undefined, createdAtMillis: today - 3 }),
];
const closedOccurrence = issue({
  state: "closed",
  createdAtMillis: Date.UTC(2026, 8, 8, 12),
  hasMergedFix: true,
});
const closedBudgetOccurrence = issue({
  state: "closed",
  fingerprint: decodeFingerprint("repository.test-suite-ms-per-test.above"),
  createdAtMillis: Date.UTC(2026, 8, 8, 12),
  hasMergedFix: true,
});
const visiblePending = issue({
  id: decodeWorkItemId("#2"),
  fingerprint: pendingFingerprint,
});

describe("performance issue filer", () => {
  it.effect("comments on an open fingerprint match instead of filing", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);

      assert.strictEqual(result, "commented");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [{ id: decodeWorkItemId("#10"), body: recurrenceBody }],
        labelRepairs: [decodeWorkItemId("#10")],
      });
    }).pipe(Effect.provide(filerLayer([issue()]))),
  );

  it.effect("confirms a pending open issue without posting a recurrence comment", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);

      assert.strictEqual(result, "filed");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [],
        labelRepairs: [decodeWorkItemId("#10")],
      });
    }).pipe(Effect.provide(filerLayer([issue()], new Set([fingerprint])))),
  );

  it.effect("counts markerless performance issues toward the UTC-day filing cap", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);

      assert.strictEqual(result, "capped");
      assert.deepStrictEqual(yield* Ref.get(recorded), { created: [], comments: [], labelRepairs: [] });
    }).pipe(Effect.provide(filerLayer(cappedIssues))),
  );

  it.effect("counts accepted issues that are waiting for confirmation", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);

      assert.strictEqual(result, "capped");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [],
        labelRepairs: [],
      });
    }).pipe(Effect.provide(filerLayer(cappedIssues.slice(0, 2), new Set([unconfirmedFingerprint])))),
  );

  it.effect("does not count a visible pending issue twice", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);

      assert.strictEqual(result, "filed");
      assert.strictEqual((yield* Ref.get(recorded)).created.length, 1);
    }).pipe(Effect.provide(filerLayer([filedToday, visiblePending], new Set([pendingFingerprint])))),
  );

  it.effect("comments on a closed occurrence until its fix merges", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);

      assert.strictEqual(result, "commented");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [{ id: closedOccurrence.id, body: recurrenceBody }],
        labelRepairs: [closedOccurrence.id],
      });
    }).pipe(Effect.provide(filerLayer([{ ...closedOccurrence, hasMergedFix: false }]))),
  );

  it.effect("files a cross-linked regression instead of reopening a closed issue", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);
      const calls = yield* Ref.get(recorded);

      assert.strictEqual(result, "filed");
      assert.strictEqual(calls.comments.length, 0);
      assert.strictEqual(calls.created.length, 1);
      assert.strictEqual(calls.created[0]?.title, "Regression: Daemon event-loop delay p99 exceeded 100 ms");
      assert.include(calls.created[0]?.body ?? "", `Previous occurrence: ${closedOccurrence.url}`);
    }).pipe(Effect.provide(filerLayer([closedOccurrence]))),
  );

  it.effect("files one labeled evidence issue when no fingerprint matches", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(verdict, today);
      const [created] = (yield* Ref.get(recorded)).created;

      assert.strictEqual(result, "filed");
      assert.deepStrictEqual(created, {
        fingerprint,
        title: "Daemon event-loop delay p99 exceeded 100 ms",
        body: [
          "Signal: daemon event-loop delay p99 above threshold",
          "Observed: 140 ms",
          "Threshold: > 100 ms",
          "Window: 10 seconds",
          "Consecutive breaches: 3",
          "Runs in flight: 2",
          "Workspace count: 1",
          "Cogwork version: 0.0.1-test",
          "Machine load: CPUs=8; averages=1, 0.5, 0.25; free memory=1000 bytes",
          "Evidence: /tmp/daemon.event-loop-delay-p99.above.json",
          "Close when: daemon event-loop delay p99 is at or below the threshold over a 10-second window.",
          marker,
        ].join("\n\n"),
        labels: ["needs-triage", "origin:selfperf"],
      });
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("renders a suite comparison verdict as thin evidence", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(suiteComparisonVerdict, today);
      const [created] = (yield* Ref.get(recorded)).created;

      assert.strictEqual(result, "filed");
      assert.deepStrictEqual(created, {
        fingerprint: decodeFingerprint("repository.test-suite-duration.slower"),
        title: "Test suite performance regressed",
        body: [
          "Signal: Test suite duration — repository — slower",
          "- Baseline median: 100 ms\n- Current median: 120 ms\n- Ratio: 1.005\n- 95% confidence interval: 1.004–1.006\n- Rounds: 5\n- Baseline commit: 1111111111111111111111111111111111111111\n- Current commit: 2222222222222222222222222222222222222222\n- Measurement run: https://github.com/colonylabs/cogwork/actions/runs/123\n\nClose when: a follow-up comparison against the baseline no longer reports a statistically significant slowdown.",
          wireCodec.encode({
            name: "selfperf",
            pairs: "fingerprint=repository.test-suite-duration.slower",
          }),
        ].join("\n\n"),
        labels: ["needs-triage", "origin:selfperf"],
      });
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("renders a test-suite budget verdict with its seed-run window", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(budgetVerdict, today);
      const [created] = (yield* Ref.get(recorded)).created;

      assert.strictEqual(result, "filed");
      assert.deepStrictEqual(created, {
        fingerprint: decodeFingerprint("repository.test-suite-ms-per-test.above"),
        title: "Test suite exceeds the 30 ms/test budget",
        body: [
          "Signal: Test suite cost — repository — above budget",
          "Budget: ≤ 30 ms/test\nRolling median: 32.5 ms/test\nWindow: 1 seed run from 2026-09-22T12:00:00.000Z to 2026-09-22T12:00:00.000Z\n\n| Seed run | Commit | Duration | Tests | ms/test |\n| --- | --- | ---: | ---: | ---: |\n| [2026-09-22T12:00:00.000Z](https://github.com/colonylabs/cogwork/actions/runs/123) | `2222222` | 65000 ms | 2000 | 32.5 |\n\nClose when: the rolling median over the latest seed-run window is at or below 30 ms/test.",
          wireCodec.encode({
            name: "selfperf",
            pairs: "fingerprint=repository.test-suite-ms-per-test.above",
          }),
        ].join("\n\n"),
        labels: ["needs-triage", "origin:selfperf"],
      });
    }).pipe(Effect.provide(filerLayer([]))),
  );

  it.effect("files a cross-linked regression when a fixed budget breach recurs", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(budgetVerdict, today);
      const [created] = (yield* Ref.get(recorded)).created;

      assert.strictEqual(result, "filed");
      assert.strictEqual(created?.title, "Regression: Test suite exceeds the 30 ms/test budget");
      assert.include(created?.body ?? "", `Previous occurrence: ${closedBudgetOccurrence.url}`);
    }).pipe(Effect.provide(filerLayer([closedBudgetOccurrence]))),
  );
});
