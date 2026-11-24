import { stripVTControlCharacters } from "node:util";

const runnerTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const jobFailureEnd = "##[error]Process completed with exit code";
const failureMarkers = [
  /^FAIL\s/,
  /^[×✗✖]\s/,
  /\bAssertionError\b/,
  /\bFailed Tests \d+/,
  /\berror TS\d+:/,
  /^##\[error\]/,
];
const linesAfterMarker = 6;
const tailLines = 12;
// Each kept line can bring one gap marker, so 50 marker lines and the tail stay under 120 lines.
const markerLineBudget = 50;
const maxLineLength = 300;
const gap = "…";

const cleanLine = (line: string) => stripVTControlCharacters(line).replace(runnerTimestamp, "").trimEnd();

const clipped = (line: string) =>
  line.length > maxLineLength ? `${line.slice(0, maxLineLength)}${gap}` : line;

const isFailureLine = (line: string) => {
  const trimmed = line.trim();
  return failureMarkers.some((marker) => marker.test(trimmed));
};

const indexRange = (start: number, end: number) =>
  Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);

const throughFailedStep = (lines: ReadonlyArray<string>) => {
  const end = lines.findLastIndex((line) => line.startsWith(jobFailureEnd));
  return end === -1 ? lines : lines.slice(0, end + 1);
};

export const actionsJobLogExcerpt = (log: string) => {
  const lines = throughFailedStep(log.split("\n").map(cleanLine));
  const markerWindows = lines.flatMap((line, index) =>
    isFailureLine(line) ? indexRange(index, Math.min(lines.length, index + linesAfterMarker + 1)) : [],
  );
  const markers = [...new Set(markerWindows)].slice(0, markerLineBudget);
  const tail = indexRange(Math.max(0, lines.length - tailLines), lines.length);
  const kept = [...new Set([...markers, ...tail])].toSorted((left, right) => left - right);
  return kept
    .flatMap((index, position) => {
      const line = clipped(lines[index] ?? "");
      return index === (kept[position - 1] ?? -1) + 1 ? [line] : [gap, line];
    })
    .join("\n");
};
