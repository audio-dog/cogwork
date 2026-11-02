import { HarnessName, RunId, RunPlan } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  compareReplayReports,
  decodeReplayFixture,
  decodeReplayReport,
  encodeReplayFixture,
  ReplayCounts,
  ReplayFixture,
  ReplayReport,
  type ReplaySpeed,
  replayFixtureEvents,
  replayRunner,
} from "./replay-harness";

const runId = Schema.decodeSync(RunId);
const reportVersion = Schema.decodeSync(Schema.Literal(1))(1);
const reportSpeed: ReplaySpeed = "8x";
const replayHarnessName = Schema.decodeSync(HarnessName)("replay");

const fixture = ReplayFixture.make({
  version: reportVersion,
  sourceRunId: runId("source-run"),
  events: [
    {
      seq: 0,
      type: "RUN_STARTED",
      name: null,
      data: '{"type":"RUN_STARTED","threadId":"thread","runId":"run"}',
      atMillis: 1_000,
    },
    {
      seq: 1,
      type: "TEXT_MESSAGE_CONTENT",
      name: null,
      data: '{"type":"TEXT_MESSAGE_CONTENT","messageId":"message","delta":"hello"}',
      atMillis: 1_600,
    },
  ],
});

const replayRequest = (speed: ReplaySpeed) => ({
  plan: Schema.decodeSync(RunPlan)({
    id: "run-replay-test",
    operation: "implement",
    harness: { name: replayHarnessName, model: "fixture", options: { speed }, profile: "read-only" },
    instructions: [],
    operatingInstructions: {
      name: "implement-agent",
      path: "/operating-instructions/implement-agent",
      resources: [],
    },
    tools: [],
    skills: [],
    mcp: [],
    subagents: [],
    commands: [],
    hooks: [],
    middleware: [],
    structuredOutput: null,
    connections: [],
    messages: [{ role: "user", content: "replay the fixture" }],
    workContext: {
      reference: { workItem: "#690", url: null },
      prose: { body: "", comments: [] },
      facts: {
        assignees: [],
        openBlockers: 0,
        claim: null,
        priority: "medium",
      },
      observation: { generation: 1, observedAtMillis: 1 },
    },
    sandbox: { workspace: "/repo", policy: "full" },
    persistence: { sessionKind: "owned-transcript" },
    provenance: {
      resolution: [],
      stamps: [],
      projectedNames: [],
      projection: [],
      observation: { generation: 1, observedAtMillis: 1 },
    },
  }),
  session: null,
  mcpCredentials: new Map(),
});

const counts = (eventsProcessed: number) =>
  ReplayCounts.make({
    eventsProcessed,
    sqliteInserts: eventsProcessed,
    ipcFrames: eventsProcessed,
    bytes: eventsProcessed * 100,
    eventBusDrops: 0,
  });

const rawReport = (observations: ReadonlyArray<number>, reportCounts = counts(16)) => ({
  version: reportVersion,
  fixture: "fixture.json",
  fixtureDigest: `sha256:${"0".repeat(64)}`,
  concurrency: 8,
  speed: reportSpeed,
  warmupMillis: Array.from({ length: 10 }, () => 100),
  samples: observations.map((elapsedMillis) => ({ counts: reportCounts, elapsedMillis })),
});

const report = (observations: ReadonlyArray<number>, reportCounts = counts(16)) =>
  ReplayReport.make({
    ...rawReport(observations, reportCounts),
  });

describe("replay fixture", () => {
  it.effect("preserves exported run-event timestamps and payloads", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeReplayFixture(yield* encodeReplayFixture(fixture));

      assert.deepStrictEqual(decoded, fixture);
    }),
  );

  it.effect("rejects empty fixtures and invalid embedded events", () =>
    Effect.gen(function* () {
      const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const empty = yield* encodeJson({ version: 1, sourceRunId: "source-run", events: [] });
      const invalid = yield* encodeJson({
        version: 1,
        sourceRunId: "source-run",
        events: [{ ...fixture.events[0], data: "{}" }],
      });

      yield* Effect.flip(decodeReplayFixture(empty));
      yield* Effect.flip(decodeReplayFixture(invalid));
    }),
  );

  it.effect("publishes and honors the selected fixture speed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-replay-" });
      const fixturePath = path.join(directory, "fixture.json");
      yield* fs.writeFileString(fixturePath, yield* encodeReplayFixture(fixture));
      const runner = yield* replayRunner({
        name: replayHarnessName,
        fixturePath: Effect.succeed(fixturePath),
      });
      const speed = runner.catalog.models[0]?.options?.find(({ id }) => id === "speed");
      assert.deepStrictEqual(speed, {
        type: "select",
        id: "speed",
        label: "Speed",
        values: ["1x", "2x", "4x", "6x", "8x", "unpaced"].map((value) => ({ value, label: value })),
        defaultValue: "1x",
      });
      assert.strictEqual((yield* runner.readiness()).operational.status, "ready");
      const fiber = yield* runner
        .run(replayRequest("2x"))
        .pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("299 millis");
      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(
        Array.from(yield* Fiber.join(fiber)).map((event) => event.type),
        ["RUN_STARTED", "TEXT_MESSAGE_CONTENT"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps event counts deterministic across eight concurrent replays", () =>
    Effect.gen(function* () {
      const runs = yield* Effect.all(
        Array.from({ length: 8 }, () => replayFixtureEvents(fixture, Infinity).pipe(Stream.runCount)),
        { concurrency: "unbounded" },
      );

      assert.deepStrictEqual(
        runs,
        Array.from({ length: 8 }, () => 2),
      );
    }),
  );

  it.effect("retries failed fixture loads and caches a successful load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-replay-" });
      const fixturePath = path.join(directory, "fixture.json");
      const runner = yield* replayRunner({
        name: replayHarnessName,
        fixturePath: Effect.succeed(fixturePath),
      });

      assert.strictEqual((yield* runner.readiness()).operational.status, "unavailable");
      yield* fs.writeFileString(fixturePath, yield* encodeReplayFixture(fixture));
      assert.strictEqual((yield* runner.readiness()).operational.status, "ready");
      yield* fs.remove(fixturePath);
      assert.strictEqual((yield* runner.readiness()).operational.status, "ready");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("replay scoring", () => {
  it.effect("rejects reports with more than one thousand measured runs", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        rawReport(Array.from({ length: 1_001 }, () => 100)),
      );
      const error = yield* Effect.flip(decodeReplayReport(encoded));

      assert.match(error.message, /between 10 and 1000/);
    }),
  );

  it.effect("reports counts before inconclusive timings for equivalent runs", () =>
    Effect.gen(function* () {
      const comparison = yield* compareReplayReports(
        report([100, 101, 99, 102, 98, 100, 101, 99, 100, 100]),
        report([101, 100, 100, 99, 102, 98, 100, 101, 99, 100]),
      );

      assert.strictEqual(comparison.counts.status, "equal");
      assert.strictEqual(comparison.timings.status, "inconclusive");
    }),
  );

  it.effect("fails count equality when a deterministic count changes", () =>
    Effect.gen(function* () {
      const comparison = yield* compareReplayReports(
        report(Array.from({ length: 10 }, () => 100)),
        report(
          Array.from({ length: 10 }, () => 100),
          counts(15),
        ),
      );

      assert.strictEqual(comparison.counts.status, "changed");
      assert.deepStrictEqual(comparison.counts.metrics.eventsProcessed, {
        base: 16,
        head: 15,
        status: "changed",
      });
    }),
  );

  it.effect("rejects reports with fewer than ten measured runs", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        rawReport(Array.from({ length: 9 }, () => 100)),
      );
      const error = yield* Effect.flip(decodeReplayReport(encoded));

      assert.match(error.message, /between 10 and 1000/);
    }),
  );

  it.effect("rejects reports from different replay conditions", () =>
    Effect.gen(function* () {
      const base = report(Array.from({ length: 10 }, () => 100));
      const head = ReplayReport.make({ ...base, concurrency: 6 });
      const error = yield* Effect.flip(compareReplayReports(base, head));

      assert.match(error.message, /same concurrency/);
    }),
  );

  it.effect("keeps changes inside the runtimeperf bands inconclusive", () =>
    Effect.gen(function* () {
      const base = report(Array.from({ length: 10 }, () => 100));
      const improvement = yield* compareReplayReports(base, report(Array.from({ length: 10 }, () => 98)));
      const regression = yield* compareReplayReports(base, report(Array.from({ length: 10 }, () => 105)));

      assert.strictEqual(improvement.timings.status, "inconclusive");
      assert.strictEqual(regression.timings.status, "inconclusive");
    }),
  );

  it.effect("classifies changes outside the runtimeperf bands", () =>
    Effect.gen(function* () {
      const base = report(Array.from({ length: 10 }, () => 100));
      const improvement = yield* compareReplayReports(base, report(Array.from({ length: 10 }, () => 80)));
      const regression = yield* compareReplayReports(base, report(Array.from({ length: 10 }, () => 120)));

      assert.strictEqual(improvement.timings.status, "improvement");
      assert.strictEqual(regression.timings.status, "regression");
    }),
  );

  it.effect("keeps bootstrap results invariant when paired ratios are reordered", () =>
    Effect.gen(function* () {
      const base = report(Array.from({ length: 10 }, () => 100));
      const alternating = yield* compareReplayReports(
        base,
        report([120, 80, 120, 80, 120, 80, 120, 80, 120, 80]),
      );
      const grouped = yield* compareReplayReports(
        base,
        report([120, 80, 80, 120, 120, 120, 120, 80, 80, 80]),
      );

      assert.deepStrictEqual(alternating.timings, grouped.timings);
      assert.strictEqual(grouped.timings.status, "inconclusive");
    }),
  );
});
