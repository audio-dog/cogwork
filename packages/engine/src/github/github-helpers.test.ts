import { assert, describe, it } from "@effect/vitest";
import { humanCommentSignal, linkedIssue, prReview, reviewFeedback } from "./adapter";
import { type RawComment, type RawPull, type RawReview, reviewDecisionOf } from "./client";

const review = (login: string, state: string) => ({ login, state });

const comment = (over: Partial<RawComment>): RawComment => ({
  id: 1,
  authorLogin: "maintainer",
  authorAssociation: "COLLABORATOR",
  body: "",
  createdAtMillis: 0,
  ...over,
});

const rawReview = (over: Partial<RawReview>): RawReview => ({
  authorLogin: "maintainer",
  authorAssociation: "COLLABORATOR",
  state: "COMMENTED",
  body: "",
  submittedAtMillis: 0,
  ...over,
});

const pull = (over: Partial<RawPull>): RawPull => ({
  number: 1,
  authorLogin: "clanker-forge[bot]",
  authorAssociation: "MEMBER",
  body: "",
  draft: false,
  headSha: "sha",
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
    assert.strictEqual(prReview(pull({ draft: true }), "approved"), "pending");
  });

  it("maps an approved PR to ready and a changes-requested PR to changes-requested", () => {
    assert.strictEqual(prReview(pull({}), "approved"), "ready");
    assert.strictEqual(prReview(pull({}), "changes-requested"), "changes-requested");
  });

  it("keeps an unreviewed PR pending instead of routing it to verify", () => {
    assert.strictEqual(prReview(pull({}), "none"), "pending");
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

  it("ignores the daemon's own comments so its round summaries never re-trigger follow-up", () => {
    const signal = humanCommentSignal(
      [
        comment({
          authorLogin: bot,
          authorAssociation: "OWNER",
          body: "fixed the checks",
          createdAtMillis: 200,
        }),
      ],
      bot,
    );
    assert.isNull(signal.latestAtMillis);
  });

  it("counts a write-access commenter other than the maintainer", () => {
    const signal = humanCommentSignal(
      [
        comment({
          authorLogin: "teammate",
          authorAssociation: "MEMBER",
          body: "please fix",
          createdAtMillis: 5,
        }),
      ],
      bot,
    );
    assert.strictEqual(signal.latestAtMillis, 5);
  });

  it("takes the newest human feedback across a mixed list", () => {
    const signal = humanCommentSignal(
      [
        comment({ authorLogin: "maintainer", body: "older", createdAtMillis: 10 }),
        comment({ authorLogin: "maintainer", body: "newer /fresh", createdAtMillis: 30 }),
        comment({ authorLogin: "drive-by", authorAssociation: "NONE", body: "ignored", createdAtMillis: 99 }),
      ],
      bot,
    );
    assert.strictEqual(signal.latestAtMillis, 30);
    assert.isTrue(signal.fresh);
  });

  it("cannot identify humans without a configured bot login", () => {
    const signal = humanCommentSignal([comment({ createdAtMillis: 200 })], null);
    assert.isNull(signal.latestAtMillis);
  });
});

describe("reviewFeedback", () => {
  it("drops reviews with no body and keeps ones that carry feedback", () => {
    const feedback = reviewFeedback([
      rawReview({ state: "COMMENTED", body: "", submittedAtMillis: 100 }),
      rawReview({ state: "COMMENTED", body: "take another look", submittedAtMillis: 200 }),
    ]);
    assert.deepStrictEqual(feedback, [
      {
        authorLogin: "maintainer",
        authorAssociation: "COLLABORATOR",
        body: "take another look",
        createdAtMillis: 200,
      },
    ]);
  });

  it("ignores an approving review's body so approval routes to verify, not follow-up", () => {
    assert.deepStrictEqual(
      reviewFeedback([rawReview({ state: "APPROVED", body: "lgtm, nice work", submittedAtMillis: 5 })]),
      [],
    );
  });

  it("drops a change-request body once a later approval supersedes it", () => {
    assert.deepStrictEqual(
      reviewFeedback([
        rawReview({ state: "CHANGES_REQUESTED", body: "please fix", submittedAtMillis: 100 }),
        rawReview({ state: "APPROVED", body: "", submittedAtMillis: 300 }),
      ]),
      [],
    );
  });

  it("keeps a comment made after the latest approval", () => {
    const feedback = reviewFeedback([
      rawReview({ state: "APPROVED", body: "", submittedAtMillis: 300 }),
      rawReview({ state: "COMMENTED", body: "one more thing", submittedAtMillis: 400 }),
    ]);
    assert.deepStrictEqual(feedback, [
      {
        authorLogin: "maintainer",
        authorAssociation: "COLLABORATOR",
        body: "one more thing",
        createdAtMillis: 400,
      },
    ]);
  });
});
