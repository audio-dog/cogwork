#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { GitHub, PerformanceIssueFiler as PerformanceIssueFilerModule } from "@cogwork/engine";
import { wireCodec } from "@cogwork/engine/github/markers";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const positiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const materialRegressionRatio = 1.15;
const slowestTestFileBudgetMs = 14_000;
const testSuiteBudgetMsPerTest = 30;

const SuiteComparisonReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  verdict: Schema.Literals(["slower", "faster", "inconclusive"]),
  base: Schema.Struct({
    sha: PerformanceIssueFilerModule.GitCommitSha,
    medianDurationMs: positiveFinite,
  }),
  head: Schema.Struct({
    sha: PerformanceIssueFilerModule.GitCommitSha,
    medianDurationMs: positiveFinite,
  }),
  ratio: positiveFinite,
  confidenceInterval: Schema.Struct({
    lowRatio: positiveFinite,
    highRatio: positiveFinite,
    confidence: positiveFinite,
  }),
  rounds: positiveInt,
});

const SeedRunHistory = Schema.NonEmptyArray(
  Schema.Struct({
    durationMs: positiveFinite,
    testCount: positiveInt,
    sha: PerformanceIssueFilerModule.GitCommitSha,
    startedAt: Schema.DateTimeUtcFromString,
    workflowRunUrl: Schema.String,
  }),
).check(Schema.isMaxLength(20));

const TestTimingReport = Schema.Struct({
  testFiles: Schema.NonEmptyArray(
    Schema.Struct({
      path: Schema.String.check(Schema.isNonEmpty()),
      durationMs: positiveFinite,
      testCount: positiveInt,
    }),
  ),
});

class TestPerformanceEntryError extends Data.TaggedError("TestPerformanceEntryError")<{
  readonly reason: "arguments" | "capped" | "history" | "report" | "repository" | "workflow-run-url";
  readonly message: string;
}> {}

const comparisonReportError = (message: string) =>
  new TestPerformanceEntryError({ reason: "report", message: `invalid comparison report: ${message}` });

const timingReportError = (message: string) =>
  new TestPerformanceEntryError({ reason: "report", message: `invalid timing report: ${message}` });

const decodeReport = (value: unknown) =>
  Schema.decodeUnknownEffect(SuiteComparisonReport)(value).pipe(
    Effect.mapError((error) => comparisonReportError(error.message)),
  );

const decodeReportJson = (value: string) =>
  Schema.decodeEffect(Schema.fromJsonString(SuiteComparisonReport))(value).pipe(
    Effect.mapError((error) => comparisonReportError(error.message)),
  );

const historyError = (message: string) =>
  new TestPerformanceEntryError({ reason: "history", message: `invalid seed-run history: ${message}` });

const decodeHistory = (value: unknown) =>
  Schema.decodeUnknownEffect(SeedRunHistory)(value).pipe(
    Effect.mapError((error) => historyError(error.message)),
  );

const decodeHistoryJson = (value: string) =>
  Schema.decodeEffect(Schema.fromJsonString(SeedRunHistory))(value).pipe(
    Effect.mapError((error) => historyError(error.message)),
  );

const decodeTimingReportJson = (value: string) =>
  Schema.decodeEffect(Schema.fromJsonString(TestTimingReport))(value).pipe(
    Effect.mapError((error) => timingReportError(error.message)),
  );

const decodeEntryArguments = (args: ReadonlyArray<string>) =>
  Schema.decodeUnknownEffect(Schema.Tuple([Schema.String, Schema.String]))(args).pipe(
    Effect.mapError(
      (error) =>
        new TestPerformanceEntryError({
          reason: "arguments",
          message: `invalid arguments: ${error.message}`,
        }),
    ),
  );

const decodeBudgetEntryArguments = (args: ReadonlyArray<string>) =>
  Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Literal("--budget"), Schema.String, Schema.String, Schema.String]),
  )(args).pipe(
    Effect.mapError(
      (error) =>
        new TestPerformanceEntryError({
          reason: "arguments",
          message: `invalid budget arguments: ${error.message}`,
        }),
    ),
  );

const decodeRepository = (repository: string) => {
  const repositoryRef = GitHub.repoRefFromRepository(repository);
  if (repositoryRef) return Effect.succeed(repositoryRef);
  return new TestPerformanceEntryError({
    reason: "repository",
    message: `invalid GITHUB_REPOSITORY value ${repository}`,
  });
};

const normalizeWorkflowRunUrl = (value: string, repository: GitHub.GitHubRepoRef) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      const [owner, name, actions, runs, runId, extra] = url.pathname.split("/").filter(Boolean);
      const expectedRepository = `${repository.owner}/${repository.name}`;
      const matchesRepository = `${owner}/${name}`.toLowerCase() === expectedRepository.toLowerCase();
      const isExpectedWorkflowRun =
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        matchesRepository &&
        actions === "actions" &&
        runs === "runs" &&
        /^[1-9]\d*$/.test(runId ?? "") &&
        extra === undefined;
      if (!isExpectedWorkflowRun) throw new Error("unexpected workflow run URL");
      return PerformanceIssueFilerModule.GitHubWorkflowRunUrl.make(url.href);
    },
    catch: () =>
      new TestPerformanceEntryError({
        reason: "workflow-run-url",
        message: `workflow run link must identify a run for ${repository.owner}/${repository.name}`,
      }),
  });

const suiteComparisonVerdict = (
  report: typeof SuiteComparisonReport.Type,
  workflowRunUrl: PerformanceIssueFilerModule.GitHubWorkflowRunUrl,
) =>
  ({
    kind: "suite-comparison",
    signal: "test-suite-duration",
    subsystem: "repository",
    direction: "slower",
    base: {
      medianDurationMs: report.base.medianDurationMs,
      sha: report.base.sha,
    },
    head: {
      medianDurationMs: report.head.medianDurationMs,
      sha: report.head.sha,
    },
    ratio: report.ratio,
    confidenceInterval: report.confidenceInterval,
    rounds: report.rounds,
    workflowRunUrl,
  }) satisfies PerformanceIssueFilerModule.PerformanceVerdict;

const median = (values: Arr.NonEmptyReadonlyArray<number>) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const submitVerdict = Effect.fn("PerformanceEntry.submitVerdict")(function* (
  verdict: PerformanceIssueFilerModule.PerformanceVerdict,
  atMillis: number,
) {
  const filer = yield* PerformanceIssueFilerModule.PerformanceIssueFiler;
  const result = yield* filer.submit(verdict, atMillis);
  if (result !== "capped") return result;
  return yield* new TestPerformanceEntryError({
    reason: "capped",
    message: "performance issue filing reached its daily cap",
  });
});

const submitSuiteComparison = Effect.fn("SuiteComparisonEntry.submit")(function* (input: {
  readonly report: typeof SuiteComparisonReport.Type;
  readonly repository: GitHub.GitHubRepoRef;
  readonly workflowRunUrl: string;
  readonly atMillis: number;
}) {
  const isMaterialRegression =
    input.report.verdict === "slower" && input.report.ratio >= materialRegressionRatio;
  if (!isMaterialRegression) return "skipped" as const;

  const workflowRunUrl = yield* normalizeWorkflowRunUrl(input.workflowRunUrl, input.repository);
  return yield* submitVerdict(suiteComparisonVerdict(input.report, workflowRunUrl), input.atMillis);
});

export const fileSuiteComparison = Effect.fn("SuiteComparisonEntry.file")(function* (input: {
  readonly report: unknown;
  readonly repository: string;
  readonly workflowRunUrl: string;
  readonly atMillis: number;
}) {
  const report = yield* decodeReport(input.report);
  const repository = yield* decodeRepository(input.repository);
  return yield* submitSuiteComparison({ ...input, report, repository });
});

const submitTestSuiteBudget = Effect.fn("TestSuiteBudgetEntry.submit")(function* (input: {
  readonly history: typeof SeedRunHistory.Type;
  readonly repository: GitHub.GitHubRepoRef;
  readonly atMillis: number;
}) {
  const window = yield* Effect.forEach(input.history, (run) =>
    normalizeWorkflowRunUrl(run.workflowRunUrl, input.repository).pipe(
      Effect.map((workflowRunUrl) => ({
        ...run,
        workflowRunUrl,
      })),
    ),
  );

  const observed = median(Arr.map(window, (run) => run.durationMs / run.testCount));
  if (observed <= testSuiteBudgetMsPerTest) return "skipped" as const;

  return yield* submitVerdict(
    {
      kind: "budget",
      signal: "test-suite-ms-per-test",
      subsystem: "repository",
      direction: "above",
      observed,
      budget: testSuiteBudgetMsPerTest,
      unit: "ms/test",
      window,
    },
    input.atMillis,
  );
});

export const fileTestSuiteBudget = Effect.fn("TestSuiteBudgetEntry.file")(function* (input: {
  readonly history: unknown;
  readonly repository: string;
  readonly atMillis: number;
}) {
  const history = yield* decodeHistory(input.history);
  const repository = yield* decodeRepository(input.repository);
  return yield* submitTestSuiteBudget({ ...input, history, repository });
});

export const submitTestFileBudget = Effect.fn("TestFileBudgetEntry.submit")(function* (input: {
  readonly report: typeof TestTimingReport.Type;
  readonly repository: GitHub.GitHubRepoRef;
  readonly workflowRunUrl: string;
  readonly atMillis: number;
}) {
  const slowest = input.report.testFiles.reduce((current, testFile) =>
    testFile.durationMs > current.durationMs ? testFile : current,
  );
  if (slowest.durationMs <= slowestTestFileBudgetMs) return "skipped" as const;

  const workflowRunUrl = yield* normalizeWorkflowRunUrl(input.workflowRunUrl, input.repository);
  return yield* submitVerdict(
    {
      kind: "test-file-budget",
      signal: "test-file-duration",
      subsystem: "repository",
      direction: "above",
      observed: slowest.durationMs,
      budget: slowestTestFileBudgetMs,
      unit: "ms",
      testFilePath: slowest.path,
      testCount: slowest.testCount,
      workflowRunUrl,
    },
    input.atMillis,
  );
});

const makeFiler = Effect.fn("TestPerformanceEntry.makeFiler")(function* (repository: GitHub.GitHubRepoRef) {
  const client = yield* GitHub.GitHubClient;
  const target = yield* GitHub.makePerformanceIssueFilerTarget(client, repository, "origin-label-only");
  return yield* PerformanceIssueFilerModule.make({ codec: wireCodec, target: Effect.succeed(target) });
});

const runComparisonEntry = Effect.fn("SuiteComparisonEntry.run")(function* (args: ReadonlyArray<string>) {
  const [reportPath, workflowRunUrl] = yield* decodeEntryArguments(args);
  const fileSystem = yield* FileSystem.FileSystem;
  const report = yield* fileSystem.readFileString(reportPath).pipe(Effect.flatMap(decodeReportJson));
  const repository = yield* Config.string("GITHUB_REPOSITORY").pipe(Effect.flatMap(decodeRepository));
  const filer = yield* makeFiler(repository);
  const atMillis = yield* Clock.currentTimeMillis;
  const result = yield* submitSuiteComparison({ report, repository, workflowRunUrl, atMillis }).pipe(
    Effect.provideService(PerformanceIssueFilerModule.PerformanceIssueFiler, filer),
  );
  yield* Console.log(result);
});

const runBudgetEntry = Effect.fn("TestSuiteBudgetEntry.run")(function* (args: ReadonlyArray<string>) {
  const [, historyPath, reportPath, workflowRunUrl] = yield* decodeBudgetEntryArguments(args);
  const fileSystem = yield* FileSystem.FileSystem;
  const history = yield* fileSystem.readFileString(historyPath).pipe(Effect.flatMap(decodeHistoryJson));
  const report = yield* fileSystem.readFileString(reportPath).pipe(Effect.flatMap(decodeTimingReportJson));
  const repository = yield* Config.string("GITHUB_REPOSITORY").pipe(Effect.flatMap(decodeRepository));
  const filer = yield* makeFiler(repository);
  const atMillis = yield* Clock.currentTimeMillis;
  const results = yield* Effect.all([
    submitTestSuiteBudget({ history, repository, atMillis }),
    submitTestFileBudget({ report, repository, workflowRunUrl, atMillis }),
  ]).pipe(Effect.provideService(PerformanceIssueFilerModule.PerformanceIssueFiler, filer));
  yield* Console.log(results.join("\n"));
});

const runEntry = (args: ReadonlyArray<string>) =>
  args[0] === "--budget" ? runBudgetEntry(args) : runComparisonEntry(args);

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  NodeRuntime.runMain(
    runEntry(process.argv.slice(2)).pipe(
      Effect.provide(
        Layer.mergeAll(NodeFileSystem.layer, GitHub.clientLayer.pipe(Layer.provide(FetchHttpClient.layer))),
      ),
    ),
  );
}
