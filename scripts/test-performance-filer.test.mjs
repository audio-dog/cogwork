import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fileTestPerformanceRegression,
  fingerprintFor,
  fingerprintMarker,
  performanceFingerprint,
} from "./test-performance-filer.mjs";

const runUrl = "https://github.com/colonylabs/cogwork/actions/runs/123";
const now = new Date("2026-09-09T12:00:00Z");

const report = ({
  verdict = "slower",
  baseMedianDurationMs = 100,
  headMedianDurationMs = 120,
  ratio = 1.2,
} = {}) => ({
  schemaVersion: 1,
  verdict,
  base: {
    ref: "baseline",
    sha: "1111111111111111111111111111111111111111",
    medianDurationMs: baseMedianDurationMs,
    testCount: 1_800,
  },
  head: {
    ref: "main",
    sha: "2222222222222222222222222222222222222222",
    medianDurationMs: headMedianDurationMs,
    testCount: 1_800,
  },
  ratio,
  confidenceInterval: { lowRatio: 1.1, highRatio: 1.3, confidence: 0.95 },
  rounds: 5,
  seed: 0x5eed1234,
});

const makeTracker = (issues = []) => {
  const created = [];
  const comments = [];
  return {
    created,
    comments,
    tracker: {
      listSelfPerformanceIssues: async () => issues,
      createIssue: async (issue) => {
        created.push(issue);
        return { number: 500, url: "https://github.com/colonylabs/cogwork/issues/500" };
      },
      commentOnIssue: async (number, body) => {
        comments.push({ number, body });
      },
    },
  };
};

describe("test-performance filer", () => {
  it("files one thin evidence issue for a new slower regression", async () => {
    const { tracker, created, comments } = makeTracker();

    const result = await fileTestPerformanceRegression({ report: report(), runUrl, now }, tracker);

    assert.deepEqual(result, { action: "created", number: 500 });
    assert.equal(created.length, 1);
    assert.equal(comments.length, 0);
    assert.deepEqual(created[0].labels, ["needs-triage", "origin:selfperf"]);
    assert.match(created[0].body, /^Signal: Test suite duration — repository — slower$/m);
    assert.match(created[0].body, /Baseline median: 100 ms/);
    assert.match(created[0].body, /Current median: 120 ms/);
    assert.match(created[0].body, /Ratio: 1\.2/);
    assert.match(created[0].body, /95% confidence interval: 1\.1–1\.3/);
    assert.match(created[0].body, /Rounds: 5/);
    assert.match(created[0].body, /1111111111111111111111111111111111111111/);
    assert.match(created[0].body, /2222222222222222222222222222222222222222/);
    assert.match(created[0].body, new RegExp(runUrl));
    assert.match(created[0].body, /<!-- cogwork:selfperf fingerprint=/);
  });

  it("comments with fresh evidence when the regression already has an open issue", async () => {
    const current = report({ baseMedianDurationMs: 130, headMedianDurationMs: 170, ratio: 1.307 });
    const existing = {
      number: 42,
      state: "open",
      body: "<!-- cogwork:selfperf fingerprint=test-suite-duration%3Arepository%3Aslower -->",
      createdAt: "2026-09-01T12:00:00Z",
      url: "https://github.com/colonylabs/cogwork/issues/42",
    };
    const { tracker, created, comments } = makeTracker([existing]);

    const result = await fileTestPerformanceRegression({ report: current, runUrl, now }, tracker);

    assert.deepEqual(result, { action: "commented", number: 42 });
    assert.equal(created.length, 0);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].number, 42);
    assert.match(comments[0].body, /^Fired again\.$/m);
    assert.match(comments[0].body, /Baseline median: 130 ms/);
    assert.match(comments[0].body, /Current median: 170 ms/);
    assert.match(comments[0].body, /Ratio: 1\.307/);
  });

  it("cross-links a closed occurrence without reopening it", async () => {
    const current = report();
    const closed = {
      number: 41,
      state: "closed",
      body: "<!-- cogwork:selfperf fingerprint=test-suite-duration%3Arepository%3Aslower -->",
      createdAt: "2026-08-01T12:00:00Z",
      url: "https://github.com/colonylabs/cogwork/issues/41",
    };
    const { tracker, created, comments } = makeTracker([closed]);

    const result = await fileTestPerformanceRegression({ report: current, runUrl, now }, tracker);

    assert.deepEqual(result, { action: "created", number: 500 });
    assert.equal(created.length, 1);
    assert.match(created[0].title, /again/i);
    assert.match(created[0].body, /Previous occurrence: #41/);
    assert.equal(comments.length, 0);
  });

  it("enforces the daily filing cap from tracker state", async () => {
    const existing = {
      number: 40,
      state: "closed",
      body: fingerprintMarker(
        fingerprintFor({ signal: "daemon-heap", subsystem: "engine", direction: "higher" }),
      ),
      createdAt: "2026-09-09T01:00:00Z",
      url: "https://github.com/colonylabs/cogwork/issues/40",
    };
    const { tracker, created, comments } = makeTracker([existing]);

    const result = await fileTestPerformanceRegression({ report: report(), runUrl, now }, tracker);

    assert.deepEqual(result, { action: "skipped", reason: "daily-cap" });
    assert.equal(created.length, 0);
    assert.equal(comments.length, 0);
  });

  it("serializes concurrent filings for the same tracker", async () => {
    const issues = [];
    const comments = [];
    const tracker = {
      listSelfPerformanceIssues: async () => [...issues],
      createIssue: async (issue) => {
        const created = {
          ...issue,
          number: 500,
          state: "open",
          createdAt: now.toISOString(),
          url: "https://github.com/colonylabs/cogwork/issues/500",
        };
        issues.push(created);
        return created;
      },
      commentOnIssue: async (number, body) => comments.push({ number, body }),
    };

    const results = await Promise.all([
      fileTestPerformanceRegression({ report: report(), runUrl, now }, tracker),
      fileTestPerformanceRegression({ report: report({ ratio: 1.3 }), runUrl, now }, tracker),
    ]);

    assert.deepEqual(results, [
      { action: "created", number: 500 },
      { action: "commented", number: 500 },
    ]);
    assert.equal(issues.length, 1);
    assert.equal(comments.length, 1);
  });

  it("does nothing for faster or inconclusive verdicts", async () => {
    const faster = makeTracker();
    const inconclusive = makeTracker();

    const results = await Promise.all([
      fileTestPerformanceRegression({ report: report({ verdict: "faster" }), runUrl, now }, faster.tracker),
      fileTestPerformanceRegression(
        { report: report({ verdict: "inconclusive" }), runUrl, now },
        inconclusive.tracker,
      ),
    ]);

    assert.deepEqual(results, [
      { action: "skipped", reason: "faster" },
      { action: "skipped", reason: "inconclusive" },
    ]);
    assert.equal(faster.created.length + faster.comments.length, 0);
    assert.equal(inconclusive.created.length + inconclusive.comments.length, 0);
  });

  it("publishes only normalized HTTP run links", async () => {
    const injectedRunUrl = `${runUrl}\n\n@colonylabs/security ping`;
    const { tracker, created } = makeTracker();

    await fileTestPerformanceRegression({ report: report(), runUrl: injectedRunUrl, now }, tracker);

    assert.doesNotMatch(created[0].body, /\n@colonylabs\/security/);
    assert.match(created[0].body, /actions\/runs\/123@colonylabs\/security%20ping/);
    await assert.rejects(
      fileTestPerformanceRegression({ report: report(), runUrl: "javascript:alert(1)", now }, tracker),
      /HTTP URL/,
    );
  });

  it("keeps measurements out of stable regression identity", () => {
    assert.equal(
      performanceFingerprint(report({ ratio: 1.2 })),
      performanceFingerprint(report({ ratio: 2.4 })),
    );
    assert.notEqual(
      fingerprintFor({ signal: "test-suite-duration", subsystem: "repository", direction: "slower" }),
      fingerprintFor({ signal: "test-count", subsystem: "repository", direction: "slower" }),
    );
    assert.notEqual(
      fingerprintFor({ signal: "test-suite-duration", subsystem: "repository", direction: "slower" }),
      fingerprintFor({ signal: "test-suite-duration", subsystem: "repository", direction: "faster" }),
    );
  });
});
