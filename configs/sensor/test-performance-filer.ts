#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { GitHub, PerformanceIssueFiler as PerformanceIssueFilerModule } from "@cogwork/engine";
import { wireCodec } from "@cogwork/engine/github/markers";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
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
  rounds: Schema.Int.check(Schema.isGreaterThan(0)),
});

class SuiteComparisonEntryError extends Data.TaggedError("SuiteComparisonEntryError")<{
  readonly reason: "arguments" | "capped" | "report" | "repository" | "workflow-run-url";
  readonly message: string;
}> {}

const reportError = (message: string) =>
  new SuiteComparisonEntryError({ reason: "report", message: `invalid comparison report: ${message}` });

const decodeReport = (value: unknown) =>
  Schema.decodeUnknownEffect(SuiteComparisonReport)(value).pipe(
    Effect.mapError((error) => reportError(error.message)),
  );

const decodeReportJson = (value: string) =>
  Schema.decodeEffect(Schema.fromJsonString(SuiteComparisonReport))(value).pipe(
    Effect.mapError((error) => reportError(error.message)),
  );

const decodeEntryArguments = (args: ReadonlyArray<string>) =>
  Schema.decodeUnknownEffect(Schema.Tuple([Schema.String, Schema.String]))(args).pipe(
    Effect.mapError(
      (error) =>
        new SuiteComparisonEntryError({
          reason: "arguments",
          message: `invalid arguments: ${error.message}`,
        }),
    ),
  );

const decodeRepository = (repository: string) => {
  const repositoryRef = GitHub.repoRefFromRepository(repository);
  if (repositoryRef) return Effect.succeed(repositoryRef);
  return new SuiteComparisonEntryError({
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
      new SuiteComparisonEntryError({
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

const submitSuiteComparison = Effect.fn("SuiteComparisonEntry.submit")(function* (input: {
  readonly report: typeof SuiteComparisonReport.Type;
  readonly repository: GitHub.GitHubRepoRef;
  readonly workflowRunUrl: string;
  readonly atMillis: number;
}) {
  if (input.report.verdict !== "slower") return "skipped" as const;

  const workflowRunUrl = yield* normalizeWorkflowRunUrl(input.workflowRunUrl, input.repository);
  const filer = yield* PerformanceIssueFilerModule.PerformanceIssueFiler;
  const result = yield* filer.submit(suiteComparisonVerdict(input.report, workflowRunUrl), input.atMillis);
  if (result !== "capped") return result;
  return yield* new SuiteComparisonEntryError({
    reason: "capped",
    message: "performance issue filing reached its daily cap",
  });
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

const makeFiler = Effect.fn("SuiteComparisonEntry.make")(function* (repository: GitHub.GitHubRepoRef) {
  const client = yield* GitHub.GitHubClient;
  const target = yield* GitHub.makePerformanceIssueFilerTarget(client, repository, "origin-label-only");
  return yield* PerformanceIssueFilerModule.make({ codec: wireCodec, target: Effect.succeed(target) });
});

const runEntry = Effect.fn("SuiteComparisonEntry.run")(function* (args: ReadonlyArray<string>) {
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
