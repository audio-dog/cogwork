import { ClassifiedItem } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatClassifiedItem } from "./classified-item";

const item = Schema.decodeSync(ClassifiedItem);

describe("classified item formatting", () => {
  it.each([
    [item({ _tag: "Eligible", id: "1", title: "Ready", stage: "implement" }), "implement 1 Ready"],
    [
      item({
        _tag: "Claimed",
        id: "2",
        title: "Running",
        claim: {
          by: "agent",
          claimedAtMillis: 1,
          operation: { workflow: "coding", operation: "implement" },
          lineage: { root: "run-1", parent: null, hop: 0 },
        },
      }),
      "claimed 2 Running (by agent)",
    ],
    [
      item({ _tag: "Blocked", id: "3", title: "Waiting", openBlockers: 2 }),
      "blocked 3 Waiting (2 open blockers)",
    ],
    [
      item({
        _tag: "NeedsHuman",
        id: "4",
        title: "Decision",
        reason: "ready-for-human",
        proposal: null,
        url: null,
      }),
      "needs-human ready-for-human 4 Decision",
    ],
    [
      item({
        _tag: "ReadyToMerge",
        id: "5",
        title: "Approved",
        pr: {
          number: 5,
          url: "https://example.test/pull/5",
          checks: "passing",
          review: "ready",
          baseDivergence: "none",
          waitingSinceMillis: 0,
        },
      }),
      "ready-to-merge 5 Approved (PR #5)",
    ],
  ])("formats every classification", (classified, expected) => {
    assert.strictEqual(formatClassifiedItem(classified), expected);
  });

  it("removes terminal controls and line breaks", () => {
    const classified = item({
      _tag: "Eligible",
      id: "5",
      title: "safe\u001b[2Jtitle\nINJECTED",
      stage: "implement",
    });

    assert.strictEqual(formatClassifiedItem(classified), "implement 5 safe[2Jtitle INJECTED");
  });
});
