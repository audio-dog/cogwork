import { type AttemptRecord, type Claim, WorkItemId, WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { classify } from "../src/classify";
import { layer as adapterLayer } from "../src/github/adapter";
import { GitHubClient, type GitHubClientService, type RawComment, type RawPull } from "../src/github/client";
import type { RegisteredWorkspace } from "../src/projector";
import { WorkSource } from "../src/WorkSource";

const id = Schema.decodeSync(WorkItemId);

interface SeedIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly isPullRequest?: boolean;
}

interface Seed {
  readonly issues: ReadonlyArray<SeedIssue>;
  readonly pulls?: ReadonlyArray<RawPull>;
  readonly comments?: ReadonlyArray<{ readonly issue: number } & RawComment>;
}

const bot = { login: "clanker-forge[bot]" } as const;

const fakeClient = Effect.fn("github.fakeClient")(function* (seed: Seed) {
  const issuesRef = yield* Ref.make(
    seed.issues.map((issue) => ({ ...issue, isPullRequest: issue.isPullRequest ?? false })),
  );
  const seededComments = (seed.comments ?? []).reduce(
    (all, { issue, ...comment }) => all.set(issue, [...(all.get(issue) ?? []), comment]),
    new Map<number, ReadonlyArray<RawComment>>(),
  );
  const commentsRef = yield* Ref.make(seededComments);
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
    listPulls: () => Effect.succeed(pulls),
    listComments: (_repo, number) => Ref.get(commentsRef).pipe(Effect.map((all) => all.get(number) ?? [])),
    addLabel: (_repo, number, label) =>
      patch(number, (issue) => ({ ...issue, labels: [...issue.labels, label] })),
    removeLabel: (_repo, number, label) =>
      patch(number, (issue) => ({
        ...issue,
        labels: issue.labels.filter((existing) => existing !== label),
      })),
    createComment: (_repo, number, body) =>
      Ref.update(commentsRef, (all) =>
        new Map(all).set(number, [...(all.get(number) ?? []), { authorLogin: bot.login, body }]),
      ),
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
  adapterLayer.pipe(Layer.provide(Layer.effect(GitHubClient, fakeClient(seed))));

const pull = (over: Partial<RawPull> & { readonly number: number; readonly body: string }): RawPull => ({
  authorLogin: "clanker-forge[bot]",
  draft: false,
  reviewDecision: "none",
  ...over,
});

describe("github work source adapter", () => {
  it.effect("derives the actionable set from labels and bot-PR state", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
      const { eligible, blocked, claimed } = classify(items);
      assert.deepStrictEqual(
        eligible.map((entry) => [entry.id, entry.stage]),
        [
          ["#5", "follow-up"],
          ["#2", "triage"],
          ["#1", "implement"],
        ],
      );
      assert.deepStrictEqual(
        blocked.map((entry) => entry.id),
        ["#3"],
      );
      assert.strictEqual(claimed.length, 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 1, title: "implement me", labels: ["ready-for-agent"] },
            { number: 2, title: "triage me", labels: ["needs-triage"] },
            { number: 3, title: "blocked", labels: ["needs-info"] },
            { number: 4, title: "rejected", labels: ["wontfix", "ready-for-agent"] },
            { number: 5, title: "in review", labels: ["ready-for-agent"] },
            { number: 100, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 100, body: "Closes #5", reviewDecision: "changes-requested" })],
        }),
      ),
    ),
  );

  it.effect("round-trips a claim and an attempt through GitHub markers", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1_722_000_000_000 };
      const attempt: AttemptRecord = { stage: "implement", outcome: "failed", atMillis: 1_722_000_000_001 };
      yield* source.claim(workspace, id("#7"), claim);
      yield* source.recordAttempt(workspace, id("#7"), attempt);
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "#7");
      assert.deepStrictEqual(observed?.claim, claim);
      assert.deepStrictEqual(observed?.attempts, [attempt]);
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
            { issue: 8, authorLogin: "attacker", body: "<!-- clanker-forge:claim by=attacker at=1 -->" },
          ],
        }),
      ),
    ),
  );

  it.effect("stops claiming after release removes the claim marker label", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      yield* source.claim(workspace, id("#7"), { by: "clanker-forge", claimedAtMillis: 1 });
      yield* source.release(workspace, id("#7"));
      const items = yield* source.observe(workspace);
      assert.isNull(items.find((item) => item.id === "#7")?.claim ?? null);
      assert.strictEqual(classify(items).eligible.length, 1);
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 7, title: "claim me", labels: ["ready-for-agent"] }] })),
    ),
  );
});
