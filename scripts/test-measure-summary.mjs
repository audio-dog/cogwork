#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const measurementPath = process.argv[2];

if (!measurementPath) throw new Error("Usage: test-measure-summary <measurement.json>");

const { durationMs, testCount } = JSON.parse(await readFile(measurementPath, "utf8"));
const duration = `${(durationMs / 1_000).toFixed(3)} s`;
const count = testCount.toLocaleString("en-US");

process.stdout.write(
  `## Test suite cost\n\n| Duration | Test count |\n| ---: | ---: |\n| ${duration} | ${count} |\n`,
);
