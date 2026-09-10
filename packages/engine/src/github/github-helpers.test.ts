import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  type GitHubRepoRef,
  parseIssues,
  type RawComment,
  type RawPull,
  type RawReview,
  reviewDecisionOf,
} from "./client";
import { ledgerMarker } from "./markers";
import {
  baseDivergenceOf,
  botTriggerSignal,
  branchBelongsToSlug,
  humanCommentSignal,
  prReview,
  reviewFeedback,
} from "./provider";

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
  url: "https://github.com/owner/repo/pull/1",
  authorLogin: "cogwork[bot]",
  authorAssociation: "MEMBER",
  draft: false,
  headSha: "sha",
  headRef: "1-x",
  headRepository: "owner/repo",
  closingIssueNumbers: [],
  updatedAtMillis: 0,
  ...over,
});

describe("baseDivergenceOf", () => {
  it("maps a dirty mergeable_state to a conflict", () => {
    assert.strictEqual(baseDivergenceOf("dirty"), "conflict");
  });

  it("maps a behind mergeable_state to clean, since it still merges", () => {
    assert.strictEqual(baseDivergenceOf("behind"), "clean");
  });

  it("maps every other state, including a not-yet-computed null, to none", () => {
    assert.strictEqual(baseDivergenceOf(null), "none");
    assert.strictEqual(baseDivergenceOf("clean"), "none");
    assert.strictEqual(baseDivergenceOf("blocked"), "none");
    assert.strictEqual(baseDivergenceOf("unknown"), "none");
    assert.strictEqual(baseDivergenceOf("unstable"), "none");
  });
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

describe("parseIssues", () => {
  const repo: GitHubRepoRef = { owner: "owner", name: "repo", tokenEnv: "GITHUB_TOKEN" };

  const issue = (over: Record<string, unknown>) => ({
    node_id: `I_issue_${String(over.number ?? 1)}`,
    number: 1,
    title: "an issue",
    labels: ["ready-for-agent"],
    ...over,
  });

  it.effect("reads open blockers from the dependency summary GitHub sends with the listing", () =>
    Effect.gen(function* () {
      const issues = yield* parseIssues(repo, [
        issue({ number: 1, issue_dependencies_summary: { blocked_by: 2, total_blocked_by: 5 } }),
        issue({ number: 2, issue_dependencies_summary: { blocked_by: 0 } }),
      ]);
      assert.deepStrictEqual(
        issues.map((raw) => raw.openBlockers),
        [2, 0],
      );
    }),
  );

  it.effect("treats a null, absent, or countless dependency summary as no open blockers", () =>
    Effect.gen(function* () {
      const issues = yield* parseIssues(repo, [
        issue({ number: 1, issue_dependencies_summary: null }),
        issue({ number: 2 }),
        issue({ number: 3, issue_dependencies_summary: { total_blocked_by: 4 } }),
        issue({ number: 4, issue_dependencies_summary: { blocked_by: null } }),
      ]);
      assert.deepStrictEqual(
        issues.map((raw) => raw.openBlockers),
        [0, 0, 0, 0],
      );
    }),
  );

  it.effect("takes the issue's html_url and falls back to the canonical issue URL", () =>
    Effect.gen(function* () {
      const issues = yield* parseIssues(repo, [
        issue({ number: 1, html_url: "https://github.com/owner/repo/issues/1" }),
        issue({ number: 2 }),
      ]);
      assert.deepStrictEqual(
        issues.map((raw) => raw.url),
        ["https://github.com/owner/repo/issues/1", "https://github.com/owner/repo/issues/2"],
      );
    }),
  );
});

describe("branchBelongsToSlug", () => {
  it("matches the bare slug and any slug-prefixed branch", () => {
    assert.isTrue(branchBelongsToSlug("13", "13"));
    assert.isTrue(branchBelongsToSlug("13-worktree-lifecycle", "13"));
    assert.isTrue(branchBelongsToSlug("aud-1-add-login", "aud-1"));
  });

  it("does not let one slug swallow a longer number that merely starts the same", () => {
    assert.isFalse(branchBelongsToSlug("130-something", "13"));
    assert.isFalse(branchBelongsToSlug("14-other", "13"));
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
  const bot = "cogwork[bot]";
  const noBots = new Set<string>();

  it("counts a write-access human comment and reads its /fresh directive", () => {
    const signal = humanCommentSignal(
      [comment({ authorAssociation: "COLLABORATOR", body: "please /fresh", createdAtMillis: 200 })],
      noBots,
    );
    assert.strictEqual(signal.latestAtMillis, 200);
    assert.isTrue(signal.fresh);
  });

  it("ignores comments from users without write access", () => {
    const signal = humanCommentSignal(
      [comment({ authorLogin: "drive-by", authorAssociation: "NONE", body: "/fresh", createdAtMillis: 200 })],
      noBots,
    );
    assert.isNull(signal.latestAtMillis);
    assert.isFalse(signal.fresh);
  });

  it("counts unmarked write-access feedback even when authorLogin equals botLogin", () => {
    const signal = humanCommentSignal(
      [
        comment({
          authorLogin: bot,
          authorAssociation: "OWNER",
          body: "please take another look",
          createdAtMillis: 200,
        }),
      ],
      noBots,
    );
    assert.strictEqual(signal.latestAtMillis, 200);
  });

  it("ignores marked write-access feedback even when authorLogin equals botLogin", () => {
    const signal = humanCommentSignal(
      [
        comment({
          authorLogin: bot,
          authorAssociation: "OWNER",
          body: `fixed the checks\n${ledgerMarker}`,
          createdAtMillis: 200,
        }),
      ],
      noBots,
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
      noBots,
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
      noBots,
    );
    assert.strictEqual(signal.latestAtMillis, 30);
    assert.isTrue(signal.fresh);
  });

  it("treats an allowlisted login as a bot, not a human, even with write access", () => {
    const signal = humanCommentSignal(
      [
        comment({
          authorLogin: "cursor[bot]",
          authorAssociation: "MEMBER",
          body: "please /fresh",
          createdAtMillis: 200,
        }),
      ],
      new Set(["cursor[bot]"]),
    );
    assert.isNull(signal.latestAtMillis);
    assert.isFalse(signal.fresh);
  });
});

describe("botTriggerSignal", () => {
  const cursor = new Set(["cursor[bot]"]);

  it("wakes on a listed bot's comment, ignoring association", () => {
    const signal = botTriggerSignal(
      [comment({ authorLogin: "cursor[bot]", authorAssociation: "NONE", createdAtMillis: 300 })],
      cursor,
    );
    assert.strictEqual(signal.latestAtMillis, 300);
  });

  it("ignores an unlisted bot", () => {
    const signal = botTriggerSignal(
      [comment({ authorLogin: "dependabot[bot]", authorAssociation: "NONE", createdAtMillis: 300 })],
      cursor,
    );
    assert.isNull(signal.latestAtMillis);
  });

  it("ignores a cogwork-marked body even from a listed bot", () => {
    const signal = botTriggerSignal(
      [comment({ authorLogin: "cursor[bot]", body: `finding\n${ledgerMarker}`, createdAtMillis: 300 })],
      cursor,
    );
    assert.isNull(signal.latestAtMillis);
  });

  it("stays silent when no bots are allowlisted", () => {
    const signal = botTriggerSignal(
      [comment({ authorLogin: "cursor[bot]", createdAtMillis: 300 })],
      new Set<string>(),
    );
    assert.isNull(signal.latestAtMillis);
  });

  it("takes the newest listed-bot comment across a mixed list", () => {
    const signal = botTriggerSignal(
      [
        comment({ authorLogin: "cursor[bot]", body: "older", createdAtMillis: 10 }),
        comment({ authorLogin: "cursor[bot]", body: "newer", createdAtMillis: 30 }),
        comment({ authorLogin: "dependabot[bot]", body: "ignored", createdAtMillis: 99 }),
      ],
      cursor,
    );
    assert.strictEqual(signal.latestAtMillis, 30);
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
