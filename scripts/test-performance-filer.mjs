#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const dailyFilingCap = 1;
const originLabel = "origin:selfperf";
const signal = "test-suite-duration";
const subsystem = "repository";
const usage = "Usage: node scripts/test-performance-filer.mjs <comparison-report.json> <workflow-run-url>";
const markerPattern = /<!--\s*cogwork:([^>]*)-->/g;

const describe = (error) => (error instanceof Error ? error.message : String(error));

const requireFinitePositive = (value, name) => {
  if (Number.isFinite(value) && value > 0) return;
  throw new Error(`${name} must be a finite positive number`);
};

const requireSha = (value, name) => {
  if (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)) return;
  throw new Error(`${name} must be a full commit SHA`);
};

const requireObject = (value, message) => {
  if (typeof value === "object" && value !== null) return value;
  throw new Error(message);
};

const requireReport = (value) => {
  const report = requireObject(value, "comparison report must be an object");
  if (!["slower", "faster", "inconclusive"].includes(report.verdict)) {
    throw new Error("comparison report has an invalid verdict");
  }
  const base = requireObject(report.base, "comparison report needs a base");
  const head = requireObject(report.head, "comparison report needs a head");
  const confidenceInterval = requireObject(
    report.confidenceInterval,
    "comparison report needs a confidence interval",
  );
  requireSha(base.sha, "base SHA");
  requireSha(head.sha, "head SHA");
  requireFinitePositive(base.medianDurationMs, "base median");
  requireFinitePositive(head.medianDurationMs, "head median");
  requireFinitePositive(report.ratio, "ratio");
  requireFinitePositive(confidenceInterval.lowRatio, "confidence interval lower bound");
  requireFinitePositive(confidenceInterval.highRatio, "confidence interval upper bound");
  requireFinitePositive(confidenceInterval.confidence, "confidence");
  if (!Number.isInteger(report.rounds) || report.rounds <= 0)
    throw new Error("rounds must be a positive integer");
  return report;
};

const normalizeIdentityPart = (value) => {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("fingerprint parts must be non-empty");
  return encodeURIComponent(value.trim().toLowerCase());
};

const normalizeRunUrl = (value) => {
  const url = new URL(value);
  if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  throw new Error("workflow run link must be an HTTP URL");
};

export const fingerprintFor = ({ signal, subsystem, direction }) =>
  [signal, subsystem, direction].map(normalizeIdentityPart).join(":");

export const performanceFingerprint = (report) =>
  fingerprintFor({ signal, subsystem, direction: report.verdict });

export const fingerprintMarker = (fingerprint) =>
  `<!-- cogwork:selfperf fingerprint=${normalizeIdentityPart(fingerprint)} -->`;

const markerFingerprint = (body) =>
  [...body.matchAll(markerPattern)]
    .map((match) => (match[1] ?? "").trim().split(/\s+/))
    .filter(([name]) => name === "selfperf")
    .flatMap(([, ...pairs]) => pairs)
    .map((pair) => pair.split("="))
    .find(([name]) => name === "fingerprint")?.[1];

const matchingIssues = (issues, fingerprint) =>
  issues.filter((issue) => markerFingerprint(issue.body) === normalizeIdentityPart(fingerprint));

const latestIssue = (issues) =>
  issues.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

const percent = (probability) => `${probability * 100}%`;

const evidence = (report, runUrl) =>
  [
    "Signal: Test suite duration — repository — slower",
    "",
    `- Baseline median: ${report.base.medianDurationMs} ms`,
    `- Current median: ${report.head.medianDurationMs} ms`,
    `- Ratio: ${report.ratio}`,
    `- ${percent(report.confidenceInterval.confidence)} confidence interval: ${report.confidenceInterval.lowRatio}–${report.confidenceInterval.highRatio}`,
    `- Rounds: ${report.rounds}`,
    `- Baseline commit: ${report.base.sha}`,
    `- Current commit: ${report.head.sha}`,
    `- Measurement run: ${runUrl}`,
  ].join("\n");

const issueBody = (report, runUrl, fingerprint, previous) =>
  [
    evidence(report, runUrl),
    previous ? `Previous occurrence: #${previous.number}` : undefined,
    fingerprintMarker(fingerprint),
  ]
    .filter(Boolean)
    .join("\n\n");

const recurrenceComment = (report, runUrl) => `Fired again.\n\n${evidence(report, runUrl)}`;

const filedToday = (issues, now) => {
  const utcDay = now.toISOString().slice(0, 10);
  return issues.filter((issue) => issue.createdAt.slice(0, 10) === utcDay).length;
};

export const fileTestPerformanceRegression = async ({ report: input, runUrl, now = new Date() }, tracker) => {
  const report = requireReport(input);
  const normalizedRunUrl = normalizeRunUrl(runUrl);
  if (report.verdict !== "slower") return { action: "skipped", reason: report.verdict };

  const fingerprint = performanceFingerprint(report);
  const issues = await tracker.listSelfPerformanceIssues();
  const matches = matchingIssues(issues, fingerprint);
  const open = latestIssue(matches.filter((issue) => issue.state === "open"));
  if (open) {
    await tracker.commentOnIssue(open.number, recurrenceComment(report, normalizedRunUrl));
    return { action: "commented", number: open.number };
  }

  if (filedToday(issues, now) >= dailyFilingCap) return { action: "skipped", reason: "daily-cap" };

  const previous = latestIssue(matches.filter((issue) => issue.state === "closed"));
  const created = await tracker.createIssue({
    title: previous ? "Test suite performance regressed again" : "Test suite performance regressed",
    body: issueBody(report, normalizedRunUrl, fingerprint, previous),
    labels: ["needs-triage", originLabel],
  });
  return { action: "created", number: created.number };
};

const runGh = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve(stdout.join(""));
      reject(new Error(stderr.join("").trim() || `gh exited with code ${code}`));
    });
    child.stdin.end(input);
  });

const ghJson = async (args, input) => JSON.parse(await runGh(args, input));

const githubTracker = {
  listSelfPerformanceIssues: async () => {
    const pages = await ghJson([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      "repos/{owner}/{repo}/issues",
      "-f",
      "state=all",
      "-f",
      `labels=${originLabel}`,
      "-f",
      "per_page=100",
    ]);
    return pages
      .flat()
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        state: issue.state,
        body: issue.body ?? "",
        createdAt: issue.created_at,
        url: issue.html_url,
      }));
  },
  createIssue: (issue) =>
    ghJson(
      ["api", "--method", "POST", "repos/{owner}/{repo}/issues", "--input", "-"],
      JSON.stringify({ title: issue.title, body: issue.body, labels: issue.labels }),
    ),
  commentOnIssue: async (number, body) => {
    await ghJson(
      ["api", "--method", "POST", `repos/{owner}/{repo}/issues/${number}/comments`, "--input", "-"],
      JSON.stringify({ body }),
    );
  },
};

const main = async () => {
  const [reportPath, runUrl, ...extra] = process.argv.slice(2);
  if (!reportPath || !runUrl || extra.length > 0) throw new Error(usage);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const result = await fileTestPerformanceRegression({ report, runUrl }, githubTracker);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(describe(error));
    process.exitCode = 1;
  });
}
