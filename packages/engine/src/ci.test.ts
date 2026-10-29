import { assert, describe, it } from "@effect/vitest";
import { type CheckRun, checkState, latestFailingCheckAtMillis } from "./ci";

const run = (over: Partial<CheckRun> & { readonly name: string }): CheckRun => ({
  status: "completed",
  conclusion: "success",
  startedAtMillis: 0,
  ...over,
});

describe("checkState", () => {
  it("treats no check runs as passing", () => {
    assert.strictEqual(checkState([]), "passing");
  });

  it("reports failing for each ported failure conclusion", () => {
    for (const conclusion of ["failure", "timed_out", "cancelled", "startup_failure"]) {
      assert.strictEqual(checkState([run({ name: "ci", conclusion })]), "failing");
    }
  });

  it("treats a not-yet-completed check as pending", () => {
    assert.strictEqual(checkState([run({ name: "ci", status: "in_progress", conclusion: null })]), "pending");
  });

  it("treats success, neutral, and skipped as passing", () => {
    assert.strictEqual(
      checkState([
        run({ name: "a", conclusion: "success" }),
        run({ name: "b", conclusion: "neutral" }),
        run({ name: "c", conclusion: "skipped" }),
      ]),
      "passing",
    );
  });

  it("uses the latest run per name so a re-run success clears an earlier failure", () => {
    assert.strictEqual(
      checkState([
        run({ name: "ci", conclusion: "failure", startedAtMillis: 1 }),
        run({ name: "ci", conclusion: "success", startedAtMillis: 2 }),
      ]),
      "passing",
    );
  });

  it("reports failing when the latest run for a name failed", () => {
    assert.strictEqual(
      checkState([
        run({ name: "ci", conclusion: "success", startedAtMillis: 1 }),
        run({ name: "ci", conclusion: "failure", startedAtMillis: 2 }),
      ]),
      "failing",
    );
  });

  it("keeps a failing check completion when the daemon clock is behind", () => {
    assert.strictEqual(
      latestFailingCheckAtMillis([run({ name: "ci", conclusion: "failure", completedAtMillis: 2_000 })]),
      2_000,
    );
  });
});
