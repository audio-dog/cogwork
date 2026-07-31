import { assert, describe, it } from "@effect/vitest";
import {
  followUpContext,
  followUpNoProgressLimit,
  noProgressCount,
  type ObservedPr,
  triggersFollowUp,
} from "./followUp";

const pr = (over: Partial<ObservedPr> = {}): ObservedPr => ({
  review: "pending",
  checks: "passing",
  latestHumanCommentAtMillis: null,
  fresh: false,
  followUp: null,
  ...over,
});

describe("triggersFollowUp", () => {
  it("triggers on failing checks", () => {
    assert.isTrue(triggersFollowUp(pr({ checks: "failing" })));
  });

  it("triggers on a changes-requested review", () => {
    assert.isTrue(triggersFollowUp(pr({ review: "changes-requested" })));
  });

  it("triggers on a human comment newer than the last follow-up marker", () => {
    assert.isTrue(triggersFollowUp(pr({ latestHumanCommentAtMillis: 10 })));
    assert.isFalse(
      triggersFollowUp(
        pr({
          latestHumanCommentAtMillis: 10,
          followUp: { checks: "passing", humanCommentAtMillis: 10, noProgress: 0 },
        }),
      ),
    );
  });

  it("does not trigger on a green, unreviewed, unchanged PR", () => {
    assert.isFalse(triggersFollowUp(pr()));
  });
});

describe("noProgressCount", () => {
  it("is zero with no prior marker", () => {
    assert.strictEqual(noProgressCount(pr({ checks: "failing" })), 0);
  });

  it("increments when neither checks nor human moved since the marker", () => {
    assert.strictEqual(
      noProgressCount(
        pr({
          checks: "failing",
          latestHumanCommentAtMillis: 5,
          followUp: { checks: "failing", humanCommentAtMillis: 5, noProgress: 1 },
        }),
      ),
      2,
    );
  });

  it("resets when the checks turned green", () => {
    assert.strictEqual(
      noProgressCount(
        pr({ checks: "passing", followUp: { checks: "failing", humanCommentAtMillis: 0, noProgress: 2 } }),
      ),
      0,
    );
  });

  it("resets when a human responded since the marker", () => {
    assert.strictEqual(
      noProgressCount(
        pr({
          checks: "failing",
          latestHumanCommentAtMillis: 20,
          followUp: { checks: "failing", humanCommentAtMillis: 10, noProgress: 2 },
        }),
      ),
      0,
    );
  });
});

describe("followUpContext", () => {
  it("flags blocked once the counter reaches the limit", () => {
    const context = followUpContext(
      pr({
        checks: "failing",
        latestHumanCommentAtMillis: 5,
        fresh: true,
        followUp: { checks: "failing", humanCommentAtMillis: 5, noProgress: followUpNoProgressLimit - 1 },
      }),
    );
    assert.strictEqual(context.noProgress, followUpNoProgressLimit);
    assert.isTrue(context.blocked);
    assert.isTrue(context.fresh);
  });
});
