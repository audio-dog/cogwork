import { assert, describe, it } from "@effect/vitest";
import { linkedIssue, prReview } from "../src/github/adapter";
import { type RawPull, reviewDecisionOf } from "../src/github/client";

const review = (login: string, state: string) => ({ login, state });

const pull = (over: Partial<RawPull>): RawPull => ({
  number: 1,
  authorLogin: "clanker-forge[bot]",
  body: "",
  draft: false,
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
