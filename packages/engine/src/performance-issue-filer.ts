import { GitCommitSha, GitHubWorkflowRunUrl, makeBrand, type WorkItemId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { WireCodec } from "./coordination";
import type { IssueTrackerError } from "./issue-tracker";

export interface PerformanceIssue {
  readonly id: WorkItemId;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly fingerprint: PerformanceIssueFingerprint | undefined;
  readonly createdAtMillis: number;
  readonly labels: ReadonlyArray<string>;
  readonly hasMergedFix: boolean;
}

export const PerformanceIssueFingerprint = makeBrand("PerformanceIssueFingerprint");
export type PerformanceIssueFingerprint = typeof PerformanceIssueFingerprint.Type;

export interface PerformanceIssueCreateInput {
  readonly fingerprint: PerformanceIssueFingerprint;
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
}

export interface PerformanceIssueFilerHost {
  readonly codec: WireCodec;
  readonly target: Effect.Effect<PerformanceIssueFilerTarget, IssueTrackerError>;
}

export interface PerformanceIssueFilerTarget {
  readonly list: Effect.Effect<ReadonlyArray<PerformanceIssue>, IssueTrackerError>;
  readonly pendingFingerprints: Effect.Effect<ReadonlySet<PerformanceIssueFingerprint>, IssueTrackerError>;
  readonly create: (input: PerformanceIssueCreateInput) => Effect.Effect<void, IssueTrackerError>;
  readonly comment: (id: WorkItemId, body: string) => Effect.Effect<void, IssueTrackerError>;
  readonly ensureLabels: (issue: PerformanceIssue) => Effect.Effect<void, IssueTrackerError>;
  readonly confirmPending: (issue: PerformanceIssue) => Effect.Effect<boolean, IssueTrackerError>;
}

const HealthSignalPerformanceVerdict = Schema.Struct({
  kind: Schema.Literal("health-signal"),
  signal: Schema.Literals(["event-loop-delay-p99", "heap-headroom"]),
  subsystem: Schema.Literals(["daemon", "renderer"]),
  direction: Schema.Literals(["above", "below"]),
  observed: Schema.Finite,
  threshold: Schema.Finite,
  unit: Schema.Literals(["ms", "%"]),
  windowMillis: Schema.Finite,
  consecutiveBreaches: Schema.Finite,
  evidence: Schema.Struct({
    path: Schema.String,
    appVersion: Schema.String,
    runsInFlight: Schema.Finite,
    workspaceCount: Schema.Finite,
    machineLoad: Schema.Struct({
      cpuCount: Schema.Finite,
      loadAverage: Schema.Array(Schema.Finite),
      freeMemoryBytes: Schema.Finite,
    }),
  }),
});
type HealthSignalPerformanceVerdict = typeof HealthSignalPerformanceVerdict.Type;

const SuiteComparisonPerformanceVerdict = Schema.Struct({
  kind: Schema.Literal("suite-comparison"),
  signal: Schema.Literal("test-suite-duration"),
  subsystem: Schema.Literal("repository"),
  direction: Schema.Literal("slower"),
  base: Schema.Struct({
    medianDurationMs: Schema.Finite,
    sha: GitCommitSha,
  }),
  head: Schema.Struct({
    medianDurationMs: Schema.Finite,
    sha: GitCommitSha,
  }),
  ratio: Schema.Finite,
  confidenceInterval: Schema.Struct({
    lowRatio: Schema.Finite,
    highRatio: Schema.Finite,
    confidence: Schema.Finite,
  }),
  rounds: Schema.Int.check(Schema.isGreaterThan(0)),
  workflowRunUrl: GitHubWorkflowRunUrl,
});
type SuiteComparisonPerformanceVerdict = typeof SuiteComparisonPerformanceVerdict.Type;

export const PerformanceVerdict = Schema.Union([
  HealthSignalPerformanceVerdict,
  SuiteComparisonPerformanceVerdict,
]).pipe(Schema.toTaggedUnion("kind"));
export type PerformanceVerdict = typeof PerformanceVerdict.Type;

export interface PerformanceVerdictIdentity {
  readonly signal: PerformanceVerdict["signal"];
  readonly subsystem: PerformanceVerdict["subsystem"];
  readonly direction: PerformanceVerdict["direction"];
}

export type PerformanceIssueFilingResult = "filed" | "commented" | "capped";

export interface PerformanceIssueFilerService {
  readonly submit: (
    verdict: PerformanceVerdict,
    atMillis: number,
  ) => Effect.Effect<PerformanceIssueFilingResult, IssueTrackerError>;
}

export class PerformanceIssueFiler extends Context.Service<
  PerformanceIssueFiler,
  PerformanceIssueFilerService
>()("@cogwork/engine/performance-issue-filer/PerformanceIssueFiler") {}

const dayMillis = 24 * 60 * 60 * 1_000;
export const performanceIssueLabels = ["needs-triage", "origin:selfperf"] as const;
export const performanceIssueFilingOutcomes = Metric.counter(
  "cogwork_performance_issue_filing_outcomes_total",
  { description: "Performance issue filing decisions by outcome." },
);

const utcDay = (millis: number) => Math.floor(millis / dayMillis);

const latestClosed = (issues: ReadonlyArray<PerformanceIssue>) =>
  issues
    .filter((issue) => issue.state === "closed")
    .toSorted((left, right) => right.createdAtMillis - left.createdAtMillis)
    .at(0);

const countUnconfirmedFilings = (
  issues: ReadonlyArray<PerformanceIssue>,
  pendingFingerprints: ReadonlySet<PerformanceIssueFingerprint>,
) =>
  [...pendingFingerprints].filter((fingerprint) => !issues.some((issue) => issue.fingerprint === fingerprint))
    .length;

const directionMetadata = {
  above: { operator: ">", title: "exceeded", recovered: "at or below" },
  below: { operator: "<", title: "fell below", recovered: "at or above" },
} as const;

const signalNames = {
  "event-loop-delay-p99": "event-loop delay p99",
  "heap-headroom": "heap headroom",
} as const;

const subsystemTitle = {
  daemon: "Daemon",
  renderer: "Renderer",
} as const;

const titleThreshold = (threshold: number, unit: HealthSignalPerformanceVerdict["unit"]) =>
  unit === "%" ? `${threshold}${unit}` : `${threshold} ${unit}`;

const formatValue = (value: number) => Number(value.toFixed(2));

export const performanceVerdictFingerprint = (verdict: PerformanceVerdictIdentity) =>
  PerformanceIssueFingerprint.make(`${verdict.subsystem}.${verdict.signal}.${verdict.direction}`);

const occurrenceLines = (verdict: HealthSignalPerformanceVerdict) => [
  `Observed: ${formatValue(verdict.observed)} ${verdict.unit}`,
  `Threshold: ${directionMetadata[verdict.direction].operator} ${verdict.threshold} ${verdict.unit}`,
  `Window: ${verdict.windowMillis / 1_000} seconds`,
  `Consecutive breaches: ${verdict.consecutiveBreaches}`,
];

const renderHealthSignal = (verdict: HealthSignalPerformanceVerdict) => {
  const signal = signalNames[verdict.signal];
  const direction = directionMetadata[verdict.direction];
  const fingerprint = performanceVerdictFingerprint(verdict);
  const title = `${subsystemTitle[verdict.subsystem]} ${signal} ${direction.title} ${titleThreshold(verdict.threshold, verdict.unit)}`;
  return {
    fingerprint,
    title,
    recurrenceTitle: `Regression: ${title}`,
    body: [
      `Signal: ${verdict.subsystem} ${signal} ${verdict.direction} threshold`,
      ...occurrenceLines(verdict),
      `Runs in flight: ${verdict.evidence.runsInFlight}`,
      `Workspace count: ${verdict.evidence.workspaceCount}`,
      `Cogwork version: ${verdict.evidence.appVersion}`,
      `Machine load: CPUs=${verdict.evidence.machineLoad.cpuCount}; averages=${verdict.evidence.machineLoad.loadAverage.join(", ")}; free memory=${verdict.evidence.machineLoad.freeMemoryBytes} bytes`,
      `Evidence: ${verdict.evidence.path}`,
      `Close when: ${verdict.subsystem} ${signal} is ${direction.recovered} the threshold over a ${verdict.windowMillis / 1_000}-second window.`,
    ].join("\n\n"),
    recurrenceBody: ["Fired again.", ...occurrenceLines(verdict), `Evidence: ${verdict.evidence.path}`].join(
      "\n\n",
    ),
  };
};

const suiteComparisonEvidence = (verdict: SuiteComparisonPerformanceVerdict) =>
  [
    "Signal: Test suite duration — repository — slower",
    "",
    `- Baseline median: ${formatValue(verdict.base.medianDurationMs)} ms`,
    `- Current median: ${formatValue(verdict.head.medianDurationMs)} ms`,
    `- Ratio: ${verdict.ratio}`,
    `- ${verdict.confidenceInterval.confidence * 100}% confidence interval: ${verdict.confidenceInterval.lowRatio}–${verdict.confidenceInterval.highRatio}`,
    `- Rounds: ${verdict.rounds}`,
    `- Baseline commit: ${verdict.base.sha}`,
    `- Current commit: ${verdict.head.sha}`,
    `- Measurement run: ${verdict.workflowRunUrl}`,
    "",
    "Close when: a follow-up comparison against the baseline no longer reports a statistically significant slowdown.",
  ].join("\n");

const renderSuiteComparison = (verdict: SuiteComparisonPerformanceVerdict) => {
  const body = suiteComparisonEvidence(verdict);
  return {
    fingerprint: performanceVerdictFingerprint(verdict),
    title: "Test suite performance regressed",
    recurrenceTitle: "Test suite performance regressed again",
    body,
    recurrenceBody: `Fired again.\n\n${body}`,
  };
};

const renderVerdict = (verdict: PerformanceVerdict) =>
  PerformanceVerdict.match(verdict, {
    "health-signal": renderHealthSignal,
    "suite-comparison": renderSuiteComparison,
  });

const recurrenceIssue = (
  codec: WireCodec,
  rendered: ReturnType<typeof renderVerdict>,
  previous: PerformanceIssue | undefined,
) =>
  ({
    fingerprint: rendered.fingerprint,
    title: previous ? rendered.recurrenceTitle : rendered.title,
    body: [
      rendered.body,
      ...(previous ? [`Previous occurrence: ${previous.url}`] : []),
      codec.encode({ name: "selfperf", pairs: `fingerprint=${rendered.fingerprint}` }),
    ].join("\n\n"),
    labels: performanceIssueLabels,
  }) satisfies PerformanceIssueCreateInput;

export const make = Effect.fn("PerformanceIssueFiler.make")(function* (
  host: PerformanceIssueFilerHost,
  dailyCap = 3,
) {
  const gate = Semaphore.makeUnsafe(1);
  const localFilings = yield* Ref.make({ day: -1, count: 0 });
  const recordOutcome = Effect.fn("PerformanceIssueFiler.recordOutcome")(function* (
    outcome: PerformanceIssueFilingResult,
    fingerprint: PerformanceIssueFingerprint,
  ) {
    yield* Metric.update(Metric.withAttributes(performanceIssueFilingOutcomes, { outcome }), 1);
    yield* Effect.logInfo("performance issue filing decided", { outcome, fingerprint });
    return outcome;
  });

  const submitUnlocked = Effect.fn("PerformanceIssueFiler.submit")(function* (
    verdict: PerformanceVerdict,
    atMillis: number,
  ) {
    const rendered = renderVerdict(verdict);
    const target = yield* host.target;
    const issues = yield* target.list;
    const pendingFingerprints = yield* target.pendingFingerprints;
    const matching = issues.filter((issue) => issue.fingerprint === rendered.fingerprint);
    const open = matching.find((issue) => issue.state === "open");
    const pending = pendingFingerprints.has(rendered.fingerprint);
    const confirmed = open && pending ? yield* target.confirmPending(open) : false;
    if (confirmed) return yield* recordOutcome("filed", rendered.fingerprint);
    if (open && !pending) {
      yield* target.ensureLabels(open);
      yield* target.comment(open.id, rendered.recurrenceBody);
      return yield* recordOutcome("commented", rendered.fingerprint);
    }

    const previous = latestClosed(matching);
    if (pending) {
      yield* target.create(recurrenceIssue(host.codec, rendered, previous));
      return yield* recordOutcome("filed", rendered.fingerprint);
    }

    if (previous && !previous.hasMergedFix) {
      yield* target.ensureLabels(previous);
      yield* target.comment(previous.id, rendered.recurrenceBody);
      return yield* recordOutcome("commented", rendered.fingerprint);
    }

    const day = utcDay(atMillis);
    const issuesFiledToday = issues.filter((issue) => utcDay(issue.createdAtMillis) === day);
    const trackerCount =
      issuesFiledToday.length + countUnconfirmedFilings(issuesFiledToday, pendingFingerprints);
    const local = yield* Ref.get(localFilings);
    const localCount = local.day === day ? local.count : 0;
    const filingCount = Math.max(trackerCount, localCount);
    if (filingCount >= dailyCap) return yield* recordOutcome("capped", rendered.fingerprint);

    yield* target.create(recurrenceIssue(host.codec, rendered, previous));
    yield* Ref.set(localFilings, { day, count: filingCount + 1 });
    return yield* recordOutcome("filed", rendered.fingerprint);
  });

  return {
    submit: Effect.fn("PerformanceIssueFiler.submit")((input, atMillis) =>
      gate.withPermit(submitUnlocked(input, atMillis)),
    ),
  } satisfies PerformanceIssueFilerService;
});
