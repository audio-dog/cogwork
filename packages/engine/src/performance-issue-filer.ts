import { makeBrand, type WorkItemId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { WireCodec } from "./coordination";
import type { CreateIssueInput, IssueTrackerError } from "./issue-tracker";

export interface PerformanceIssue {
  readonly id: WorkItemId;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly body: string;
  readonly createdAtMillis: number;
  readonly labels: ReadonlyArray<string>;
  readonly hasMergedFix: boolean;
}

export const PerformanceIssueFingerprint = makeBrand("PerformanceIssueFingerprint");
export type PerformanceIssueFingerprint = typeof PerformanceIssueFingerprint.Type;

export interface PerformanceIssueFilerHost {
  readonly codec: WireCodec;
  readonly target: Effect.Effect<PerformanceIssueFilerTarget, IssueTrackerError>;
}

export interface PerformanceIssueFilerTarget {
  readonly list: Effect.Effect<ReadonlyArray<PerformanceIssue>, IssueTrackerError>;
  readonly pendingFingerprints: Effect.Effect<ReadonlySet<PerformanceIssueFingerprint>, IssueTrackerError>;
  readonly create: (input: CreateIssueInput) => Effect.Effect<void, IssueTrackerError>;
  readonly comment: (id: WorkItemId, body: string) => Effect.Effect<void, IssueTrackerError>;
  readonly ensureLabels: (issue: PerformanceIssue) => Effect.Effect<void, IssueTrackerError>;
  readonly confirmPending: (issue: PerformanceIssue) => Effect.Effect<boolean, IssueTrackerError>;
}

export interface PerformanceIssueInput {
  readonly fingerprint: PerformanceIssueFingerprint;
  readonly title: string;
  readonly body: string;
  readonly recurrenceBody: string;
}

export type PerformanceIssueFilingResult = "filed" | "commented" | "capped";

export interface PerformanceIssueFilerService {
  readonly submit: (
    input: PerformanceIssueInput,
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

const carriesFingerprint = (
  codec: WireCodec,
  issue: PerformanceIssue,
  fingerprint: PerformanceIssueFingerprint,
) =>
  codec
    .scan(issue.body)
    .some((marker) => marker.name === "selfperf" && marker.pairs === `fingerprint=${fingerprint}`);

const latestClosed = (issues: ReadonlyArray<PerformanceIssue>) =>
  issues
    .filter((issue) => issue.state === "closed")
    .toSorted((left, right) => right.createdAtMillis - left.createdAtMillis)
    .at(0);

const countUnconfirmedFilings = (
  codec: WireCodec,
  issues: ReadonlyArray<PerformanceIssue>,
  pendingFingerprints: ReadonlySet<PerformanceIssueFingerprint>,
) =>
  [...pendingFingerprints].filter(
    (fingerprint) => !issues.some((issue) => carriesFingerprint(codec, issue, fingerprint)),
  ).length;

const recurrenceIssue = (
  codec: WireCodec,
  input: PerformanceIssueInput,
  previous: PerformanceIssue | undefined,
) => ({
  title: previous ? `Regression: ${input.title}` : input.title,
  body: [
    input.body,
    ...(previous ? [`Previous occurrence: ${previous.url}`] : []),
    codec.encode({ name: "selfperf", pairs: `fingerprint=${input.fingerprint}` }),
  ].join("\n\n"),
  labels: performanceIssueLabels,
});

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
    input: PerformanceIssueInput,
    atMillis: number,
  ) {
    const target = yield* host.target;
    const issues = yield* target.list;
    const pendingFingerprints = yield* target.pendingFingerprints;
    const matching = issues.filter((issue) => carriesFingerprint(host.codec, issue, input.fingerprint));
    const open = matching.find((issue) => issue.state === "open");
    const pending = pendingFingerprints.has(input.fingerprint);
    const confirmed = open && pending ? yield* target.confirmPending(open) : false;
    if (confirmed) return yield* recordOutcome("filed", input.fingerprint);
    if (open && !pending) {
      yield* target.ensureLabels(open);
      yield* target.comment(open.id, input.recurrenceBody);
      return yield* recordOutcome("commented", input.fingerprint);
    }

    const previous = latestClosed(matching);
    if (pending) {
      yield* target.create(recurrenceIssue(host.codec, input, previous));
      return yield* recordOutcome("filed", input.fingerprint);
    }

    if (previous && !previous.hasMergedFix) {
      yield* target.ensureLabels(previous);
      yield* target.comment(previous.id, input.recurrenceBody);
      return yield* recordOutcome("commented", input.fingerprint);
    }

    const day = utcDay(atMillis);
    const issuesFiledToday = issues.filter((issue) => utcDay(issue.createdAtMillis) === day);
    const trackerCount =
      issuesFiledToday.length + countUnconfirmedFilings(host.codec, issuesFiledToday, pendingFingerprints);
    const local = yield* Ref.get(localFilings);
    const localCount = local.day === day ? local.count : 0;
    const filingCount = Math.max(trackerCount, localCount);
    if (filingCount >= dailyCap) return yield* recordOutcome("capped", input.fingerprint);

    yield* target.create(recurrenceIssue(host.codec, input, previous));
    yield* Ref.set(localFilings, { day, count: filingCount + 1 });
    return yield* recordOutcome("filed", input.fingerprint);
  });

  return {
    submit: Effect.fn("PerformanceIssueFiler.submit")((input, atMillis) =>
      gate.withPermit(submitUnlocked(input, atMillis)),
    ),
  } satisfies PerformanceIssueFilerService;
});
