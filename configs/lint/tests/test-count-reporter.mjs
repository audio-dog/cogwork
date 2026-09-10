const testCountMarker = "cogwork-test-count:";

export default async function* testCountReporter(source) {
  const summaries = [];

  for await (const event of source) {
    if (event.type === "test:summary") summaries.push(event.data);
  }

  const summary = summaries.at(-1);
  if (!summary) throw new Error("Node test run reported no summary");
  yield `${testCountMarker}${summary.counts.tests}\n`;
}
