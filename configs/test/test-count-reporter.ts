import type { Reporter, TestModule, TestState } from "vitest/node";

export const testCountMarker = "cogwork-test-count:";
export const testTimingMarker = "cogwork-test-timing:";
const measuredTestStates = new Set<TestState>(["passed", "failed"]);

export interface TestFileTiming {
  readonly path: string;
  readonly durationMs: number;
  readonly testCount: number;
}

export const countMeasuredTestStates = (states: ReadonlyArray<TestState>) =>
  states.filter((state) => measuredTestStates.has(state)).length;

const testStates = (testModule: TestModule) =>
  [...testModule.children.allTests()].map((testCase) => testCase.result().state);

const testFileTiming = (testModule: TestModule) => ({
  path: testModule.relativeModuleId,
  durationMs: testModule.diagnostic().duration,
  testCount: countMeasuredTestStates(testStates(testModule)),
});

export const buildTestTimingReport = (
  packagePath: string,
  testFiles: ReadonlyArray<TestFileTiming>,
  durationMs: number,
) => ({
  packagePath,
  durationMs,
  testCount: testFiles.reduce((total, testFile) => total + testFile.testCount, 0),
  testFiles,
});

export class TestCountReporter implements Reporter {
  readonly #startedAt = performance.now();

  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const report = buildTestTimingReport(
      process.cwd(),
      testModules.map(testFileTiming),
      performance.now() - this.#startedAt,
    );
    process.stdout.write(`${testCountMarker}${report.testCount}\n`);
    process.stdout.write(`${testTimingMarker}${JSON.stringify(report)}\n`);
  }
}

export default TestCountReporter;
