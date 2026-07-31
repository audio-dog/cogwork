import { assert, describe, it } from "@effect/vitest";
import { humanCommentSignal, linkedIssue, prReview } from "./adapter";
import { type RawComment, type RawPull, reviewDecisionOf } from "./client";

const review = (login: string, state: string) => ({ login, state });

const comment = (over: Partial<RawComment>): RawComment => ({
  authorLogin: "maintainer",
  authorAssociation: "COLLABORATOR",
  body: "",
  createdAtMillis: 0,
  ...over,
});

const pull = (over: Partial<RawPull>): RawPull => ({
  number: 1,
  authorLogin: "clanker-forge[bot]",
  body: "",
  draft: false,
  headSha: "sha",
  reviewDecision: "none",
  ...over,
});

describe("reviewDecisionOf", () => {
  it("reports none when there are no standing reviews", () => {
    assert.strictEqual(reviewDecisionOf([]), "none");
    assert.strictEqual(reviewDecisionOf([review("a", "COMMENTED"), review("b", "PENDING")]), "none");
  });

  it("prefers a standing changes-requested over an approval", () => {
    assert.strictEqual(
      reviewDecisionOf([review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")]),
      "changes-requested",
    );
  });

  it("uses the latest review per login", () => {
    assert.strictEqual(
      reviewDecisionOf([review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")]),
      "approved",
    );
  });

  it("clears an approval that was later dismissed", () => {
    assert.strictEqual(reviewDecisionOf([review("a", "APPROVED"), review("a", "DISMISSED")]), "none");
  });
});

describe("linkedIssue", () => {
  it("extracts the issue number from a closing keyword", () => {
    assert.strictEqual(linkedIssue("Closes #5"), 5);
    assert.strictEqual(linkedIssue("this fixes #12 finally"), 12);
    assert.strictEqual(linkedIssue("resolved #3"), 3);
  });

  it("returns null when no closing keyword is present", () => {
    assert.isNull(linkedIssue("references #9 but does not close it"));
    assert.isNull(linkedIssue("no link here"));
  });
});

describe("prReview", () => {
  it("treats a draft PR as pending regardless of reviews", () => {
    assert.strictEqual(prReview(pull({ draft: true, reviewDecision: "approved" })), "pending");
  });

  it("maps an approved PR to ready and a changes-requested PR to changes-requested", () => {
    assert.strictEqual(prReview(pull({ reviewDecision: "approved" })), "ready");
    assert.strictEqual(prReview(pull({ reviewDecision: "changes-requested" })), "changes-requested");
  });

  it("keeps an unreviewed PR pending instead of routing it to verify", () => {
    assert.strictEqual(prReview(pull({ reviewDecision: "none" })), "pending");
  });
});

describe("humanCommentSignal", () => {
  const bot = "clanker-forge[bot]";

  it("counts a write-access human comment and reads its /fresh directive", () => {
    const signal = humanCommentSignal(
      [comment({ authorAssociation: "COLLABORATOR", body: "please /fresh", createdAtMillis: 200 })],
      bot,
    );
    assert.strictEqual(signal.latestAtMillis, 200);
    assert.isTrue(signal.fresh);
  });

  it("ignores comments from users without write access", () => {
    const signal = humanCommentSignal(
      [comment({ authorLogin: "drive-by", authorAssociation: "NONE", body: "/fresh", createdAtMillis: 200 })],
      bot,
    );
    assert.isNull(signal.latestAtMillis);
    assert.isFalse(signal.fresh);
  });

  it("ignores the bot's own comments", () => {
    const signal = humanCommentSignal(
      [comment({ authorLogin: bot, authorAssociation: "OWNER", body: "/fresh", createdAtMillis: 200 })],
      bot,
    );
    assert.isNull(signal.latestAtMillis);
  });

  it("cannot identify humans without a configured bot login", () => {
    const signal = humanCommentSignal([comment({ createdAtMillis: 200 })], null);
    assert.isNull(signal.latestAtMillis);
  });
});
