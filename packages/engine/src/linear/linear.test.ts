import { type AttemptRecord, type Claim, WorkItemId, WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { classify } from "../classify";
import { triageProposalBody } from "../comments";
import * as Coordination from "../coordination";
import { IssueTracker, IssueTrackerError } from "../issue-tracker";
import { observeWorkspace } from "../observe";
import type { RegisteredWorkspace } from "../projector";
import * as SourceControl from "../source-control";
import { layer as adapterLayer } from "./adapter";
import {
  type CoordinationScope,
  LinearClient,
  type LinearClientService,
  type LinearTeamRef,
  type ObservedRawIssue,
  type RawComment,
  type RawIssue,
  type RawWorkflowState,
} from "./client";
import { claimLabel, wireCodec } from "./markers";

const id = Schema.decodeSync(WorkItemId);

const serializeClaim = (claim: Claim) => Coordination.serializeClaim(wireCodec, claim);
const serializeAttempt = (attempt: AttemptRecord) => Coordination.serializeAttempt(wireCodec, attempt);
const formatCoordinationBody = (body: Coordination.CoordinationBody) =>
  Coordination.formatCoordinationBody(wireCodec, body);
const hasLedgerMarker = (body: string) => Coordination.hasLedgerMarker(wireCodec, body);

interface SeedIssue {
  readonly identifier: string;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly stateName?: string;
  readonly stateType?: string;
  readonly openBlockers?: number;
}

interface Seed {
  readonly issues: ReadonlyArray<SeedIssue>;
  readonly comments?: ReadonlyArray<
    { readonly issue: string } & Omit<RawComment, "id"> & { readonly id?: string }
  >;
  readonly states?: ReadonlyArray<RawWorkflowState>;
  readonly authError?: boolean;
  readonly observeCalls?: Ref.Ref<number>;
}

const bot = { id: "bot-user" } as const;

const teamRef: LinearTeamRef = {
  team: "AUD",
  tokenEnv: "LINEAR_API_KEY",
  organization: null,
  clientCredentials: null,
  oauthClientId: null,
};

const fakeClient = Effect.fn("linear.fakeClient")(function* (seed: Seed) {
  const issuesRef = yield* Ref.make(
    seed.issues.map(
      (issue): RawIssue => ({
        id: `uuid-${issue.identifier}`,
        identifier: issue.identifier,
        title: issue.title,
        labels: issue.labels,
        assignees: issue.assignees ?? [],
        stateName: issue.stateName ?? "Todo",
        stateType: issue.stateType ?? "unstarted",
        openBlockers: issue.openBlockers ?? 0,
      }),
    ),
  );
  const seededComments = (seed.comments ?? []).reduce(
    (all, { issue, id: commentId, ...comment }) =>
      all.set(issue, [
        ...(all.get(issue) ?? []),
        { id: commentId ?? `comment-${all.get(issue)?.length ?? 0}`, ...comment },
      ]),
    new Map<string, ReadonlyArray<RawComment>>(),
  );
  const commentsRef = yield* Ref.make(seededComments);
  const commentSeq = yield* Ref.make(100);
  const states = seed.states ?? [
    { id: "state-todo", name: "Todo", type: "unstarted" },
    { id: "state-canceled", name: "Canceled", type: "canceled" },
  ];

  const patch = (identifier: string, update: (issue: RawIssue) => RawIssue) =>
    Ref.update(issuesRef, (issues) =>
      issues.map((issue) => (issue.identifier === identifier ? update(issue) : issue)),
    );

  const guard = <A>(effect: Effect.Effect<A>) =>
    seed.authError
      ? Effect.fail(new IssueTrackerError({ reason: "auth", message: "Linear authentication failed" }))
      : effect;

  const countObserve = seed.observeCalls;

  // Deliberately looser than Linear's own filter: the adapter must not lean on the server to keep a
  // forged coordination comment out of the ledger.
  const coordinationFor = (
    identifier: string,
    comments: Map<string, ReadonlyArray<RawComment>>,
    coordination: CoordinationScope | null,
  ) =>
    coordination === null
      ? []
      : (comments.get(identifier) ?? []).filter(
          (comment) =>
            comment.body.includes(coordination.ledgerMarker) ||
            comment.body.includes(coordination.proposalMarker),
        );

  return {
    observeIssues: (_ref, coordination) =>
      guard(
        Effect.gen(function* () {
          if (countObserve) yield* Ref.update(countObserve, (count) => count + 1);
          const issues = yield* Ref.get(issuesRef);
          const comments = yield* Ref.get(commentsRef);
          return issues.map(
            (issue): ObservedRawIssue => ({
              ...issue,
              coordinationComments: coordinationFor(issue.identifier, comments, coordination),
            }),
          );
        }),
      ),
    listWorkflowStates: () => guard(Effect.succeed(states)),
    listComments: (_ref, issueId) =>
      guard(Ref.get(commentsRef).pipe(Effect.map((all) => [...(all.get(issueId) ?? [])]))),
    addLabel: (_ref, issueId, label) =>
      guard(patch(issueId, (issue) => ({ ...issue, labels: [...issue.labels, label] }))),
    removeLabel: (_ref, issueId, label) =>
      guard(
        patch(issueId, (issue) => ({
          ...issue,
          labels: issue.labels.filter((existing) => existing !== label),
        })),
      ),
    setState: (_ref, issueId, stateId) =>
      guard(
        Effect.gen(function* () {
          const state = states.find((entry) => entry.id === stateId);
          if (!state) return;
          yield* patch(issueId, (issue) => ({
            ...issue,
            stateName: state.name,
            stateType: state.type,
          }));
        }).pipe(Effect.asVoid),
      ),
    createComment: (_ref, issueId, body) =>
      guard(
        Effect.gen(function* () {
          const seq = yield* Ref.get(commentSeq);
          yield* Ref.set(commentSeq, seq + 1);
          const comment: RawComment = {
            id: `comment-${seq}`,
            authorId: bot.id,
            body,
            createdAtMillis: seq,
          };
          yield* Ref.update(commentsRef, (all) =>
            new Map(all).set(issueId, [...(all.get(issueId) ?? []), comment]),
          );
        }),
      ),
    editComment: (_ref, commentId, body) =>
      guard(
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
      ),
  } satisfies LinearClientService;
});

const workspace: RegisteredWorkspace = {
  source: "linear.workspace.ts",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "lin",
    checkoutPath: "/repos/lin",
    issueTracker: {
      type: "linear",
      team: "AUD",
      actorUserId: bot.id,
    },
    harness: { preferred: "cursor" },
  }),
};

const customRolesWorkspace: RegisteredWorkspace = {
  ...workspace,
  config: {
    ...workspace.config,
    issueTracker: {
      ...workspace.config.issueTracker,
      roleLabels: { "ready-for-agent": "custom:agent-ready" },
    },
  },
};

const withClient = (seed: Seed) =>
  Layer.mergeAll(adapterLayer, SourceControl.emptyLayer).pipe(
    Layer.provideMerge(Layer.effect(LinearClient, fakeClient(seed))),
  );

// A Linear tracker with no source control provider still composes the poll — the provider just
// reports no pull request, so every item observes `pr: null`.
const observeItems = (workspace: RegisteredWorkspace) =>
  Effect.gen(function* () {
    const tracker = yield* IssueTracker;
    const provider = yield* SourceControl.SourceControlProvider;
    return yield* observeWorkspace(tracker, provider)(workspace);
  });

const botComments = (comments: ReadonlyArray<RawComment>) =>
  comments.filter((comment) => comment.authorId === bot.id);

describe("linear work source adapter", () => {
  it.effect("holds a ready-for-agent ticket with an open blocker out of the eligible set", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.find((item) => item.id === "AUD-30")?.openBlockers, 1);
      assert.strictEqual(items.find((item) => item.id === "AUD-31")?.openBlockers, 0);
      const { eligible, blocked } = classify(items);
      assert.deepStrictEqual(blocked, [{ id: id("AUD-30"), title: "waits on AUD-31", openBlockers: 1 }]);
      assert.deepStrictEqual(
        eligible.map((entry) => entry.id),
        [id("AUD-31")],
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            {
              identifier: "AUD-30",
              title: "waits on AUD-31",
              labels: ["state:ready-for-agent"],
              openBlockers: 1,
            },
            { identifier: "AUD-31", title: "the blocker", labels: ["state:ready-for-agent"] },
          ],
        }),
      ),
    ),
  );

  it.effect("derives the actionable set from state: labels and Canceled workflow state", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const { eligible, needsHuman, claimed } = classify(items);
      assert.deepStrictEqual(
        eligible.map((entry) => [entry.id, entry.stage]),
        [
          ["AUD-2", "triage"],
          ["AUD-1", "implement"],
        ],
      );
      assert.deepStrictEqual(
        needsHuman.map((entry) => entry.id),
        ["AUD-3", "AUD-6"],
      );
      assert.strictEqual(claimed.length, 0);
      assert.isTrue(items.find((item) => item.id === "AUD-4")?.roles.includes("wontfix") ?? false);
      assert.strictEqual(items.find((item) => item.id === "AUD-5")?.roles.includes("wontfix"), true);
      assert.isUndefined(classify(items).eligible.find((entry) => entry.id === "AUD-4"));
      assert.isUndefined(classify(items).eligible.find((entry) => entry.id === "AUD-5"));
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { identifier: "AUD-1", title: "implement me", labels: ["state:ready-for-agent"] },
            { identifier: "AUD-2", title: "triage me", labels: ["state:needs-triage"] },
            { identifier: "AUD-3", title: "needs a human", labels: ["state:needs-info"] },
            { identifier: "AUD-6", title: "human", labels: ["state:ready-for-human"] },
            {
              identifier: "AUD-4",
              title: "rejected by label",
              labels: ["state:wontfix", "state:ready-for-agent"],
            },
            {
              identifier: "AUD-5",
              title: "rejected by state",
              labels: ["state:ready-for-agent"],
              stateName: "Canceled",
              stateType: "canceled",
            },
          ],
        }),
      ),
    ),
  );

  it.effect("carries assignees onto observed items so the allowlist gate can drop unowned work", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.deepStrictEqual(items.find((item) => item.id === "AUD-40")?.assignees, ["user-me"]);
      assert.deepStrictEqual(items.find((item) => item.id === "AUD-41")?.assignees, []);
      assert.deepStrictEqual(
        classify(items, ["user-me"]).eligible.map((entry) => entry.id),
        [id("AUD-40")],
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            {
              identifier: "AUD-40",
              title: "mine",
              labels: ["state:ready-for-agent"],
              assignees: ["user-me"],
            },
            { identifier: "AUD-41", title: "unassigned", labels: ["state:ready-for-agent"] },
          ],
        }),
      ),
    ),
  );

  it.effect("uses configured role label strings instead of hardcoded defaults", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(customRolesWorkspace);
      const { eligible } = classify(items);
      assert.deepStrictEqual(
        eligible.map((entry) => entry.id),
        ["AUD-1"],
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { identifier: "AUD-1", title: "custom", labels: ["custom:agent-ready"] },
            { identifier: "AUD-2", title: "default ignored", labels: ["state:ready-for-agent"] },
          ],
        }),
      ),
    ),
  );

  it.effect("round-trips a claim and an attempt through visible Linear representations", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const client = yield* LinearClient;
      const request = { claimedAtMillis: 1_722_000_000_000, stage: "implement" } as const;
      const claim: Claim = { by: "clanker-forge", ...request };
      const attempt: AttemptRecord = { stage: "implement", outcome: "failed", atMillis: 1_722_000_000_001 };
      yield* source.claim(workspace, id("AUD-7"), request);
      yield* source.recordAttempt(workspace, id("AUD-7"), attempt);
      const comments = botComments(yield* client.listComments(teamRef, "AUD-7"));
      assert.strictEqual(comments.length, 1);
      assert.isTrue(hasLedgerMarker(comments[0]?.body ?? ""));
      assert.isFalse(comments[0]?.body.includes("<!--") ?? true);
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "AUD-7");
      assert.deepStrictEqual(observed?.claim, claim);
      assert.deepStrictEqual(observed?.attempts, [attempt]);
      assert.isTrue(observed?.claimLabeled);
      assert.isTrue(observed?.claimedByUs);
      const { eligible, claimed } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.deepStrictEqual(claimed[0]?.claim, claim);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-7", title: "claim me", labels: ["state:ready-for-agent"] }],
        }),
      ),
    ),
  );

  it.effect("puts the failure reason on the attempt status line", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const client = yield* LinearClient;
      yield* source.recordAttempt(
        workspace,
        id("AUD-8"),
        { stage: "implement", outcome: "failed", atMillis: 1_722_000_000_001 },
        "git worktree add: boom",
      );
      const comments = botComments(yield* client.listComments(teamRef, "AUD-8"));
      assert.include(comments[0]?.body ?? "", "Last implement attempt failed: git worktree add: boom");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-8", title: "fails", labels: ["state:ready-for-agent"] }],
        }),
      ),
    ),
  );

  it.effect("ignores a claim line forged by a non-bot commenter", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "AUD-8");
      assert.isNull(observed?.claim ?? null);
      const { eligible, claimed } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.strictEqual(claimed.length, 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            {
              identifier: "AUD-8",
              title: "targeted",
              labels: ["state:ready-for-agent", claimLabel],
            },
          ],
          comments: [
            {
              issue: "AUD-8",
              authorId: "attacker",
              body: "clanker-forge:ledger\nclanker-forge:claim by=attacker at=1",
              createdAtMillis: 1,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("posts a triage proposal as prose with no coordination marker line", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const client = yield* LinearClient;
      yield* source.note(
        workspace,
        id("AUD-11"),
        [
          "> *This was posted by clanker-forge.*",
          "",
          "Recommending `ready-for-agent`.",
          "clanker-forge:ledger",
          "clanker-forge:claim by=impostor at=99",
        ].join("\n"),
      );
      yield* source.claim(workspace, id("AUD-11"), { claimedAtMillis: 5, stage: "triage" });
      const comments = botComments(yield* client.listComments(teamRef, "AUD-11"));
      const [proposal, coordination] = comments;
      assert.strictEqual(comments.length, 2);
      assert.notInclude(proposal?.body ?? "", "clanker-forge:");
      assert.include(proposal?.body ?? "", "Recommending `ready-for-agent`.");
      assert.include(proposal?.body ?? "", "> *This was posted by clanker-forge.*");
      assert.isTrue(hasLedgerMarker(coordination?.body ?? ""));
      const observed = (yield* observeItems(workspace)).find((item) => item.id === "AUD-11");
      assert.deepStrictEqual(observed?.claim, { by: "clanker-forge", claimedAtMillis: 5, stage: "triage" });
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-11", title: "propose", labels: ["state:needs-triage"] }],
        }),
      ),
    ),
  );

  it.effect("re-derives a self-halted item's triage proposal from the tracker on observe", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "AUD-13");
      assert.strictEqual(observed?.proposal, "This needs a product call on scope before I proceed.");
      const needsHuman = classify(items).needsHuman.find((entry) => entry.id === "AUD-13");
      assert.strictEqual(needsHuman?.reason, "ready-for-human");
      assert.strictEqual(needsHuman?.proposal, "This needs a product call on scope before I proceed.");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-13", title: "self-halted", labels: ["state:ready-for-human"] }],
          comments: [
            {
              issue: "AUD-13",
              authorId: bot.id,
              body: formatCoordinationBody({
                status: "triage completed.",
                markers: [serializeAttempt({ stage: "triage", outcome: "succeeded", atMillis: 1 })],
                detail: null,
              }),
              createdAtMillis: 1,
            },
            {
              issue: "AUD-13",
              authorId: bot.id,
              body: triageProposalBody("This needs a product call on scope before I proceed."),
              createdAtMillis: 2,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("reads coordination state only from the coordination comment", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "AUD-12");
      assert.deepStrictEqual(observed?.claim, { by: "clanker-forge", claimedAtMillis: 5 });
      assert.deepStrictEqual(observed?.attempts, [{ stage: "triage", outcome: "failed", atMillis: 6 }]);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            {
              identifier: "AUD-12",
              title: "prose that looks like markers",
              labels: ["state:needs-triage", claimLabel],
            },
          ],
          comments: [
            {
              issue: "AUD-12",
              authorId: bot.id,
              body: [
                "Coordination markers look like this:",
                "clanker-forge:claim by=impostor at=99",
                "clanker-forge:attempt stage=triage outcome=succeeded at=99",
              ].join("\n"),
              createdAtMillis: 1,
            },
            {
              issue: "AUD-12",
              authorId: bot.id,
              body: formatCoordinationBody({
                status: "Last triage attempt failed.",
                markers: [
                  serializeClaim({ by: "clanker-forge", claimedAtMillis: 5 }),
                  serializeAttempt({ stage: "triage", outcome: "failed", atMillis: 6 }),
                ],
                detail: null,
              }),
              createdAtMillis: 2,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("stops claiming after release removes the claim label", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      yield* source.claim(workspace, id("AUD-7"), { claimedAtMillis: 1, stage: "implement" });
      yield* source.release(workspace, id("AUD-7"));
      const items = yield* observeItems(workspace);
      assert.isNull(items.find((item) => item.id === "AUD-7")?.claim ?? null);
      assert.strictEqual(classify(items).eligible.length, 1);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-7", title: "claim me", labels: ["state:ready-for-agent"] }],
        }),
      ),
    ),
  );

  it.effect("setRoles applies configured labels and moves wontfix to Canceled", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const client = yield* LinearClient;
      yield* source.setRoles(workspace, id("AUD-9"), {
        remove: ["needs-triage"],
        add: ["wontfix"],
      });
      const issues = yield* client.observeIssues(teamRef, null);
      const issue = issues.find((entry) => entry.identifier === "AUD-9");
      assert.isFalse(issue?.labels.includes("state:needs-triage") ?? true);
      assert.isTrue(issue?.labels.includes("state:wontfix") ?? false);
      assert.strictEqual(issue?.stateName, "Canceled");
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-9", title: "close me", labels: ["state:needs-triage"] }],
        }),
      ),
    ),
  );

  it.effect("counts prior attempts and escalates past the cap even without the claim label", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      const observed = items.find((item) => item.id === "AUD-10");
      assert.strictEqual(observed?.attempts.length, 3);
      const { eligible, needsHuman } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.include(
        needsHuman.map((entry) => entry.id),
        id("AUD-10"),
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-10", title: "keeps failing", labels: ["state:needs-triage"] }],
          comments: [
            {
              issue: "AUD-10",
              authorId: bot.id,
              body: formatCoordinationBody({
                status: "Last triage attempt failed.",
                markers: [1, 2, 3].map((at) =>
                  serializeAttempt({ stage: "triage", outcome: "failed", atMillis: at }),
                ),
                detail: null,
              }),
              createdAtMillis: 1,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("observes a whole backlog with one client read regardless of issue count", () =>
    Effect.gen(function* () {
      const observeCalls = yield* Ref.make(0);
      const backlog = Array.from({ length: 60 }, (_, index) => ({
        identifier: `AUD-${index + 1}`,
        title: `issue ${index + 1}`,
        labels: ["state:ready-for-agent"],
      }));
      yield* Effect.gen(function* () {
        const items = yield* observeItems(workspace);
        assert.strictEqual(items.length, 60);
        assert.strictEqual(yield* Ref.get(observeCalls), 1);
      }).pipe(Effect.provide(withClient({ issues: backlog, observeCalls })));
    }),
  );

  it.effect("reports the rate-limit scope from the token env so shared credentials back off together", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      assert.strictEqual(source.rateLimitScope(workspace), "linear:LINEAR_API_KEY");
    }).pipe(Effect.provide(withClient({ issues: [] }))),
  );

  it.effect("surfaces auth failure as IssueTrackerError reason auth", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(observeItems(workspace));
      if (result._tag !== "Failure") {
        assert.fail("expected auth failure");
        return;
      }
      if (result.failure._tag !== "IssueTrackerError") {
        assert.fail("expected IssueTrackerError");
        return;
      }
      assert.strictEqual(result.failure.reason, "auth");
    }).pipe(Effect.provide(withClient({ issues: [], authError: true }))),
  );
});
