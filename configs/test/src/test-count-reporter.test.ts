import { afterEach, expect, test, vi } from "vitest";
import config from "../base";
import { countMeasuredTestStates, TestCountReporter, testCountMarker } from "../test-count-reporter";

afterEach(() => {
  vi.restoreAllMocks();
});

test("shared config installs the test-count reporter", () => {
  expect(config.test?.reporters).toEqual(["default", expect.any(TestCountReporter)]);
});

test("test count includes passed and failed tests but excludes skipped and pending tests", () => {
  expect(countMeasuredTestStates(["passed", "failed", "skipped", "pending"])).toBe(2);
});

test("reporter writes the test count marker", () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  new TestCountReporter().onTestRunEnd([]);

  expect(write).toHaveBeenCalledWith(`${testCountMarker}0\n`);
});
