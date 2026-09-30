#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const measurementPath = process.argv[2];

if (!measurementPath) throw new Error("Usage: test-measure-summary <measurement.json>");

const formatSeconds = (durationMs) => `${(durationMs / 1_000).toFixed(3)} s`;
const formatCount = (testCount) => testCount.toLocaleString("en-US");
const inlineCode = (value) => {
  const tableValue = value.replaceAll(/\r?\n/g, " ").replaceAll("|", "\\|");
  const longestBacktickRun = Math.max(0, ...[...tableValue.matchAll(/`+/g)].map(([run]) => run.length));
  const delimiter = "`".repeat(longestBacktickRun + 1);
  const needsPadding = tableValue.startsWith("`") || tableValue.endsWith("`");
  const content = needsPadding ? ` ${tableValue} ` : tableValue;
  return `${delimiter}${content}${delimiter}`;
};

const timingTable = (heading, label, entries) => [
  heading,
  "",
  `| Duration | Tests | ${label} |`,
  "| ---: | ---: | --- |",
  ...entries.map(
    ({ durationMs, testCount, path }) =>
      `| ${formatSeconds(durationMs)} | ${formatCount(testCount)} | ${inlineCode(path)} |`,
  ),
];

const timingDetails = (measurement, headingLevel) => [
  ...timingTable(`${headingLevel} Packages`, "Package", measurement.packages),
  "",
  ...timingTable(`${headingLevel} Test files`, "Test file", measurement.testFiles),
];

const totalTable = (durationLabel, durationMs, testCount) => [
  `| ${durationLabel} | Test count |`,
  "| ---: | ---: |",
  `| ${formatSeconds(durationMs)} | ${formatCount(testCount)} |`,
];

const formatMeasurement = (measurement) => [
  "## Test suite timing",
  "",
  ...totalTable("Duration", measurement.durationMs, measurement.testCount),
  "",
  ...timingDetails(measurement, "###"),
  "",
];

const formatConfiguration = (label, configuration) => [
  `### ${label}: ${inlineCode(configuration.ref)} (${inlineCode(configuration.sha)})`,
  "",
  ...totalTable("Median duration", configuration.medianDurationMs, configuration.testCount),
  "",
  ...timingDetails(configuration, "####"),
];

const formatComparison = (report) => [
  "## Test suite comparison timing",
  "",
  ...formatConfiguration("Base", report.base),
  "",
  ...formatConfiguration("Head", report.head),
  "",
];

const report = JSON.parse(await readFile(measurementPath, "utf8"));
const isComparison = typeof report?.base === "object" && typeof report?.head === "object";
const formatReport = isComparison ? formatComparison : formatMeasurement;

process.stdout.write(formatReport(report).join("\n"));
