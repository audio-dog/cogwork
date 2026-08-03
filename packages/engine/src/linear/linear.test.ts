import { type AttemptRecord, type Claim, WorkItemId, WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { classify } from "../classify";
import type { RegisteredWorkspace } from "../projector";
import { WorkSource, WorkSourceError } from "../WorkSource";
import { layer as adapterLayer } from "./adapter";
import {
  LinearClient,
  type LinearClientService,
  type RawComment,
  type RawIssue,
  type RawWorkflowState,
} from "./client";
import { claimLabel, hasLedgerMarker, serializeAttempt } from "./markers";

const id = Schema.decodeSync(WorkItemId);

interface SeedIssue {
  readonly identifier: string;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly stateName?: string;
  readonly stateType?: string;
}

interface Seed {
  readonly issues: ReadonlyArray<SeedIssue>;
  readonly comments?: ReadonlyArray<
    { readonly issue: string } & Omit<RawComment, "id"> & { readonly id?: string }
  >;
  readonly states?: ReadonlyArray<RawWorkflowState>;
  readonly authError?: boolean;
}

const bot = { id: "bot-user" } as const;

const fakeClient = Effect.fn("linear.fakeClient")(function* (seed: Seed) {
  const issuesRef = yield* Ref.make(
    seed.issues.map(
      (issue): RawIssue => ({
        id: `uuid-${issue.identifier}`,
        identifier: issue.identifier,
        title: issue.title,
        labels: issue.labels,
        stateName: issue.stateName ?? "Todo",
        stateType: issue.stateType ?? "unstarted",
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
      ? Effect.fail(new WorkSourceError({ reason: "auth", message: "Linear authentication failed" }))
      : effect;

  return {
    listIssues: () => guard(Ref.get(issuesRef)),
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
    workSource: {
      type: "linear",
      team: "AUD",
      botUserId: bot.id,
    },
    harness: { preferred: "cursor" },
  }),
};

const customRolesWorkspace: RegisteredWorkspace = {
  ...workspace,
  config: {
    ...workspace.config,
    workSource: {
      ...workspace.config.workSource,
      roleLabels: { "ready-for-agent": "custom:agent-ready" },
    },
  },
};

const withClient = (seed: Seed) =>
  adapterLayer.pipe(Layer.provideMerge(Layer.effect(LinearClient, fakeClient(seed))));

const botComments = (comments: ReadonlyArray<RawComment>) =>
  comments.filter((comment) => comment.authorId === bot.id);

describe("linear work source adapter", () => {
  it.effect("derives the actionable set from state: labels and Canceled workflow state", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
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

  it.effect("uses configured role label strings instead of hardcoded defaults", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const items = yield* source.observe(customRolesWorkspace);
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
      const source = yield* WorkSource;
      const client = yield* LinearClient;
      const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1_722_000_000_000, stage: "implement" };
      const attempt: AttemptRecord = { stage: "implement", outcome: "failed", atMillis: 1_722_000_000_001 };
      yield* source.claim(workspace, id("AUD-7"), claim);
      yield* source.recordAttempt(workspace, id("AUD-7"), attempt);
      const comments = botComments(
        yield* client.listComments({ team: "AUD", tokenEnv: "LINEAR_API_KEY" }, "AUD-7"),
      );
      assert.strictEqual(comments.length, 1);
      assert.isTrue(hasLedgerMarker(comments[0]?.body ?? ""));
      assert.isFalse(comments[0]?.body.includes("<!--") ?? true);
      const items = yield* source.observe(workspace);
      const observed = items.find((item) => item.id === "AUD-7");
      assert.deepStrictEqual(observed?.claim, { by: claim.by, claimedAtMillis: claim.claimedAtMillis });
      assert.deepStrictEqual(observed?.attempts, [attempt]);
      assert.isTrue(observed?.claimLabeled);
      const { eligible, claimed } = classify(items);
      assert.strictEqual(eligible.length, 0);
      assert.deepStrictEqual(claimed[0]?.claim, { by: claim.by, claimedAtMillis: claim.claimedAtMillis });
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
      const source = yield* WorkSource;
      const client = yield* LinearClient;
      yield* source.recordAttempt(
        workspace,
        id("AUD-8"),
        { stage: "implement", outcome: "failed", atMillis: 1_722_000_000_001 },
        "git worktree add: boom",
      );
      const comments = botComments(
        yield* client.listComments({ team: "AUD", tokenEnv: "LINEAR_API_KEY" }, "AUD-8"),
      );
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
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
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

  it.effect("stops claiming after release removes the claim label", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      yield* source.claim(workspace, id("AUD-7"), {
        by: "clanker-forge",
        claimedAtMillis: 1,
        stage: "implement",
      });
      yield* source.release(workspace, id("AUD-7"));
      const items = yield* source.observe(workspace);
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
      const source = yield* WorkSource;
      const client = yield* LinearClient;
      yield* source.setRoles(workspace, id("AUD-9"), {
        remove: ["needs-triage"],
        add: ["wontfix"],
      });
      const issues = yield* client.listIssues({ team: "AUD", tokenEnv: "LINEAR_API_KEY" });
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
      const source = yield* WorkSource;
      const items = yield* source.observe(workspace);
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
          comments: [1, 2, 3].map((at) => ({
            issue: "AUD-10",
            authorId: bot.id,
            body: serializeAttempt({ stage: "triage", outcome: "failed", atMillis: at }),
            createdAtMillis: at,
          })),
        }),
      ),
    ),
  );

  it.effect("surfaces auth failure as WorkSourceError reason auth", () =>
    Effect.gen(function* () {
      const source = yield* WorkSource;
      const result = yield* Effect.result(source.observe(workspace));
      if (result._tag !== "Failure") {
        assert.fail("expected auth failure");
        return;
      }
      if (result.failure._tag !== "WorkSourceError") {
        assert.fail("expected WorkSourceError");
        return;
      }
      assert.strictEqual(result.failure.reason, "auth");
    }).pipe(Effect.provide(withClient({ issues: [], authError: true }))),
  );
});
