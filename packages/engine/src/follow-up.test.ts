import { assert, describe, it } from "@effect/vitest";
import {
  type FollowUpContext,
  followUpContext,
  followUpNoProgressLimit,
  noProgressAfterRound,
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
  headRef: "1-test",
  followable: true,
  draft: false,
  followUp: null,
  ...over,
});

describe("triggersFollowUp", () => {
  it("triggers on failing checks", () => {
    assert.isTrue(triggersFollowUp(pr({ checks: "failing" })));
  });

  it("does not trigger on a standing changes-requested review", () => {
    assert.isFalse(triggersFollowUp(pr({ review: "changes-requested" })));
  });

  it("triggers once on a change request's feedback, then goes quiet", () => {
    assert.isTrue(triggersFollowUp(pr({ review: "changes-requested", latestHumanCommentAtMillis: 10 })));
    assert.isFalse(
      triggersFollowUp(
        pr({
          review: "changes-requested",
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

  it("starts under the limit again once a hand-off parked the count at 0", () => {
    // An item only reaches here after a human took `ready-for-human` off it, so the round it wakes
    // must be allowed to run rather than claim and abandon on the count that parked it.
    const parked = noProgressCount(
      pr({
        checks: "failing",
        followUp: {
          checks: "failing",
          humanCommentAtMillis: 0,
          noProgress: 0,
          baseDivergence: "none",
          botTriggerAtMillis: 0,
        },
      }),
    );
    assert.strictEqual(parked, 1);
    assert.isBelow(parked, followUpNoProgressLimit);
  });
});

describe("noProgressAfterRound", () => {
  const context = (noProgress: number): FollowUpContext => ({
    previousMarker: null,
    checks: "passing",
    humanCommentAtMillis: 0,
    botTriggerAtMillis: 0,
    noProgress,
    stalled: noProgress >= followUpNoProgressLimit,
    fresh: false,
    baseDivergence: "none",
  });

  it("starts the count over when the round pushed", () => {
    assert.strictEqual(noProgressAfterRound(context(0), "pushed"), 0);
    assert.strictEqual(noProgressAfterRound(context(followUpNoProgressLimit - 1), "pushed"), 0);
  });

  it("carries the count forward when the round pushed nothing", () => {
    assert.strictEqual(noProgressAfterRound(context(0), "noop"), 0);
    assert.strictEqual(noProgressAfterRound(context(2), "noop"), 2);
  });

  it("keeps a green PR answering a bot round after round, which the external signals alone cannot", () => {
    // The PR that motivated this: checks green throughout, so they never *turned* green; no human
    // ever commented; the conflict cleared on the first round only. Every reset the observation can
    // see stays false, and each round still pushed a real fix.
    const bot = pr({
      latestBotTriggerAtMillis: 30,
      followUp: {
        checks: "passing",
        humanCommentAtMillis: 0,
        noProgress: followUpNoProgressLimit - 1,
        baseDivergence: "none",
        botTriggerAtMillis: 20,
      },
    });
    const observed = followUpContext(bot);
    assert.strictEqual(observed.noProgress, followUpNoProgressLimit);
    assert.strictEqual(noProgressAfterRound(observed, "pushed"), 0);
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

  it("carries available trigger timestamps and leaves missing timestamps absent", () => {
    const previousMarker = {
      checks: "passing" as const,
      humanCommentAtMillis: 0,
      noProgress: 0,
      baseDivergence: "none" as const,
      botTriggerAtMillis: 20,
    };
    const context = followUpContext(
      pr({
        latestBotTriggerAtMillis: 42,
        latestFailingCheckAtMillis: 43,
        followUp: previousMarker,
      }),
    );
    assert.strictEqual(context.botTriggerAtMillis, 42);
    assert.strictEqual(context.latestFailingCheckAtMillis, 43);
    assert.deepStrictEqual(context.previousMarker, previousMarker);

    const clockCapped = followUpContext(pr({ checks: "failing", latestFailingCheckAtMillis: null }));
    assert.strictEqual(clockCapped.latestFailingCheckAtMillis, undefined);
  });

  it("stalls a bot round that follows rounds which changed nothing", () => {
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
