import { assert, describe, it } from "@effect/vitest";
import {
  followUpContext,
  followUpNoProgressLimit,
  noProgressCount,
  type ObservedPr,
  triggersFollowUp,
} from "./follow-up";

const pr = (over: Partial<ObservedPr> = {}): ObservedPr => ({
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  review: "pending",
  checks: "passing",
  latestHumanCommentAtMillis: null,
  latestBotTriggerAtMillis: null,
  fresh: false,
  baseDivergence: "none",
  waitingSinceMillis: 0,
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
          followUp: {
            checks: "passing",
            humanCommentAtMillis: 10,
            noProgress: 0,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          },
        }),
      ),
    );
  });

  it("triggers on a base-divergence conflict even when checks pass and nothing else moved", () => {
    assert.isTrue(triggersFollowUp(pr({ baseDivergence: "conflict" })));
  });

  it("does not trigger on a merely-behind base (clean), which still merges", () => {
    assert.isFalse(triggersFollowUp(pr({ baseDivergence: "clean" })));
  });

  it("does not trigger on a green, unreviewed, unchanged PR", () => {
    assert.isFalse(triggersFollowUp(pr()));
  });

  it("triggers on a trusted-bot comment newer than the last follow-up marker", () => {
    assert.isTrue(triggersFollowUp(pr({ latestBotTriggerAtMillis: 10 })));
    assert.isFalse(
      triggersFollowUp(
        pr({
          latestBotTriggerAtMillis: 10,
          followUp: {
            checks: "passing",
            humanCommentAtMillis: 0,
            noProgress: 0,
            baseDivergence: "none",
            botTriggerAtMillis: 10,
          },
        }),
      ),
    );
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
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 5,
            noProgress: 1,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          },
        }),
      ),
      2,
    );
  });

  it("resets when the checks turned green", () => {
    assert.strictEqual(
      noProgressCount(
        pr({
          checks: "passing",
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 0,
            noProgress: 2,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          },
        }),
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
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 10,
            noProgress: 2,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          },
        }),
      ),
      0,
    );
  });

  it("increments when a conflict persists with nothing else moving", () => {
    assert.strictEqual(
      noProgressCount(
        pr({
          baseDivergence: "conflict",
          followUp: {
            checks: "passing",
            humanCommentAtMillis: 0,
            noProgress: 1,
            baseDivergence: "conflict",
            botTriggerAtMillis: 0,
          },
        }),
      ),
      2,
    );
  });

  it("resets when a dirty PR became mergeable since the marker", () => {
    assert.strictEqual(
      noProgressCount(
        pr({
          baseDivergence: "clean",
          followUp: {
            checks: "passing",
            humanCommentAtMillis: 0,
            noProgress: 2,
            baseDivergence: "conflict",
            botTriggerAtMillis: 0,
          },
        }),
      ),
      0,
    );
  });

  it("does not reset on a newer bot trigger when nothing else moved", () => {
    assert.strictEqual(
      noProgressCount(
        pr({
          checks: "failing",
          latestBotTriggerAtMillis: 20,
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 0,
            noProgress: 1,
            baseDivergence: "none",
            botTriggerAtMillis: 10,
          },
        }),
      ),
      2,
    );
  });
});

describe("followUpContext", () => {
  it("flags stalled once the counter reaches the limit", () => {
    const context = followUpContext(
      pr({
        checks: "failing",
        latestHumanCommentAtMillis: 5,
        fresh: true,
        followUp: {
          checks: "failing",
          humanCommentAtMillis: 5,
          noProgress: followUpNoProgressLimit - 1,
          baseDivergence: "none",
          botTriggerAtMillis: 0,
        },
      }),
    );
    assert.strictEqual(context.noProgress, followUpNoProgressLimit);
    assert.isTrue(context.stalled);
    assert.isTrue(context.fresh);
  });

  it("stalls a conflict that persists to the limit and carries its base-divergence state", () => {
    const context = followUpContext(
      pr({
        baseDivergence: "conflict",
        followUp: {
          checks: "passing",
          humanCommentAtMillis: 0,
          noProgress: followUpNoProgressLimit - 1,
          baseDivergence: "conflict",
          botTriggerAtMillis: 0,
        },
      }),
    );
    assert.strictEqual(context.noProgress, followUpNoProgressLimit);
    assert.isTrue(context.stalled);
    assert.strictEqual(context.baseDivergence, "conflict");
  });

  it("carries the latest bot-trigger time so the next marker records it", () => {
    const context = followUpContext(pr({ latestBotTriggerAtMillis: 42 }));
    assert.strictEqual(context.botTriggerAtMillis, 42);
  });

  it("stalls a bot-only back-and-forth once it reaches the no-progress limit", () => {
    const context = followUpContext(
      pr({
        latestBotTriggerAtMillis: 30,
        followUp: {
          checks: "passing",
          humanCommentAtMillis: 0,
          noProgress: followUpNoProgressLimit - 1,
          baseDivergence: "none",
          botTriggerAtMillis: 20,
        },
      }),
    );
    assert.strictEqual(context.noProgress, followUpNoProgressLimit);
    assert.isTrue(context.stalled);
    assert.isFalse(context.fresh);
  });
});
