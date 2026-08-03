import { type AttemptRecord, type Claim, WorkItemId, WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { CheckRun } from "../ci";
import { classify } from "../classify";
import type { FollowUpMarker } from "../followUp";
import type { RegisteredWorkspace } from "../projector";
import { WorkSource } from "../WorkSource";
import { layer as adapterLayer } from "./adapter";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawPull,
  type RawReview,
} from "./client";
import { defaultStatus, hasLedgerMarker, serializeAttempt, serializeFollowUp } from "./markers";

const id = Schema.decodeSync(WorkItemId);

interface SeedIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly isPullRequest?: boolean;
}

interface SeedComment {
  readonly issue: number;
  readonly authorLogin: string;
  readonly body: string;
  readonly authorAssociation?: string;
  readonly createdAtMillis?: number;
}

interface SeedReview {
  readonly pull: number;
  readonly authorLogin?: string;
  readonly authorAssociation?: string;
  readonly state?: string;
  readonly body?: string;
  readonly submittedAtMillis?: number;
}

interface Seed {
  readonly issues: ReadonlyArray<SeedIssue>;
  readonly pulls?: ReadonlyArray<RawPull>;
  readonly comments?: ReadonlyArray<SeedComment>;
  readonly reviewComments?: ReadonlyArray<SeedComment>;
  readonly reviews?: ReadonlyArray<SeedReview>;
  readonly checks?: ReadonlyArray<{ readonly sha: string } & CheckRun>;
}

const bot = { login: "clanker-forge[bot]" } as const;
const repo: GitHubRepoRef = { owner: "owner", name: "repo", tokenEnv: "GITHUB_TOKEN" };

const seedComments = (comments: ReadonlyArray<SeedComment>) =>
  comments.reduce((byIssue, comment, index) => {
    const entry = {
      id: index + 1,
      authorLogin: comment.authorLogin,
      authorAssociation: comment.authorAssociation ?? "NONE",
      body: comment.body,
      createdAtMillis: comment.createdAtMillis ?? 0,
    } satisfies RawComment;
    return new Map(byIssue).set(comment.issue, [...(byIssue.get(comment.issue) ?? []), entry]);
  }, new Map<number, ReadonlyArray<RawComment>>());

const fakeClient = Effect.fn("github.fakeClient")(function* (seed: Seed) {
  const issuesRef = yield* Ref.make(
    seed.issues.map((issue) => ({ ...issue, isPullRequest: issue.isPullRequest ?? false })),
  );
  const seeded = seedComments(seed.comments ?? []);
  const nextId = yield* Ref.make((seed.comments?.length ?? 0) + 1);
  const commentsRef = yield* Ref.make(seeded);
  const reviewComments = seedComments(seed.reviewComments ?? []);
  const reviewsByPull = (seed.reviews ?? []).reduce((all, review) => {
    const entry: RawReview = {
      authorLogin: review.authorLogin ?? "maintainer",
      authorAssociation: review.authorAssociation ?? "COLLABORATOR",
      state: review.state ?? "COMMENTED",
      body: review.body ?? "",
      submittedAtMillis: review.submittedAtMillis ?? 0,
    };
    return all.set(review.pull, [...(all.get(review.pull) ?? []), entry]);
  }, new Map<number, ReadonlyArray<RawReview>>());
  const checksBySha = (seed.checks ?? []).reduce(
    (all, { sha, ...run }) => all.set(sha, [...(all.get(sha) ?? []), run]),
    new Map<string, ReadonlyArray<CheckRun>>(),
  );
  const pulls = seed.pulls ?? [];
  const patch = (
    number: number,
    update: (issue: SeedIssue & { isPullRequest: boolean }) => SeedIssue & { isPullRequest: boolean },
  ) =>
    Ref.update(issuesRef, (issues) =>
      issues.map((issue) => (issue.number === number ? update(issue) : issue)),
    );
  return {
    listIssues: () =>
      Ref.get(issuesRef).pipe(
        Effect.map((issues) =>
          issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            labels: issue.labels,
            isPullRequest: issue.isPullRequest,
          })),
        ),
      ),
    listPulls: () => Effect.succeed([...pulls]),
    listComments: (_repo, number) =>
      Ref.get(commentsRef).pipe(Effect.map((all) => [...(all.get(number) ?? [])])),
    listReviewComments: (_repo, number) => Effect.succeed([...(reviewComments.get(number) ?? [])]),
    listReviews: (_repo, number) => Effect.succeed([...(reviewsByPull.get(number) ?? [])]),
    addLabel: (_repo, number, label) =>
      patch(number, (issue) => ({ ...issue, labels: [...issue.labels, label] })),
    removeLabel: (_repo, number, label) =>
      patch(number, (issue) => ({
        ...issue,
        labels: issue.labels.filter((existing) => existing !== label),
      })),
    createComment: (_repo, number, body) =>
      Effect.gen(function* () {
        const assigned = yield* Ref.getAndUpdate(nextId, (value) => value + 1);
        yield* Ref.update(commentsRef, (all) =>
          new Map(all).set(number, [
            ...(all.get(number) ?? []),
            {
              id: assigned,
              authorLogin: bot.login,
              authorAssociation: "NONE",
              body,
              createdAtMillis: assigned,
            },
          ]),
        );
      }),
    editComment: (_repo, commentId, body) =>
      Ref.update(
        commentsRef,
        (all) =>
          new Map(
            [...all].map(([issue, comments]) => [
              issue,
              comments.map((comment) => (comment.id === commentId ? { ...comment, body } : comment)),
            ]),
          ),
      ),
    listCheckRuns: (_repo, sha) => Effect.succeed([...(checksBySha.get(sha) ?? [])]),
  } satisfies GitHubClientService;
});

const workspace: RegisteredWorkspace = {
  source: "gh.workspace.ts",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    workSource: { type: "github", repo: "owner/repo", botLogin: bot.login },
    harness: { preferred: "cursor" },
  }),
};

const withClient = (seed: Seed) =>
  adapterLayer.pipe(Layer.provideMerge(Layer.effect(GitHubClient, fakeClient(seed))));

const pull = (over: Partial<RawPull> & { readonly number: number; readonly body: string }): RawPull => ({
  authorLogin: "clanker-forge[bot]",
  authorAssociation: "MEMBER",
  draft: false,
  headSha: `sha-${over.number}`,
  ...over,
});

const botComments = (comments: ReadonlyArray<RawComment>) =>
  comments.filter((comment) => comment.authorLogin === bot.login);

describe("github work source adapter", () => {
  it.effect("derives the actionable set from labels and bot-PR state", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const { eligible, needsHuman, claimed } = classify(items);
      assert.deepStrictEqual(
        eligible.map((entry) => [entry.id, entry.stage]),
        [
          ["#5", "follow-up"],
          ["#2", "triage"],
          ["#1", "implement"],
        ],
      );
      assert.deepStrictEqual(
        needsHuman.map((entry) => entry.id),
        ["#3"],
      );
      assert.strictEqual(claimed.length, 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 1, title: "implement me", labels: ["ready-for-agent"] },
            { number: 2, title: "triage me", labels: ["needs-triage"] },
            { number: 3, title: "needs a human", labels: ["needs-info"] },
            { number: 4, title: "rejected", labels: ["wontfix", "ready-for-agent"] },
            { number: 5, title: "in review", labels: ["ready-for-agent"] },
            { number: 100, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 100, body: "Closes #5" })],
          comments: [
            {
              issue: 5,
              authorLogin: bot.login,
              body: serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
            },
          ],
          reviews: [{ pull: 100, state: "CHANGES_REQUESTED" }],
        }),
      ),
    ),
  );

  it.effect("round-trips a claim and an attempt through GitHub markers", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1_722_000_000_000, stage: "implement" };
      const attempt: AttemptRecord = { stage: "implement", outcome: "failed", atMillis: 1_722_000_000_001 };
      yield* source.claim(workspace, id("#7"), claim);
      yield* source.recordAttempt(workspace, id("#7"), attempt, "git worktree add: boom");
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#7");
      assert.deepStrictEqual(observed?.claim, claim);
      assert.deepStrictEqual(observed?.attempts, [attempt]);
      const client = yield* GitHubClient;
      const comments = botComments(yield* client.listComments(repo, 7));
      assert.include(comments[0]?.body ?? "", "Last implement attempt failed: git worktree add: boom");
      const { eligible, claimed } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.deepStrictEqual(claimed[0]?.claim, claim);
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 7, title: "claim me", labels: ["ready-for-agent"] }] })),
    ),
  );

  it.effect("ignores a claim marker forged by a non-bot commenter", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#8");
      assert.isNull(observed?.claim ?? null);
      const { eligible, claimed } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.strictEqual(claimed.length, 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 8, title: "targeted", labels: ["ready-for-agent", "clanker-forge:claimed"] }],
          comments: [
            {
              issue: 8,
              authorLogin: "attacker",
              authorAssociation: "NONE",
              body: "<!-- clanker-forge:claim by=attacker at=1 -->",
              createdAtMillis: 1,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("stops claiming after release removes the claim marker label", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      yield* source.claim(workspace, id("#7"), {
        by: "clanker-forge",
        claimedAtMillis: 1,
        stage: "implement",
      });
      yield* source.release(workspace, id("#7"));
      const items = yield* source.observe(workspace);
      assert.isNull(items.find((item) => item.id === "#7")?.claim ?? null);
      assert.strictEqual(classify(items).eligible.length, 1);
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 7, title: "claim me", labels: ["ready-for-agent"] }] })),
    ),
  );

  it.effect("reads failing checks, PR human comments, /fresh, and the follow-up marker from a bot PR", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#5");
      assert.strictEqual(observed?.pr?.checks, "failing");
      assert.strictEqual(observed?.pr?.latestHumanCommentAtMillis, 200);
      assert.isTrue(observed?.pr?.fresh);
      assert.deepStrictEqual(observed?.pr?.followUp, {
        checks: "failing",
        humanCommentAtMillis: 100,
        noProgress: 1,
      });
      const eligible = classify(items).eligible.find((entry) => entry.id === "#5");
      assert.strictEqual(eligible?.stage, "follow-up");
      assert.isTrue(eligible?.followUp?.fresh);
      assert.strictEqual(eligible?.followUp?.noProgress, 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 5, title: "in review", labels: ["ready-for-agent"] },
            { number: 100, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 100, body: "Closes #5" })],
          comments: [
            {
              issue: 100,
              authorLogin: "maintainer",
              authorAssociation: "COLLABORATOR",
              body: "please /fresh start",
              createdAtMillis: 200,
            },
            {
              issue: 5,
              authorLogin: bot.login,
              authorAssociation: "NONE",
              body: serializeFollowUp({ checks: "failing", humanCommentAtMillis: 100, noProgress: 1 }),
              createdAtMillis: 150,
            },
          ],
          checks: [
            { sha: "sha-100", name: "ci", status: "completed", conclusion: "failure", startedAtMillis: 1 },
          ],
        }),
      ),
    ),
  );

  it.effect("owns a write-access human-authored PR when the issue carries the daemon's marker", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const owned = items.find((item) => item.id === "#20");
      const unowned = items.find((item) => item.id === "#21");
      assert.strictEqual(owned?.pr?.review, "changes-requested");
      assert.isNull(unowned?.pr ?? null);
      const { eligible } = classify(items);
      assert.strictEqual(eligible.find((entry) => entry.id === "#20")?.stage, "follow-up");
      assert.strictEqual(eligible.find((entry) => entry.id === "#21")?.stage, "implement");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 20, title: "owned", labels: ["ready-for-agent"] },
            { number: 21, title: "unowned", labels: ["ready-for-agent"] },
            { number: 200, title: "human pr", labels: [], isPullRequest: true },
            { number: 201, title: "human pr", labels: [], isPullRequest: true },
          ],
          pulls: [
            pull({
              number: 200,
              authorLogin: "taylorfsteele",
              authorAssociation: "OWNER",
              body: "Closes #20",
            }),
            pull({
              number: 201,
              authorLogin: "taylorfsteele",
              authorAssociation: "OWNER",
              body: "Closes #21",
            }),
          ],
          comments: [
            {
              issue: 20,
              authorLogin: bot.login,
              body: serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
            },
          ],
          reviews: [{ pull: 200, state: "CHANGES_REQUESTED" }],
        }),
      ),
    ),
  );

  it.effect("refuses to adopt a PR from an author without write access, even on an owned issue", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#25");
      assert.isNull(observed?.pr ?? null);
      assert.isUndefined(
        classify(items).eligible.find((entry) => entry.id === "#25" && entry.stage === "follow-up"),
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 25, title: "owned issue, hostile pr", labels: ["ready-for-agent"] },
            { number: 205, title: "fork pr", labels: [], isPullRequest: true },
          ],
          pulls: [
            pull({ number: 205, authorLogin: "drive-by", authorAssociation: "NONE", body: "Closes #25" }),
          ],
          comments: [
            {
              issue: 25,
              authorLogin: bot.login,
              body: serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
            },
          ],
          reviews: [
            { pull: 205, state: "CHANGES_REQUESTED", authorLogin: "drive-by", authorAssociation: "NONE" },
          ],
        }),
      ),
    ),
  );

  it.effect("ignores a changes-requested review from an author without write access", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#26");
      assert.strictEqual(observed?.pr?.review, "pending");
      assert.isUndefined(
        classify(items).eligible.find((entry) => entry.id === "#26" && entry.stage === "follow-up"),
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 26, title: "owned bot pr, hostile review", labels: ["ready-for-agent"] },
            { number: 206, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 206, body: "Closes #26" })],
          comments: [
            {
              issue: 26,
              authorLogin: bot.login,
              body: serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
            },
          ],
          reviews: [
            { pull: 206, state: "CHANGES_REQUESTED", authorLogin: "drive-by", authorAssociation: "NONE" },
          ],
        }),
      ),
    ),
  );

  it.effect("treats an inline review comment as human feedback that triggers follow-up", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#22");
      assert.strictEqual(observed?.pr?.latestHumanCommentAtMillis, 300);
      assert.strictEqual(classify(items).eligible.find((entry) => entry.id === "#22")?.stage, "follow-up");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 22, title: "inline review", labels: ["ready-for-agent"] },
            { number: 202, title: "human pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 202, authorLogin: "taylorfsteele", body: "Closes #22" })],
          comments: [
            {
              issue: 22,
              authorLogin: bot.login,
              body: serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
            },
          ],
          reviewComments: [
            {
              issue: 202,
              authorLogin: "maintainer",
              authorAssociation: "COLLABORATOR",
              body: "tweak this line",
              createdAtMillis: 300,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("treats a COMMENTED review with a body as feedback but ignores an empty one", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const withBody = items.find((item) => item.id === "#23");
      const empty = items.find((item) => item.id === "#24");
      assert.strictEqual(withBody?.pr?.latestHumanCommentAtMillis, 400);
      assert.isNull(empty?.pr?.latestHumanCommentAtMillis ?? null);
      const { eligible } = classify(items);
      assert.strictEqual(eligible.find((entry) => entry.id === "#23")?.stage, "follow-up");
      assert.isUndefined(eligible.find((entry) => entry.id === "#24"));
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 23, title: "review with body", labels: ["ready-for-agent"] },
            { number: 24, title: "empty review", labels: ["ready-for-agent"] },
            { number: 203, title: "human pr", labels: [], isPullRequest: true },
            { number: 204, title: "human pr", labels: [], isPullRequest: true },
          ],
          pulls: [
            pull({ number: 203, authorLogin: "taylorfsteele", body: "Closes #23" }),
            pull({ number: 204, authorLogin: "taylorfsteele", body: "Closes #24" }),
          ],
          comments: [23, 24].map((issue) => ({
            issue,
            authorLogin: bot.login,
            body: serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
          })),
          reviews: [
            { pull: 203, state: "COMMENTED", body: "please adjust", submittedAtMillis: 400 },
            { pull: 204, state: "COMMENTED", body: "", submittedAtMillis: 400 },
          ],
        }),
      ),
    ),
  );

  it.effect("never exposes a merge or review-thread-resolution capability", () =>
    Effect.gen(function* () {
      const forbidden = /merge|resolve/i;
      const client = yield* fakeClient({ issues: [] });
      assert.isFalse(Object.keys(client).some((method) => forbidden.test(method)));
      const source = yield* WorkSource;
      assert.isFalse(Object.keys(source).some((method) => forbidden.test(method)));
    }).pipe(Effect.provide(withClient({ issues: [] }))),
  );

  it.effect("counts prior attempts and escalates past the cap even without the claim label", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#9");
      assert.strictEqual(observed?.attempts.length, 3);
      const { eligible, needsHuman } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.include(
        needsHuman.map((entry) => entry.id),
        id("#9"),
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 9, title: "keeps failing", labels: ["needs-triage"] }],
          comments: [1, 2, 3].map((at) => ({
            issue: 9,
            authorLogin: bot.login,
            authorAssociation: "NONE",
            body: serializeAttempt({ stage: "triage", outcome: "failed", atMillis: at }),
            createdAtMillis: at,
          })),
        }),
      ),
    ),
  );

  it.effect("consolidates claim and attempt markers into one visible status comment", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      const first: Claim = { by: "clanker-forge", claimedAtMillis: 10, stage: "implement" };
      const attempt: AttemptRecord = { stage: "implement", outcome: "failed", atMillis: 11 };
      const second: Claim = { by: "clanker-forge", claimedAtMillis: 12, stage: "implement" };
      yield* source.claim(workspace, id("#11"), first);
      yield* source.recordAttempt(workspace, id("#11"), attempt);
      yield* source.claim(workspace, id("#11"), second);
      const comments = botComments(yield* client.listComments(repo, 11));
      assert.strictEqual(comments.length, 1);
      assert.isTrue(hasLedgerMarker(comments[0]?.body ?? ""));
      assert.include(comments[0]?.body ?? "", "Currently implementing this issue.");
      assert.include(comments[0]?.body ?? "", "<!-- clanker-forge:attempt");
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#11");
      assert.deepStrictEqual(observed?.claim, second);
      assert.deepStrictEqual(observed?.attempts, [attempt]);
    }).pipe(
      Effect.provide(
        withClient({ issues: [{ number: 11, title: "consolidate me", labels: ["ready-for-agent"] }] }),
      ),
    ),
  );

  it.effect("keeps every failed attempt across edits so the cap still escalates", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      for (const at of [1, 2, 3]) {
        yield* source.recordAttempt(workspace, id("#12"), {
          stage: "triage",
          outcome: "failed",
          atMillis: at,
        });
      }
      const comments = botComments(yield* client.listComments(repo, 12));
      assert.strictEqual(comments.length, 1);
      assert.include(comments[0]?.body ?? "", "Last triage attempt failed.");
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#12");
      assert.strictEqual(observed?.attempts.length, 3);
      assert.include(
        classify(items).needsHuman.map((entry) => entry.id),
        id("#12"),
      );
    }).pipe(
      Effect.provide(
        withClient({ issues: [{ number: 12, title: "retry budget", labels: ["needs-triage"] }] }),
      ),
    ),
  );

  it.effect("ignores an impostor ledger comment and creates its own", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      yield* source.claim(workspace, id("#14"), {
        by: "clanker-forge",
        claimedAtMillis: 1,
        stage: "triage",
      });
      const comments = yield* client.listComments(repo, 14);
      const ours = botComments(comments);
      assert.strictEqual(comments.length, 2);
      assert.strictEqual(ours.length, 1);
      assert.isTrue(hasLedgerMarker(ours[0]?.body ?? ""));
      assert.include(ours[0]?.body ?? "", "Currently triaging this issue.");
      assert.isFalse(ours[0]?.body.includes("by=attacker") ?? true);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 14, title: "spoofed", labels: ["ready-for-agent"] }],
          comments: [
            {
              issue: 14,
              authorLogin: "attacker",
              body: "<!-- clanker-forge:ledger -->\n<!-- clanker-forge:claim by=attacker at=1 -->",
            },
          ],
        }),
      ),
    ),
  );

  it.effect("leaves legacy marker comments alone and writes new markers to a coordination comment", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      const legacyAttempt: AttemptRecord = { stage: "triage", outcome: "failed", atMillis: 1 };
      const claim: Claim = { by: "clanker-forge", claimedAtMillis: 2, stage: "implement" };
      yield* source.claim(workspace, id("#15"), claim);
      const comments = botComments(yield* client.listComments(repo, 15));
      assert.strictEqual(comments.length, 2);
      assert.strictEqual(comments.filter((comment) => hasLedgerMarker(comment.body)).length, 1);
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#15");
      assert.deepStrictEqual(observed?.claim, claim);
      assert.deepStrictEqual(observed?.attempts, [legacyAttempt]);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 15, title: "legacy markers", labels: ["ready-for-agent", "clanker-forge:claimed"] },
          ],
          comments: [
            {
              issue: 15,
              authorLogin: bot.login,
              body: serializeAttempt({ stage: "triage", outcome: "failed", atMillis: 1 }),
            },
          ],
        }),
      ),
    ),
  );

  it.effect("posts each triage proposal as its own comment beside the coordination comment", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1, stage: "triage" };
      const attempt: AttemptRecord = { stage: "triage", outcome: "succeeded", atMillis: 2 };
      yield* source.claim(workspace, id("#16"), claim);
      yield* source.note(workspace, id("#16"), "Triage proposal body");
      yield* source.recordAttempt(workspace, id("#16"), attempt);
      yield* source.claim(workspace, id("#16"), {
        by: "clanker-forge",
        claimedAtMillis: 3,
        stage: "implement",
      });
      const comments = botComments(yield* client.listComments(repo, 16));
      assert.strictEqual(comments.length, 2);
      const coordination = comments.find((comment) => hasLedgerMarker(comment.body));
      const proposal = comments.find((comment) => !hasLedgerMarker(comment.body));
      assert.isDefined(coordination);
      assert.isDefined(proposal);
      assert.include(proposal?.body ?? "", "Triage proposal body");
      assert.notInclude(coordination?.body ?? "", "Triage proposal body");
      assert.include(coordination?.body ?? "", "Currently implementing this issue.");
      const observed = (yield* source.observe(workspace)).find((item) => item.id === "#16");
      assert.deepStrictEqual(observed?.attempts, [attempt]);
      assert.deepStrictEqual(observed?.claim, {
        by: "clanker-forge",
        claimedAtMillis: 3,
        stage: "implement",
      });
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 16, title: "proposal", labels: ["needs-triage"] }] })),
    ),
  );

  it.effect("keeps prior triage proposals when triage runs again", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      yield* source.note(workspace, id("#17"), "First proposal");
      yield* source.note(workspace, id("#17"), "Second proposal");
      const comments = botComments(yield* client.listComments(repo, 17));
      assert.strictEqual(comments.length, 2);
      assert.include(comments[0]?.body ?? "", "First proposal");
      assert.include(comments[1]?.body ?? "", "Second proposal");
      assert.isFalse(comments.some((comment) => hasLedgerMarker(comment.body)));
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 17, title: "rerun", labels: ["needs-triage"] }] })),
    ),
  );

  it.effect("clears a leftover coordination detail when posting a new triage proposal", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      yield* source.recordFollowUp(
        workspace,
        id("#20"),
        { checks: "failing", humanCommentAtMillis: 1, noProgress: 1 },
        "Old folded detail",
      );
      yield* source.note(workspace, id("#20"), "Fresh triage proposal");
      const comments = botComments(yield* client.listComments(repo, 20));
      const coordination = comments.find((comment) => hasLedgerMarker(comment.body));
      const proposal = comments.find((comment) => !hasLedgerMarker(comment.body));
      assert.isDefined(coordination);
      assert.isDefined(proposal);
      assert.notInclude(coordination?.body ?? "", "Old folded detail");
      assert.include(proposal?.body ?? "", "Fresh triage proposal");
    }).pipe(
      Effect.provide(
        withClient({ issues: [{ number: 20, title: "clear detail", labels: ["needs-triage"] }] }),
      ),
    ),
  );

  it.effect("ignores marker syntax embedded in a triage proposal comment", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1, stage: "triage" };
      const attempt: AttemptRecord = { stage: "triage", outcome: "succeeded", atMillis: 2 };
      yield* source.claim(workspace, id("#21"), claim);
      yield* source.note(
        workspace,
        id("#21"),
        `Looks done ${serializeAttempt({ stage: "triage", outcome: "failed", atMillis: 99 })}`,
      );
      yield* source.recordAttempt(workspace, id("#21"), attempt);
      const proposal = botComments(yield* client.listComments(repo, 21)).find(
        (comment) => !hasLedgerMarker(comment.body),
      );
      assert.include(proposal?.body ?? "", "Looks done");
      assert.notInclude(proposal?.body ?? "", "outcome=failed");
      const observed = (yield* source.observe(workspace)).find((item) => item.id === "#21");
      assert.deepStrictEqual(observed?.attempts, [attempt]);
      assert.deepStrictEqual(observed?.claim, claim);
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 21, title: "poison", labels: ["needs-triage"] }] })),
    ),
  );

  it.effect("lets the coordination comment outrank a legacy marker comment written after it", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const stale: FollowUpMarker = { checks: "pending", humanCommentAtMillis: 1, noProgress: 0 };
      const current: FollowUpMarker = { checks: "failing", humanCommentAtMillis: 9, noProgress: 2 };
      yield* source.recordFollowUp(workspace, id("#19"), current);
      const observed = (yield* source.observe(workspace)).find((item) => item.id === "#19");
      assert.notDeepEqual(observed?.pr?.followUp, stale);
      assert.deepStrictEqual(observed?.pr?.followUp, current);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 19, title: "legacy follow-up", labels: ["ready-for-agent"] },
            { number: 102, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 102, body: "Closes #19" })],
          comments: [
            {
              issue: 19,
              authorLogin: bot.login,
              body: "<!-- clanker-forge:ledger -->\n<!-- clanker-forge:claim by=clanker-forge at=1 -->",
              createdAtMillis: 1,
            },
            {
              issue: 19,
              authorLogin: bot.login,
              body: serializeFollowUp({ checks: "pending", humanCommentAtMillis: 1, noProgress: 0 }),
              createdAtMillis: 2,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("records a follow-up marker with a visible status instead of a marker-only comment", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const client = yield* GitHubClient;
      const marker: FollowUpMarker = { checks: "failing", humanCommentAtMillis: 4, noProgress: 1 };
      yield* source.recordFollowUp(workspace, id("#18"), marker);
      const comments = botComments(yield* client.listComments(repo, 18));
      assert.strictEqual(comments.length, 1);
      assert.include(comments[0]?.body ?? "", defaultStatus);
      const observed = (yield* source.observe(workspace)).find((item) => item.id === "#18");
      assert.deepStrictEqual(observed?.pr?.followUp, marker);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 18, title: "in review", labels: ["ready-for-agent"] },
            { number: 101, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 101, body: "Closes #18" })],
        }),
      ),
    ),
  );
});
