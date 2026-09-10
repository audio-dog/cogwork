import type { Reporter, TestModule, TestState } from "vitest/node";

export const testCountMarker = "cogwork-test-count:";
const measuredTestStates = new Set<TestState>(["passed", "failed"]);

export const countMeasuredTestStates = (states: ReadonlyArray<TestState>) =>
  states.filter((state) => measuredTestStates.has(state)).length;

const testStates = (testModule: TestModule) =>
  [...testModule.children.allTests()].map((testCase) => testCase.result().state);

export class TestCountReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const testCount = countMeasuredTestStates(testModules.flatMap(testStates));
    process.stdout.write(`${testCountMarker}${testCount}\n`);
  }
}
