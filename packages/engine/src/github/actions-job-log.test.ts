import { assert, describe, it } from "@effect/vitest";

import { actionsJobLogExcerpt } from "./actions-job-log";

const escapeCharacter = String.fromCharCode(27);
const red = (text: string) => `${escapeCharacter}[31m${text}${escapeCharacter}[39m`;
const stamped = (lines: ReadonlyArray<string>) =>
  lines.map((line) => `2026-11-20T19:17:20.7819334Z ${line}`).join("\n");

const passingNoise = Array.from({ length: 40 }, (_, index) => `   ✓ passing test ${index} 12ms`);

describe("actionsJobLogExcerpt", () => {
  it("keeps the failing test, its assertion, and the end of the failed step, without runner noise", () => {
    const log = stamped([
      "##[group]Run pnpm test",
      ...passingNoise,
      "   ✓ a failed test command preserves its measurement output 369ms",
      red("     × saves a name typed with a trailing space 2458ms"),
      ...passingNoise,
      `${red("⎯⎯⎯")} Failed Tests 1 ${red("⎯⎯⎯")}`,
      "",
      " FAIL  src/renderer/src/features/workflow-session.test.tsx > WorkflowEditor > saves a name",
      red("AssertionError: expected [ 'edit', 'publish', 'edit' ] to deeply equal [ 'edit', 'publish' ]"),
      ...passingNoise,
      "[ELIFECYCLE] Test failed. See above for more details.",
      "##[error]Process completed with exit code 1.",
      "Post job cleanup.",
      "Removing credentials config '/home/runner/work/_temp/git-credentials.config'",
      "Cleaning up orphan processes",
    ]);

    const excerpt = actionsJobLogExcerpt(log);

    assert.include(excerpt, "     × saves a name typed with a trailing space 2458ms");
    assert.include(
      excerpt,
      " FAIL  src/renderer/src/features/workflow-session.test.tsx > WorkflowEditor > saves a name\nAssertionError: expected [ 'edit', 'publish', 'edit' ] to deeply equal [ 'edit', 'publish' ]",
    );
    assert.isTrue(excerpt.endsWith("##[error]Process completed with exit code 1."));
    assert.notInclude(excerpt, "a failed test command preserves");
    assert.notInclude(excerpt, "passing test 20 ");
    assert.notInclude(excerpt, "Cleaning up orphan processes");
    assert.notInclude(excerpt, escapeCharacter);
    assert.notInclude(excerpt, "2026-11-20T");
  });

  it("bounds the excerpt when a job fails many tests", () => {
    const failures = Array.from(
      { length: 500 },
      (_, index) => ` FAIL  src/case-${index}.test.ts > case ${index}`,
    );
    const log = stamped([
      ...failures,
      `${"x".repeat(5_000)}`,
      "##[error]Process completed with exit code 1.",
    ]);

    const excerpt = actionsJobLogExcerpt(log).split("\n");

    assert.isAtMost(excerpt.length, 120);
    assert.include(excerpt, " FAIL  src/case-0.test.ts > case 0");
    assert.strictEqual(excerpt.at(-1), "##[error]Process completed with exit code 1.");
    assert.isTrue(excerpt.every((line) => line.length <= 301));
  });
});
