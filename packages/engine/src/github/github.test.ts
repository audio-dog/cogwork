import {
  type AttemptRecord,
  type Claim,
  type Priority,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { CheckRun } from "../ci";
import { classify } from "../classify";
import { triageProposalBody } from "../comments";
import * as Coordination from "../coordination";
import type { FollowUpMarker } from "../follow-up";
import { IssueTracker, IssueTrackerError } from "../issue-tracker";
import { observeWorkspace } from "../observe";
import type { RegisteredWorkspace } from "../projector";
import { SourceControlProvider } from "../source-control";
import { layer as adapterLayer } from "./adapter";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawIssue,
  type RawPull,
  type RawReview,
} from "./client";
import { agentNoteMarker, hasCogworkMarker, wireCodec } from "./markers";
import { layer as providerLayer } from "./provider";

const id = Schema.decodeSync(WorkItemId);

const defaultStatus = Coordination.defaultStatus;
const serializeClaim = (claim: Claim) => Coordination.serializeClaim(wireCodec, claim);
const serializeAttempt = (attempt: AttemptRecord) => Coordination.serializeAttempt(wireCodec, attempt);
const serializeFollowUp = (marker: FollowUpMarker) => Coordination.serializeFollowUp(wireCodec, marker);

const coordinationBody = (markers: ReadonlyArray<string>) =>
  Coordination.formatCoordinationBody(wireCodec, { status: defaultStatus, markers, detail: null });

interface SeedIssue {
  readonly number: number;
  readonly title: string;
  readonly url?: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly isPullRequest?: boolean;
  readonly openBlockers?: number;
  readonly body?: string;
  readonly state?: "open" | "closed";
  readonly createdAtMillis?: number;
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
  readonly mergeable?: ReadonlyArray<{ readonly pull: number; readonly state: string | null }>;
  readonly priorities?: ReadonlyArray<{ readonly issue: number; readonly priority: Priority }>;
  readonly priorityError?: boolean;
  readonly pullRequestError?: boolean;
}

class ProviderCalls extends Context.Service<
  ProviderCalls,
  {
    readonly listPulls: Ref.Ref<number>;
    readonly details: Ref.Ref<number>;
  }
>()("@cogwork/engine/github/github.test/ProviderCalls") {
  static readonly layer = Layer.effect(
    ProviderCalls,
    Effect.gen(function* () {
      const listPulls = yield* Ref.make(0);
      const details = yield* Ref.make(0);
      return { listPulls, details };
    }),
  );
}

const bot = { login: "cogwork[bot]" } as const;
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
    seed.issues.map(
      (issue): RawIssue => ({
        ...issue,
        url: issue.url ?? `https://github.com/owner/repo/issues/${issue.number}`,
        assignees: issue.assignees ?? [],
        isPullRequest: issue.isPullRequest ?? false,
        openBlockers: issue.openBlockers ?? 0,
        body: issue.body ?? "",
        state: issue.state ?? "open",
        createdAtMillis: issue.createdAtMillis ?? 0,
      }),
    ),
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
  const mergeableByPull = new Map((seed.mergeable ?? []).map(({ pull, state }) => [pull, state]));
  const prioritiesByNumber: ReadonlyMap<number, Priority> = new Map(
    (seed.priorities ?? []).map(({ issue, priority }) => [issue, priority]),
  );
  const patch = (number: number, update: (issue: RawIssue) => RawIssue) =>
    Ref.update(issuesRef, (issues) =>
      issues.map((issue) => (issue.number === number ? update(issue) : issue)),
    );
  return {
    authenticatedLogin: () => Effect.succeed(bot.login),
    listIssues: () => Ref.get(issuesRef),
    listPulls: () => Effect.succeed([...pulls]),
    issuePullReferences: () => Effect.succeed([]),
    pullMergeableState: (_repo, number) => Effect.succeed(mergeableByPull.get(number) ?? null),
    listComments: (_repo, number) =>
      Ref.get(commentsRef).pipe(Effect.map((all) => [...(all.get(number) ?? [])])),
    listReviewComments: (_repo, number) => Effect.succeed([...(reviewComments.get(number) ?? [])]),
    listReviews: (_repo, number) => Effect.succeed([...(reviewsByPull.get(number) ?? [])]),
    createIssue: () => Effect.void,
    createPull: () =>
      seed.pullRequestError
        ? Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "pull request rejected" }))
        : Effect.succeed({ number: 480, url: "https://github.com/owner/repo/pull/480" }),
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
    projectPriorities: () =>
      seed.priorityError
        ? Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "missing read:project scope" }))
        : Effect.succeed(prioritiesByNumber),
    verifyCredential: () => Effect.succeed(bot.login),
  } satisfies GitHubClientService;
});

const workspace: RegisteredWorkspace = {
  source: "gh.workspace.ts",
  repository: "owner/repo",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github" },
  }),
};

const missingTargetWorkspace: RegisteredWorkspace = {
  source: "linear.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "missing-target",
    checkoutPath: "/repos/missing-target",
    issueTracker: { type: "linear" },
    sourceControl: { type: "github" },
  }),
};

const trustsCursorBot: RegisteredWorkspace = {
  source: "gh.workspace.ts",
  repository: "owner/repo",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh-bots",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github" },
    sourceControl: {
      type: "github",
      botAllowlist: ["cursor[bot]"],
    },
  }),
};

const prioritizedWorkspace: RegisteredWorkspace = {
  source: "gh.workspace.ts",
  repository: "owner/repo",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh-priority",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", priority: { project: 1 } },
  }),
};

const withClient = (seed: Seed) =>
  Layer.mergeAll(adapterLayer, providerLayer).pipe(
    Layer.provideMerge(Layer.effect(GitHubClient, fakeClient(seed))),
  );

const withIdentityFailure = (seed: Seed) =>
  Layer.mergeAll(adapterLayer, providerLayer).pipe(
    Layer.provideMerge(
      Layer.effect(
        GitHubClient,
        Effect.map(fakeClient(seed), (client) => ({
          ...client,
          authenticatedLogin: () =>
            Effect.fail(new IssueTrackerError({ reason: "auth", message: "GitHub identity unavailable" })),
        })),
      ),
    ),
  );

const countingProviderLayer = (seed: Seed) =>
  providerLayer.pipe(
    Layer.provideMerge(
      Layer.effect(
        GitHubClient,
        Effect.gen(function* () {
          const calls = yield* ProviderCalls;
          const baseClient = yield* fakeClient(seed);
          return {
            ...baseClient,
            listPulls: (_target) =>
              Ref.update(calls.listPulls, (count) => count + 1).pipe(Effect.andThen(baseClient.listPulls())),
            listCheckRuns: (target, sha) =>
              Ref.update(calls.details, (count) => count + 1).pipe(
                Effect.andThen(baseClient.listCheckRuns(target, sha)),
              ),
          } satisfies GitHubClientService;
        }),
      ).pipe(Layer.provideMerge(ProviderCalls.layer)),
    ),
  );

const observeItems = (workspace: RegisteredWorkspace) =>
  Effect.gen(function* () {
    const tracker = yield* IssueTracker;
    const provider = yield* SourceControlProvider;
    return yield* observeWorkspace(tracker, provider)(workspace);
  });

const pull = (over: Partial<RawPull> & { readonly number: number; readonly headRef: string }): RawPull => ({
  url: `https://github.com/owner/repo/pull/${over.number}`,
  authorLogin: "cogwork[bot]",
  authorAssociation: "MEMBER",
  draft: false,
  headSha: `sha-${over.number}`,
  headRepository: "owner/repo",
  closingIssueNumbers: [],
  updatedAtMillis: 0,
  ...over,
});

const followUpTriggerSeed = (over: Pick<RawPull, "authorLogin" | "draft">) => ({
  issues: [
    { number: 20, title: "conflicting", labels: ["ready-for-agent"] },
    { number: 21, title: "failing", labels: ["ready-for-agent"] },
    { number: 22, title: "changes requested", labels: ["ready-for-agent"] },
    { number: 23, title: "new comment", labels: ["ready-for-agent"] },
  ],
  pulls: [
    pull({ number: 200, headRef: "20-conflicting", ...over }),
    pull({ number: 201, headRef: "21-failing", ...over }),
    pull({ number: 202, headRef: "22-changes-requested", ...over }),
    pull({ number: 203, headRef: "23-new-comment", ...over }),
  ],
  checks: [
    {
      sha: "sha-201",
      name: "test",
      status: "completed",
      conclusion: "failure",
      startedAtMillis: 1,
    },
  ],
  comments: [
    {
      issue: 203,
      authorLogin: "maintainer",
      authorAssociation: "MEMBER",
      body: "Please fix this.",
      createdAtMillis: 1,
    },
  ],
  reviews: [{ pull: 202, state: "CHANGES_REQUESTED" }],
  mergeable: [{ pull: 200, state: "dirty" }],
});

describe("GitHub adapters", () => {
  it.effect("derives the actionable set from labels and bot-PR state", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
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
          pulls: [pull({ number: 100, headRef: "5-in-review" })],
          comments: [
            {
              issue: 5,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
          reviews: [{ pull: 100, state: "CHANGES_REQUESTED" }],
        }),
      ),
    ),
  );

  it.effect("posts a round summary to the linked PR and appends the coordination marker itself", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const client = yield* GitHubClient;
      yield* provider.comment(workspace, { id: id("#5"), title: "in review" }, "Fixed the flaky check.");
      const comments = yield* client.listComments(repo, 100);
      const [posted] = comments;
      assert.include(posted?.body ?? "", "Fixed the flaky check.");
      assert.include(posted?.body ?? "", agentNoteMarker);
      assert.isTrue(hasCogworkMarker(posted?.body ?? ""));
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 5, title: "in review", labels: ["ready-for-agent"] }],
          pulls: [pull({ number: 100, headRef: "5-in-review" })],
        }),
      ),
    ),
  );

  it.effect("opens a pull request through the configured source control target", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const opened = yield* provider.openPullRequest(workspace, {
        headBranch: "472-open-pull-request",
        baseBranch: "main",
        title: "Open pull requests from the engine",
        body: "Closes #472",
      });
      assert.deepStrictEqual(opened, {
        number: 480,
        url: "https://github.com/owner/repo/pull/480",
      });
    }).pipe(Effect.provide(withClient({ issues: [] }))),
  );

  it.effect("refuses pull request creation permanently without a GitHub target", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const error = yield* Effect.flip(
        provider.openPullRequest(missingTargetWorkspace, {
          headBranch: "474-ready",
          baseBranch: "main",
          title: "Open pull requests from the engine",
          body: "Closes #474",
        }),
      );

      assert.strictEqual(error.reason, "unavailable");
      assert.isFalse(error.retryable);
    }).pipe(Effect.provide(withClient({ issues: [] }))),
  );

  it.effect("finds an open pull request for the exact same-repository head", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const found = yield* provider.findOpenPullRequest(workspace, "474-ready");
      assert.deepStrictEqual(found, {
        number: 474,
        url: "https://github.com/owner/repo/pull/474",
      });
    }).pipe(
      Effect.provide(
        withClient({
          issues: [],
          pulls: [pull({ number: 474, headRef: "474-ready", authorAssociation: "NONE" })],
        }),
      ),
    ),
  );

  it.effect("preserves a pull request provider failure in the typed error channel", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const error = yield* Effect.flip(
        provider.openPullRequest(workspace, {
          headBranch: "472-open-pull-request",
          baseBranch: "main",
          title: "Open pull requests from the engine",
          body: "Closes #472",
        }),
      );
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(error.message, "pull request rejected");
    }).pipe(Effect.provide(withClient({ issues: [], pullRequestError: true }))),
  );

  it.effect("posts nothing when the item has no linked pull request", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const client = yield* GitHubClient;
      yield* provider.comment(workspace, { id: id("#5"), title: "in review" }, "orphaned summary");
      assert.isEmpty(yield* client.listComments(repo, 100));
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 5, title: "in review", labels: ["ready-for-agent"] }],
          pulls: [],
        }),
      ),
    ),
  );

  it.effect("lists PRs once and reads details only for linked trusted PRs", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const calls = yield* ProviderCalls;
      const signals = yield* provider.observe(workspace, [
        { id: id("#1"), title: "linked" },
        { id: id("#2"), title: "untrusted" },
        { id: id("#3"), title: "no pull request" },
      ]);
      assert.deepStrictEqual([...signals.keys()], [id("#1")]);
      assert.strictEqual(yield* Ref.get(calls.listPulls), 1);
      assert.strictEqual(yield* Ref.get(calls.details), 1);
    }).pipe(
      Effect.provide(
        countingProviderLayer({
          issues: [],
          pulls: [
            pull({ number: 100, headRef: "1-linked" }),
            pull({
              number: 101,
              headRef: "2-untrusted",
              authorLogin: "outsider",
              authorAssociation: "NONE",
            }),
          ],
        }),
      ),
    ),
  );

  it.effect("reads a dirty mergeable_state as a conflict and routes the PR to follow-up", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#6");
      assert.strictEqual(observed?.pr?.baseDivergence, "conflict");
      const eligible = classify(items).eligible.find((entry) => entry.id === "#6");
      assert.strictEqual(eligible?.stage, "follow-up");
      assert.strictEqual(eligible?.followUp?.baseDivergence, "conflict");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 6, title: "conflicting", labels: ["ready-for-agent"] },
            { number: 103, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 103, headRef: "6-conflicting" })],
          comments: [
            {
              issue: 6,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
          mergeable: [{ pull: 103, state: "dirty" }],
        }),
      ),
    ),
  );

  it.effect("leaves a merely-behind bot PR out of follow-up", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.find((item) => item.id === "#9")?.pr?.baseDivergence, "clean");
      assert.strictEqual(classify(items).eligible.length, 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 9, title: "behind but clean", labels: ["ready-for-agent"] },
            { number: 104, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [pull({ number: 104, headRef: "9-behind-but-clean" })],
          comments: [
            {
              issue: 9,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
          mergeable: [{ pull: 104, state: "behind" }],
        }),
      ),
    ),
  );

  it.effect("reads open blockers from the issue listing and holds those tickets as blocked", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.find((item) => item.id === "#30")?.openBlockers, 1);
      assert.strictEqual(items.find((item) => item.id === "#31")?.openBlockers, 0);
      const { eligible, blocked } = classify(items);
      assert.deepStrictEqual(blocked, [
        {
          id: id("#30"),
          title: "waits on #31",
          url: "https://github.com/owner/repo/issues/30",
          openBlockers: 1,
        },
      ]);
      assert.deepStrictEqual(
        eligible.map((entry) => entry.id),
        [id("#31")],
      );
      assert.deepStrictEqual(yield* client.listComments(repo, 30), []);
      assert.deepStrictEqual((yield* client.listIssues(repo)).at(0)?.labels, ["ready-for-agent"]);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 30, title: "waits on #31", labels: ["ready-for-agent"], openBlockers: 1 },
            { number: 31, title: "the blocker", labels: ["ready-for-agent"] },
          ],
        }),
      ),
    ),
  );

  it.effect("reads a claim under a different bot login as not ours", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#33");
      assert.strictEqual(observed?.claim?.by, "other-agent[bot]");
      assert.isFalse(observed?.claimedByUs);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            {
              number: 33,
              title: "another daemon's claim",
              labels: ["ready-for-agent", "cogwork:claimed"],
            },
          ],
          comments: [
            {
              issue: 33,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeClaim({ by: "other-agent[bot]", claimedAtMillis: 1, stage: "implement" }),
              ]),
            },
          ],
        }),
      ),
    ),
  );

  it.effect("recognizes the legacy fallback claimant on its authenticated ledger", () =>
    Effect.gen(function* () {
      const [observed] = yield* observeItems(workspace);
      assert.strictEqual(observed?.claim?.by, Coordination.defaultClaimant);
      assert.isTrue(observed?.claimedByUs);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 34, title: "legacy claim", labels: ["ready-for-agent", "cogwork:claimed"] }],
          comments: [
            {
              issue: 34,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeClaim({
                  by: Coordination.defaultClaimant,
                  claimedAtMillis: 1,
                  stage: "implement",
                }),
              ]),
            },
          ],
        }),
      ),
    ),
  );

  it.effect("uses the authenticated account for claims and coordination ownership", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      yield* source.claim(workspace, id("#7"), { claimedAtMillis: 1, stage: "implement" });
      const observed = (yield* observeItems(workspace)).find((item) => item.id === "#7");
      assert.strictEqual(observed?.claim?.by, bot.login);
      assert.isTrue(observed?.claimedByUs);
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 7, title: "claim me", labels: ["ready-for-agent"] }] })),
    ),
  );

  it.effect("fails observation when authenticated identity cannot be established", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(observeItems(workspace));
      assert.strictEqual(error.reason, "auth");
      assert.include(error.message, "identity unavailable");
    }).pipe(
      Effect.provide(
        withIdentityFailure({
          issues: [{ number: 8, title: "must not dispatch", labels: ["ready-for-agent"] }],
        }),
      ),
    ),
  );

  it.effect("ignores a claim marker forged by a non-bot commenter", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#8");
      assert.isNull(observed?.claim ?? null);
      const { eligible, claimed } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.strictEqual(claimed.length, 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 8, title: "targeted", labels: ["ready-for-agent", "cogwork:claimed"] }],
          comments: [
            {
              issue: 8,
              authorLogin: "attacker",
              authorAssociation: "NONE",
              body: "<!-- cogwork:claim by=attacker at=1 -->",
              createdAtMillis: 1,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("stops claiming after release removes the claim marker label", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      yield* source.claim(workspace, id("#7"), { claimedAtMillis: 1, stage: "implement" });
      yield* source.release(workspace, id("#7"));
      const items = yield* observeItems(workspace);
      assert.isNull(items.find((item) => item.id === "#7")?.claim ?? null);
      assert.strictEqual(classify(items).eligible.length, 1);
    }).pipe(
      Effect.provide(withClient({ issues: [{ number: 7, title: "claim me", labels: ["ready-for-agent"] }] })),
    ),
  );

  it.effect("reads failing checks, PR human comments, /fresh, and the follow-up marker from a bot PR", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#5");
      assert.strictEqual(observed?.pr?.checks, "failing");
      assert.strictEqual(observed?.pr?.latestHumanCommentAtMillis, 200);
      assert.isTrue(observed?.pr?.fresh);
      assert.deepStrictEqual(observed?.pr?.followUp, {
        checks: "failing",
        humanCommentAtMillis: 100,
        noProgress: 1,
        baseDivergence: "none",
        botTriggerAtMillis: 0,
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
          pulls: [pull({ number: 100, headRef: "5-in-review" })],
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
              body: coordinationBody([
                serializeFollowUp({
                  checks: "failing",
                  humanCommentAtMillis: 100,
                  noProgress: 1,
                  baseDivergence: "none",
                  botTriggerAtMillis: 0,
                }),
              ]),
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

  it.effect("carries the PR number, deep-link URL, and last-activity instant onto the observed item", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#50");
      assert.strictEqual(observed?.pr?.number, 500);
      assert.strictEqual(observed?.pr?.url, "https://github.com/owner/repo/pull/500");
      assert.strictEqual(observed?.pr?.waitingSinceMillis, 1_786_000_000_000);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 50, title: "in review", labels: ["ready-for-agent"] },
            { number: 500, title: "bot pr", labels: [], isPullRequest: true },
          ],
          pulls: [
            pull({
              number: 500,
              headRef: "50-in-review",
              url: "https://github.com/owner/repo/pull/500",
              updatedAtMillis: 1_786_000_000_000,
            }),
          ],
          comments: [
            {
              issue: 50,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
          reviews: [{ pull: 500, state: "APPROVED" }],
        }),
      ),
    ),
  );

  it.effect("attaches write-access human-authored PRs with and without coordination comments", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const coordinated = items.find((item) => item.id === "#20");
      const uncoordinated = items.find((item) => item.id === "#21");
      assert.strictEqual(coordinated?.pr?.review, "changes-requested");
      assert.strictEqual(uncoordinated?.pr?.review, "pending");
      const { eligible } = classify(items);
      assert.strictEqual(eligible.find((entry) => entry.id === "#20")?.stage, "follow-up");
      assert.isUndefined(eligible.find((entry) => entry.id === "#21"));
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 20, title: "coordinated", labels: ["ready-for-agent"] },
            { number: 21, title: "uncoordinated", labels: ["ready-for-agent"] },
            { number: 200, title: "human pr", labels: [], isPullRequest: true },
            { number: 201, title: "human pr", labels: [], isPullRequest: true },
          ],
          pulls: [
            pull({
              number: 200,
              authorLogin: "taylorfsteele",
              authorAssociation: "OWNER",
              headRef: "20-coordinated",
            }),
            pull({
              number: 201,
              authorLogin: "taylorfsteele",
              authorAssociation: "OWNER",
              headRef: "21-uncoordinated",
            }),
          ],
          comments: [
            {
              issue: 20,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
          reviews: [{ pull: 200, state: "CHANGES_REQUESTED" }],
        }),
      ),
    ),
  );

  it.effect("routes every follow-up trigger from trusted PRs without coordination comments", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.deepStrictEqual(
        classify(items).eligible.map((entry) => [entry.id, entry.stage]),
        [
          ["#20", "follow-up"],
          ["#21", "follow-up"],
          ["#22", "follow-up"],
          ["#23", "follow-up"],
        ],
      );
    }).pipe(Effect.provide(withClient(followUpTriggerSeed({ authorLogin: "maintainer", draft: false })))),
  );

  it.effect("holds draft PRs out of follow-up for every trigger", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.isEmpty(classify(items).eligible);
      assert.isTrue(items.every((item) => item.pr?.draft === true));
      assert.isTrue(items.every((item) => item.pr?.followable === true));
    }).pipe(Effect.provide(withClient(followUpTriggerSeed({ authorLogin: bot.login, draft: true })))),
  );

  it.effect("prefers a linked non-draft PR over a draft PR", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#46");
      assert.strictEqual(observed?.pr?.number, 360);
      assert.strictEqual(classify(items).eligible[0]?.stage, "follow-up");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 46, title: "two pull requests", labels: ["ready-for-agent"] }],
          pulls: [
            pull({ number: 360, headRef: "46-ready" }),
            pull({ number: 361, headRef: "46-draft", draft: true, closingIssueNumbers: [46] }),
          ],
          checks: [
            {
              sha: "sha-360",
              name: "test",
              status: "completed",
              conclusion: "failure",
              startedAtMillis: 1,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("resolves the PR by the branch prefix, preferring exact branch, then bot, then newest", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.find((item) => item.id === "#40")?.pr?.review, "changes-requested");
      assert.strictEqual(items.find((item) => item.id === "#41")?.pr?.review, "changes-requested");
      assert.strictEqual(items.find((item) => item.id === "#42")?.pr?.review, "changes-requested");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 40, title: "pick me", labels: ["ready-for-agent"] },
            { number: 41, title: "bot beats newest", labels: ["ready-for-agent"] },
            { number: 42, title: "newest wins", labels: ["ready-for-agent"] },
          ],
          pulls: [
            pull({ number: 300, headRef: "40-stale" }),
            pull({
              number: 301,
              headRef: "40-pick-me",
              authorLogin: "taylorfsteele",
              authorAssociation: "OWNER",
            }),
            pull({ number: 302, headRef: "40-newer" }),
            pull({ number: 310, headRef: "41-a" }),
            pull({ number: 311, headRef: "41-b", authorLogin: "taylorfsteele", authorAssociation: "OWNER" }),
            pull({ number: 320, headRef: "42-a" }),
            pull({ number: 321, headRef: "42-b" }),
          ],
          comments: [40, 41, 42].map((issue) => ({
            issue,
            authorLogin: bot.login,
            body: coordinationBody([
              serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
            ]),
          })),
          reviews: [
            { pull: 300, state: "APPROVED" },
            { pull: 301, state: "CHANGES_REQUESTED" },
            { pull: 302, state: "APPROVED" },
            { pull: 310, state: "CHANGES_REQUESTED" },
            { pull: 311, state: "APPROVED" },
            { pull: 320, state: "APPROVED" },
            { pull: 321, state: "CHANGES_REQUESTED" },
          ],
        }),
      ),
    ),
  );

  it.effect("resolves a trusted closing reference ahead of a branch-prefix match", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#43");
      assert.strictEqual(observed?.pr?.number, 331);
      assert.strictEqual(observed?.pr?.headRef, "claude/github-issue-43-a1b2c3");
      assert.isTrue(observed?.pr?.followable);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 43, title: "closing link", labels: ["ready-for-agent"] }],
          pulls: [
            pull({ number: 330, headRef: "43-closing-link" }),
            pull({
              number: 331,
              headRef: "claude/github-issue-43-a1b2c3",
              closingIssueNumbers: [43],
            }),
          ],
          comments: [
            {
              issue: 43,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
        }),
      ),
    ),
  );

  it.effect("does not route a fork-head closing reference to follow-up", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#44");
      assert.strictEqual(observed?.pr?.headRef, "claude/github-issue-44-a1b2c3");
      assert.isFalse(observed?.pr?.followable ?? true);
      assert.isUndefined(classify(items).eligible.find((item) => item.id === "#44"));
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 44, title: "fork branch", labels: ["ready-for-agent"] }],
          pulls: [
            pull({
              number: 340,
              headRef: "claude/github-issue-44-a1b2c3",
              headRepository: "contributor/repo",
              closingIssueNumbers: [44],
            }),
          ],
          comments: [
            {
              issue: 44,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
          reviews: [{ pull: 340, state: "CHANGES_REQUESTED" }],
        }),
      ),
    ),
  );

  it.effect("prefers a followable branch-prefix PR over a fork closing reference", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#45");
      assert.strictEqual(observed?.pr?.number, 350);
      assert.isTrue(observed?.pr?.followable);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 45, title: "followable match", labels: ["ready-for-agent"] }],
          pulls: [
            pull({ number: 350, headRef: "45-followable-match" }),
            pull({
              number: 351,
              headRef: "contributor/github-issue-45-a1b2c3",
              headRepository: "contributor/repo",
              closingIssueNumbers: [45],
            }),
          ],
          comments: [
            {
              issue: 45,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
        }),
      ),
    ),
  );

  it.effect("refuses to adopt an untrusted closing-reference pull request", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#45");
      assert.isNull(observed?.pr ?? null);
      assert.isUndefined(
        classify(items).eligible.find((entry) => entry.id === "#45" && entry.stage === "follow-up"),
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 45, title: "hostile closing link", labels: ["ready-for-agent"] }],
          pulls: [
            pull({
              number: 341,
              authorLogin: "drive-by",
              authorAssociation: "NONE",
              headRef: "claude/github-issue-45-a1b2c3",
              closingIssueNumbers: [45],
            }),
          ],
          comments: [
            {
              issue: 45,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
            },
          ],
        }),
      ),
    ),
  );

  it.effect("refuses to adopt a PR from an author without write access, even on an owned issue", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
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
            pull({ number: 205, authorLogin: "drive-by", authorAssociation: "NONE", headRef: "25-hostile" }),
          ],
          comments: [
            {
              issue: 25,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
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
      const items = yield* observeItems(workspace);
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
          pulls: [pull({ number: 206, headRef: "26-hostile-review" })],
          comments: [
            {
              issue: 26,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
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
      const items = yield* observeItems(workspace);
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
          pulls: [pull({ number: 202, authorLogin: "taylorfsteele", headRef: "22-inline-review" })],
          comments: [
            {
              issue: 22,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
              ]),
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
      const items = yield* observeItems(workspace);
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
            pull({ number: 203, authorLogin: "taylorfsteele", headRef: "23-review-with-body" }),
            pull({ number: 204, authorLogin: "taylorfsteele", headRef: "24-empty-review" }),
          ],
          comments: [23, 24].map((issue) => ({
            issue,
            authorLogin: bot.login,
            body: coordinationBody([
              serializeAttempt({ stage: "implement", outcome: "succeeded", atMillis: 1 }),
            ]),
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
      // Reading GitHub's `mergeable_state` is allowed (ADR 0003); merging a PR or resolving a
      // review thread is not — so the merge guard excludes the "mergeable" read accessor.
      const forbidden = /merge(?!able)|resolve/i;
      const client = yield* fakeClient({ issues: [] });
      assert.isFalse(Object.keys(client).some((method) => forbidden.test(method)));
      const source = yield* IssueTracker;
      assert.isFalse(Object.keys(source).some((method) => forbidden.test(method)));
      const provider = yield* SourceControlProvider;
      assert.isFalse(Object.keys(provider).some((method) => forbidden.test(method)));
    }).pipe(Effect.provide(withClient({ issues: [] }))),
  );

  it.effect("counts prior attempts and escalates past the cap even without the claim label", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
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
          comments: [
            {
              issue: 9,
              authorLogin: bot.login,
              authorAssociation: "NONE",
              body: coordinationBody(
                [1, 2, 3].map((at) => serializeAttempt({ stage: "triage", outcome: "failed", atMillis: at })),
              ),
              createdAtMillis: 1,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("re-derives a self-halted item's triage proposal from the tracker on observe", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#28");
      assert.strictEqual(observed?.proposal, "The spec conflicts with how routing works today.");
      const needsHuman = classify(items).needsHuman.find((entry) => entry.id === "#28");
      assert.strictEqual(needsHuman?.reason, "ready-for-human");
      assert.strictEqual(needsHuman?.proposal, "The spec conflicts with how routing works today.");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 28, title: "self-halted", labels: ["ready-for-human"] }],
          comments: [
            {
              issue: 28,
              authorLogin: bot.login,
              body: coordinationBody([
                serializeAttempt({ stage: "triage", outcome: "succeeded", atMillis: 1 }),
              ]),
              createdAtMillis: 1,
            },
            {
              issue: 28,
              authorLogin: bot.login,
              body: triageProposalBody("The spec conflicts with how routing works today."),
              createdAtMillis: 2,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("resolves priority from the configured board and defaults an off-board issue to medium", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(prioritizedWorkspace);
      assert.strictEqual(items.find((item) => item.id === "#5")?.priority, "urgent");
      assert.strictEqual(items.find((item) => item.id === "#6")?.priority, "medium");
      assert.deepStrictEqual(
        classify(items).eligible.map((entry) => entry.id),
        [id("#5"), id("#6")],
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 6, title: "off the board", labels: ["ready-for-agent"] },
            { number: 5, title: "urgent", labels: ["ready-for-agent"] },
          ],
          priorities: [{ issue: 5, priority: "urgent" }],
        }),
      ),
    ),
  );

  it.effect("defaults every item to medium and still completes when the board read fails", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(prioritizedWorkspace);
      assert.strictEqual(items.length, 2);
      assert.deepStrictEqual(
        items.map((item) => item.priority),
        ["medium", "medium"],
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { number: 5, title: "one", labels: ["ready-for-agent"] },
            { number: 6, title: "two", labels: ["ready-for-agent"] },
          ],
          priorityError: true,
        }),
      ),
    ),
  );

  it.effect("reads no priority board when none is configured, defaulting every item to medium", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.find((item) => item.id === "#5")?.priority, "medium");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 5, title: "urgent on the board", labels: ["ready-for-agent"] }],
          priorities: [{ issue: 5, priority: "urgent" }],
        }),
      ),
    ),
  );

  it.effect("reads no proposal for an item handed to a human by exhaustion", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#29");
      assert.isNull(observed?.proposal ?? null);
      assert.isNull(classify(items).needsHuman.find((entry) => entry.id === "#29")?.proposal ?? null);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ number: 29, title: "exhausted", labels: ["ready-for-human"] }],
          comments: [
            {
              issue: 29,
              authorLogin: bot.login,
              body: "> *This was posted by cogwork.*\n\n**Exhausted after 3 failed triage attempts.**",
              createdAtMillis: 1,
            },
          ],
        }),
      ),
    ),
  );
});

describe("trusted review-bot follow-up (botAllowlist)", () => {
  const botCommentPr = (comment: SeedComment): Seed => ({
    issues: [
      { number: 5, title: "in review", labels: ["ready-for-agent"] },
      { number: 100, title: "bot pr", labels: [], isPullRequest: true },
    ],
    pulls: [pull({ number: 100, headRef: "5-in-review" })],
    comments: [comment],
  });

  const cursorComment = (over: Partial<SeedComment> = {}): SeedComment => ({
    issue: 100,
    authorLogin: "cursor[bot]",
    authorAssociation: "NONE",
    body: "Medium severity: this looks like a bug.",
    createdAtMillis: 300,
    ...over,
  });

  it.effect("does not wake a follow-up when no botAllowlist is set", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "#5");
      assert.strictEqual(observed?.pr?.latestBotTriggerAtMillis, null);
      const eligible = classify(items).eligible.find((entry) => entry.id === "#5");
      assert.isUndefined(eligible);
    }).pipe(Effect.provide(withClient(botCommentPr(cursorComment())))),
  );

  it.effect("wakes a follow-up on a listed bot's new comment without setting fresh", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(trustsCursorBot);
      const observed = items.find((item) => item.id === "#5");
      assert.strictEqual(observed?.pr?.latestBotTriggerAtMillis, 300);
      const eligible = classify(items).eligible.find((entry) => entry.id === "#5");
      assert.strictEqual(eligible?.stage, "follow-up");
      assert.isFalse(eligible?.followUp?.fresh);
    }).pipe(Effect.provide(withClient(botCommentPr(cursorComment({ body: "please /fresh and fix this" }))))),
  );

  it.effect("ignores an unlisted bot's comment", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(trustsCursorBot);
      const observed = items.find((item) => item.id === "#5");
      assert.strictEqual(observed?.pr?.latestBotTriggerAtMillis, null);
      const eligible = classify(items).eligible.find((entry) => entry.id === "#5");
      assert.isUndefined(eligible);
    }).pipe(Effect.provide(withClient(botCommentPr(cursorComment({ authorLogin: "dependabot[bot]" }))))),
  );

  it.effect("ignores a cogwork-marked body even from a listed bot", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(trustsCursorBot);
      const observed = items.find((item) => item.id === "#5");
      assert.strictEqual(observed?.pr?.latestBotTriggerAtMillis, null);
    }).pipe(Effect.provide(withClient(botCommentPr(cursorComment({ body: coordinationBody([]) }))))),
  );
});
