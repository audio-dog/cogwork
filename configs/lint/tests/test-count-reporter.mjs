import path from "node:path";
import { buildTestTimingReport, testCountMarker, testTimingMarker } from "../../test/test-count-reporter.ts";

const fileTiming = (summary) => ({
  path: path.relative(process.cwd(), summary.file),
  durationMs: summary.duration_ms,
  testCount: summary.counts.tests,
});

export default async function* testCountReporter(source) {
  const summaries = [];

  for await (const event of source) {
    if (event.type === "test:summary") summaries.push(event.data);
  }

  const summary = summaries.at(-1);
  if (!summary) throw new Error("Node test run reported no summary");
  const testFiles = summaries.filter(({ file }) => file).map(fileTiming);
  const report = buildTestTimingReport(process.cwd(), testFiles, summary.duration_ms);
  yield `${testCountMarker}${summary.counts.tests}\n`;
  yield `${testTimingMarker}${JSON.stringify(report)}\n`;
}
