import { assert, describe, it } from "@effect/vitest";
import { defaultPriority, priorityRank, resolvePriority } from "./triage";

describe("resolvePriority", () => {
  it("maps each canonical name straight through", () => {
    for (const priority of priorityRank) {
      assert.strictEqual(resolvePriority(priority), priority);
    }
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    assert.strictEqual(resolvePriority("Urgent"), "urgent");
    assert.strictEqual(resolvePriority("  HIGH "), "high");
    assert.strictEqual(resolvePriority("Low"), "low");
  });

  it("resolves an absent value to the default", () => {
    assert.strictEqual(resolvePriority(null), defaultPriority);
    assert.strictEqual(resolvePriority(undefined), defaultPriority);
    assert.strictEqual(defaultPriority, "medium");
  });

  it("resolves an unrecognized value to the default", () => {
    assert.strictEqual(resolvePriority("no priority"), "medium");
    assert.strictEqual(resolvePriority("critical"), "medium");
    assert.strictEqual(resolvePriority(""), "medium");
  });

  it("orders urgent highest and low lowest", () => {
    assert.deepStrictEqual([...priorityRank], ["urgent", "high", "medium", "low"]);
  });
});
