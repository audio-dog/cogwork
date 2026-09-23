import { afterEach, expect, test, vi } from "vitest";
import config, { localWorkerLimit } from "../base";
import {
  buildTestTimingReport,
  countMeasuredTestStates,
  TestCountReporter,
  testCountMarker,
  testTimingMarker,
} from "../test-count-reporter";

afterEach(() => {
  vi.restoreAllMocks();
});

test("shared config installs the test-count reporter", () => {
  expect(config.test?.reporters).toEqual(["default", expect.any(TestCountReporter)]);
});

test("shared config bounds local workers without changing CI", () => {
  expect(localWorkerLimit(false)).toBe(1);
  expect(localWorkerLimit(true)).toBeUndefined();
});

test("shared config bounds local workers without changing CI", () => {
  expect(localWorkerLimit(false)).toBe(1);
  expect(localWorkerLimit(true)).toBeUndefined();
});

test("test count includes passed and failed tests but excludes skipped and pending tests", () => {
  expect(countMeasuredTestStates(["passed", "failed", "skipped", "pending"])).toBe(2);
});

test("reporter writes the test count marker", () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  new TestCountReporter().onTestRunEnd([]);

  expect(write).toHaveBeenNthCalledWith(1, `${testCountMarker}0\n`);
});

test("timing report includes package duration, file duration, and test count", () => {
  expect(
    buildTestTimingReport(
      "/workspace/packages/engine",
      [
        { path: "src/fast.test.ts", durationMs: 15, testCount: 2 },
        { path: "src/slow.test.ts", durationMs: 250, testCount: 3 },
      ],
      180,
    ),
  ).toEqual({
    packagePath: "/workspace/packages/engine",
    durationMs: 180,
    testCount: 5,
    testFiles: [
      { path: "src/fast.test.ts", durationMs: 15, testCount: 2 },
      { path: "src/slow.test.ts", durationMs: 250, testCount: 3 },
    ],
  });
});

test("reporter writes the timing marker", () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(365);

  new TestCountReporter().onTestRunEnd([]);

  expect(write).toHaveBeenNthCalledWith(
    2,
    `${testTimingMarker}${JSON.stringify({
      packagePath: process.cwd(),
      durationMs: 265,
      testCount: 0,
      testFiles: [],
    })}\n`,
  );
});
