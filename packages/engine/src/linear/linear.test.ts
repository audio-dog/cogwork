import {
  type AttemptOutcome,
  type AttemptRecord,
  codingOperation,
  keyOf,
  type LifecycleStage,
  LineageId,
  type Priority,
  RunId,
  WorkflowActionOrigin,
  WorkflowId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { classify } from "../classify";
import { triageProposalAttribution, triageProposalBody } from "../comments";
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
  linearPriority,
  type ObservedRawIssue,
  type RawComment,
  type RawIssue,
  type RawWorkflowState,
} from "./client";
import { claimLabel, ledgerMarker, wireCodec } from "./markers";

const id = Schema.decodeSync(WorkItemId);
const lineage = { root: LineageId.make("issue:test"), parent: null, hop: 0 };
const claimRecord = (workspace: RegisteredWorkspace, itemId: string, claimedAtMillis: number) => ({
  by: "cogwork",
  claimedAtMillis,
  operation: codingOperation("implement"),
  lineage: {
    root: LineageId.make(keyOf({ _tag: "Issue", workspace: workspace.config.name, id: id(itemId) })),
    parent: null,
    hop: 0,
  },
});

// The fake mirrors Linear: a team read returns only that team's issues, and a write only lands when
// the target team owns the issue — so a mis-routed write is visible as a failure, not a silent no-op.
const teamKeyOf = (identifier: string) => {
  const dash = identifier.indexOf("-");
  return dash === -1 ? identifier : identifier.slice(0, dash);
};

const serializeAttempt = (attempt: AttemptRecord) => Coordination.serializeAttempt(wireCodec, attempt);
const serializeCodingAttempt = (operation: LifecycleStage, outcome: AttemptOutcome, atMillis: number) =>
  serializeAttempt({ operation: codingOperation(operation), outcome, atMillis, lineage });
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
  readonly priority?: Priority;
  readonly description?: string;
}

interface Seed {
  readonly issues: ReadonlyArray<SeedIssue>;
  readonly comments?: ReadonlyArray<
    { readonly issue: string } & Omit<RawComment, "authorAssociation" | "id"> & {
        readonly authorAssociation?: RawComment["authorAssociation"];
        readonly id?: string;
      }
  >;
  readonly states?: ReadonlyArray<RawWorkflowState>;
  readonly authError?: boolean;
  readonly observeError?: boolean;
  readonly createIssueError?: boolean;
  readonly hideActionIssue?: boolean;
}

interface LinearClientCallsState {
  readonly observe: Ref.Ref<number>;
  readonly assigneeFilters: Ref.Ref<ReadonlyArray<ReadonlyArray<string> | null>>;
  readonly readProse: Ref.Ref<number>;
}

class LinearClientCalls extends Context.Service<LinearClientCalls, LinearClientCallsState>()(
  "@cogwork/engine/linear/linear.test/LinearClientCalls",
) {
  static readonly layer = Layer.effect(
    LinearClientCalls,
    Effect.all({
      observe: Ref.make(0),
      assigneeFilters: Ref.make<ReadonlyArray<ReadonlyArray<string> | null>>([]),
      readProse: Ref.make(0),
    }),
  );
}

const bot = { id: "bot-user" } as const;
const botCoordination = {
  actorUserId: bot.id,
  ledgerMarker,
  proposalMarker: triageProposalAttribution,
};

const teamRef: LinearTeamRef = {
  team: "AUD",
  account: {
    key: "AUD",
    issueTracker: "linear",
    organization: null,
    tokenEnv: "LINEAR_API_KEY",
    clientCredentials: null,
    oauthClientId: null,
  },
};

const fakeClient = Effect.fn("linear.fakeClient")(function* (seed: Seed) {
  const calls = yield* LinearClientCalls;
  const issuesRef = yield* Ref.make(
    seed.issues.map(
      (issue): RawIssue => ({
        id: `uuid-${issue.identifier}`,
        identifier: issue.identifier,
        title: issue.title,
        url: `https://linear.app/acme/issue/${issue.identifier}`,
        body: issue.description ?? "",
        labels: issue.labels,
        assignees: issue.assignees ?? [],
        stateName: issue.stateName ?? "Todo",
        stateType: issue.stateType ?? "unstarted",
        openBlockers: issue.openBlockers ?? 0,
        priority: issue.priority ?? "medium",
      }),
    ),
  );
  const seededComments = (seed.comments ?? []).reduce(
    (all, { issue, id: commentId, ...comment }) =>
      all.set(issue, [
        ...(all.get(issue) ?? []),
        {
          id: commentId ?? `comment-${all.get(issue)?.length ?? 0}`,
          authorAssociation: "NONE" as const,
          ...comment,
        },
      ]),
    new Map<string, ReadonlyArray<RawComment>>(),
  );
  const commentsRef = yield* Ref.make(seededComments);
  const commentSeq = yield* Ref.make(100);
  const states = seed.states ?? [
    { id: "state-todo", name: "Todo", type: "unstarted" },
    { id: "state-done", name: "Done", type: "completed" },
    { id: "state-canceled", name: "Canceled", type: "canceled" },
  ];

  const patch = (identifier: string, update: (issue: RawIssue) => RawIssue) =>
    Ref.update(issuesRef, (issues) =>
      issues.map((issue) => (issue.identifier === identifier ? update(issue) : issue)),
    );

  const guard = <A>(effect: Effect.Effect<A, IssueTrackerError>) =>
    seed.authError
      ? Effect.fail(new IssueTrackerError({ reason: "auth", message: "Linear authentication failed" }))
      : effect;

  const inTeam = <A>(ref: LinearTeamRef, issueId: string, effect: Effect.Effect<A>) =>
    teamKeyOf(issueId) === ref.team
      ? effect
      : Effect.fail(
          new IssueTrackerError({
            reason: "unavailable",
            message: `issue ${issueId} is not in team ${ref.team}`,
          }),
        );

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
    authenticatedUserId: () => guard(Effect.succeed(bot.id)),
    observeIssues: (ref, coordination, assigneeIds = null) =>
      guard(
        Effect.gen(function* () {
          if (seed.observeError) {
            return yield* new IssueTrackerError({
              reason: "unavailable",
              message: "backlog unavailable",
            });
          }
          yield* Ref.update(calls.observe, (count) => count + 1);
          yield* Ref.update(calls.assigneeFilters, (filters) => [...filters, assigneeIds]);
          const issues = yield* Ref.get(issuesRef);
          const comments = yield* Ref.get(commentsRef);
          return issues
            .filter((issue) => teamKeyOf(issue.identifier) === ref.team)
            .map(
              (issue): ObservedRawIssue => ({
                ...issue,
                coordinationComments: coordinationFor(issue.identifier, comments, coordination),
              }),
            );
        }),
      ),
    listWorkflowStates: () => guard(Effect.succeed(states)),
    listComments: (_ref, issueId, _coordination) =>
      guard(Ref.get(commentsRef).pipe(Effect.map((all) => [...(all.get(issueId) ?? [])]))),
    findMarker: (_ref, issueId, marker) =>
      guard(
        Effect.all([Ref.get(issuesRef), Ref.get(commentsRef)]).pipe(
          Effect.map(([issues, comments]) => ({
            body:
              issues
                .find((candidate) => candidate.identifier === issueId || candidate.id === issueId)
                ?.body?.includes(marker) ?? false,
            comment: (comments.get(issueId) ?? []).some(({ body }) => body.includes(marker)),
          })),
        ),
      ),
    readActionIssue: (_ref, issueId) =>
      guard(
        Effect.gen(function* () {
          const issue = (yield* Ref.get(issuesRef)).find(
            (candidate) => candidate.identifier === issueId || candidate.id === issueId,
          );
          if (!issue) {
            return yield* new IssueTrackerError({ reason: "unavailable", message: "issue missing" });
          }
          return {
            id: issue.id,
            identifier: issue.identifier,
            url: issue.url,
            body: issue.body ?? "",
            labels: [...issue.labels],
            stateType: issue.stateType,
          };
        }),
      ),
    findActionIssue: (_ref, marker) =>
      guard(
        Ref.get(issuesRef).pipe(
          Effect.map((issues) => {
            if (seed.hideActionIssue) return null;
            const issue = issues.find(({ body }) => body?.includes(marker));
            return issue
              ? {
                  id: issue.id,
                  identifier: issue.identifier,
                  url: issue.url,
                  body: issue.body ?? "",
                  labels: [...issue.labels],
                  stateType: issue.stateType,
                }
              : null;
          }),
        ),
      ),
    readProse: (_ref, issueId) =>
      guard(
        Effect.gen(function* () {
          yield* Ref.update(calls.readProse, (count) => count + 1);
          const [issues, comments] = yield* Effect.all([Ref.get(issuesRef), Ref.get(commentsRef)]);
          const issue = issues.find(
            (candidate) => candidate.identifier === issueId || candidate.id === issueId,
          );
          if (!issue) {
            return yield* new IssueTrackerError({ reason: "unavailable", message: "issue missing" });
          }
          return {
            body: issue.body ?? "",
            comments: [...(comments.get(issueId) ?? [])],
          };
        }),
      ),
    addLabel: (ref, issueId, label) =>
      guard(
        inTeam(
          ref,
          issueId,
          patch(issueId, (issue) => ({ ...issue, labels: [...issue.labels, label] })),
        ),
      ),
    removeLabel: (ref, issueId, label) =>
      guard(
        inTeam(
          ref,
          issueId,
          patch(issueId, (issue) => ({
            ...issue,
            labels: issue.labels.filter((existing) => existing !== label),
          })),
        ),
      ),
    setState: (ref, issueId, stateId) =>
      guard(
        inTeam(
          ref,
          issueId,
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
      ),
    createIssue: (ref, input) =>
      guard(
        Effect.gen(function* () {
          const issues = yield* Ref.get(issuesRef);
          const number = issues.length + 100;
          const identifier = `${ref.team}-${number}`;
          const created: RawIssue = {
            id: `uuid-${identifier}`,
            identifier,
            title: input.title,
            url: `https://linear.app/acme/issue/${identifier}`,
            body: input.body,
            labels: input.labels,
            assignees: [],
            stateName: "Todo",
            stateType: "unstarted",
            openBlockers: 0,
            priority: "medium",
          };
          yield* Ref.update(issuesRef, (current) => [...current, created]);
          if (seed.createIssueError) {
            return yield* new IssueTrackerError({
              reason: "unavailable",
              message: "Linear issueCreate timed out",
              writeMayHaveCommitted: true,
            });
          }
          return { id: created.id, identifier: created.identifier, url: created.url };
        }),
      ),
    createComment: (ref, issueId, body) =>
      guard(
        inTeam(
          ref,
          issueId,
          Effect.gen(function* () {
            const seq = yield* Ref.get(commentSeq);
            yield* Ref.set(commentSeq, seq + 1);
            const comment: RawComment = {
              id: `comment-${seq}`,
              authorId: bot.id,
              authorAssociation: "NONE",
              body,
              createdAtMillis: seq,
            };
            yield* Ref.update(commentsRef, (all) =>
              new Map(all).set(issueId, [...(all.get(issueId) ?? []), comment]),
            );
          }),
        ),
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
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "lin",
    checkoutPath: "/repos/lin",
    issueTracker: {
      type: "linear",
      teams: ["AUD"],
    },
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

const multiTeamWorkspace: RegisteredWorkspace = {
  source: "linear.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "multi",
    checkoutPath: "/repos/multi",
    issueTracker: {
      type: "linear",
      teams: ["GRO", "BIL"],
    },
  }),
};

const withClient = (seed: Seed) =>
  Layer.mergeAll(adapterLayer, SourceControl.emptyLayer).pipe(
    Layer.provideMerge(
      Layer.effect(LinearClient, fakeClient(seed)).pipe(Layer.provideMerge(LinearClientCalls.layer)),
    ),
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
  it.effect("executes issue actions once and confirms their write keys", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const client = yield* LinearClient;
      const origin = WorkflowActionOrigin.make({
        item: keyOf({ _tag: "Issue", workspace: workspace.config.name, id: id("AUD-5") }),
        workflow: WorkflowId.make("issue-actions"),
        attempt: RunId.make("issue-actions-attempt"),
        writeKey: "create-key",
      });

      const artifact = yield* tracker.createIssue(workspace, {
        title: "Created",
        body: "Body",
        labels: ["needs-triage"],
        origin,
      });
      yield* tracker.commentIssue(workspace, id("AUD-5"), "Comment", "comment-key");
      yield* tracker.commentIssue(workspace, id("AUD-5"), "Comment", "comment-key");
      yield* tracker.addLabels(workspace, id("AUD-5"), ["added"], "add-key");
      yield* tracker.removeLabel(workspace, id("AUD-5"), "old", "remove-key");
      yield* tracker.closeIssue(workspace, id("AUD-5"), "close-key");

      const issues = yield* client.observeIssues(teamRef, null);
      const current = issues.find(({ identifier }) => identifier === "AUD-5");
      const created = issues.find(({ title }) => title === "Created");
      const comments = yield* client.listComments(teamRef, "AUD-5", botCoordination);
      assert.deepStrictEqual(artifact.origin, origin);
      assert.include(created?.body ?? "", "create-key");
      assert.deepStrictEqual(current?.labels, ["added"]);
      assert.strictEqual(current?.stateType, "completed");
      assert.strictEqual(comments.filter(({ body }) => body.includes("Comment")).length, 1);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-5", title: "Existing", labels: ["old"] }],
        }),
      ),
    ),
  );

  it.effect("creates an issue on the current item's configured team", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const origin = WorkflowActionOrigin.make({
        item: keyOf({ _tag: "Issue", workspace: multiTeamWorkspace.config.name, id: id("BIL-7") }),
        workflow: WorkflowId.make("issue-actions"),
        attempt: RunId.make("issue-actions-attempt"),
        writeKey: "create-key",
      });

      const artifact = yield* tracker.createIssue(multiTeamWorkspace, {
        title: "Created",
        body: "Body",
        labels: [],
        origin,
      });

      assert.match(artifact.issue, /^BIL-/);
    }).pipe(Effect.provide(withClient({ issues: [] }))),
  );

  it.effect("parks an ambiguous create when recovery cannot find the issue", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const origin = WorkflowActionOrigin.make({
        item: keyOf({ _tag: "Issue", workspace: workspace.config.name, id: id("AUD-5") }),
        workflow: WorkflowId.make("issue-actions"),
        attempt: RunId.make("issue-actions-attempt"),
        writeKey: "create-key",
      });

      const error = yield* tracker
        .createIssue(workspace, { title: "Created", body: "Body", labels: [], origin })
        .pipe(Effect.flip);

      assert.strictEqual(error.retryable, false);
      assert.strictEqual(error.writeMayHaveCommitted, true);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [],
          createIssueError: true,
          hideActionIssue: true,
        }),
      ),
    ),
  );

  it.effect("confirms workflow writes without loading admission prose", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const calls = yield* LinearClientCalls;

      yield* tracker.commentIssue(workspace, id("AUD-5"), "Comment", "comment-key");

      assert.strictEqual(yield* Ref.get(calls.readProse), 0);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-5", title: "Existing", labels: [] }],
        }),
      ),
    ),
  );

  it.effect("recovers a created issue without observing the backlog", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const origin = WorkflowActionOrigin.make({
        item: keyOf({ _tag: "Issue", workspace: workspace.config.name, id: id("AUD-5") }),
        workflow: WorkflowId.make("issue-actions"),
        attempt: RunId.make("issue-actions-attempt"),
        writeKey: "create-key",
      });

      const artifact = yield* tracker
        .createIssue(workspace, {
          title: "Created",
          body: "Body",
          labels: [],
          origin,
        })
        .pipe(Effect.match({ onFailure: () => null, onSuccess: (created) => created }));

      assert.strictEqual(artifact?.issue, "AUD-77");
    }).pipe(
      Effect.provide(
        withClient({
          observeError: true,
          issues: [
            {
              identifier: "AUD-77",
              title: "Created",
              labels: [],
              description: wireCodec.encode({ name: "write", pairs: "key=create-key" }),
            },
          ],
        }),
      ),
    ),
  );

  it.effect("confirms a completed target without observing the backlog", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;

      const closed = yield* tracker
        .closeIssue(workspace, id("AUD-5"), "close-key")
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));

      const comments = yield* (yield* LinearClient).listComments(teamRef, "AUD-5", botCoordination);
      assert.isTrue(closed);
      assert.isTrue(comments.some(({ body }) => body.includes("key=close-key")));
    }).pipe(
      Effect.provide(
        withClient({
          observeError: true,
          issues: [
            {
              identifier: "AUD-5",
              title: "Done",
              labels: [],
              stateName: "Done",
              stateType: "completed",
            },
          ],
        }),
      ),
    ),
  );

  it.effect("reads current issue prose and comment attribution for admission", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const prose = yield* tracker.readProse(workspace, id("AUD-41"));
      assert.deepStrictEqual(prose, {
        body: "Original request",
        comments: [
          {
            author: "maintainer-id",
            authorAssociation: "MEMBER",
            body: "Latest steer",
            createdAtMillis: 2,
          },
        ],
      });
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            {
              identifier: "AUD-41",
              title: "prose",
              labels: ["state:ready-for-agent"],
              description: "Original request",
            },
          ],
          comments: [
            {
              issue: "AUD-41",
              authorId: "maintainer-id",
              authorAssociation: "MEMBER",
              body: "Latest steer",
              createdAtMillis: 2,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("holds a ready-for-agent ticket with an open blocker out of the eligible set", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.find((item) => item.id === "AUD-30")?.openBlockers, 1);
      assert.strictEqual(items.find((item) => item.id === "AUD-31")?.openBlockers, 0);
      const { eligible, blocked } = classify(items);
      assert.deepStrictEqual(blocked, [
        {
          id: id("AUD-30"),
          title: "waits on AUD-31",
          url: "https://linear.app/acme/issue/AUD-30",
          openBlockers: 1,
        },
      ]);
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

  it.effect("hands the workspace assignee allowlist to the client's server-side filter", () => {
    const allowlistWorkspace: RegisteredWorkspace = {
      ...workspace,
      config: {
        ...workspace.config,
        issueTracker: { ...workspace.config.issueTracker, assigneeAllowlist: ["user-me"] },
      },
    };
    return Effect.gen(function* () {
      const calls = yield* LinearClientCalls;
      yield* observeItems(allowlistWorkspace);
      assert.deepStrictEqual(yield* Ref.get(calls.assigneeFilters), [["user-me"]]);
    }).pipe(Effect.provide(withClient({ issues: [] })));
  });

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

  it.effect("stamps a claim with the cogwork identity and writes it as a visible plain-text ledger", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const client = yield* LinearClient;
      const request = { claimedAtMillis: 1_722_000_000_000, stage: "implement" } as const;
      yield* source.claim(workspace, id("AUD-7"), request);
      const comments = botComments(yield* client.listComments(teamRef, "AUD-7", botCoordination));
      assert.strictEqual(comments.length, 1);
      assert.isTrue(hasLedgerMarker(comments[0]?.body ?? ""));
      assert.isFalse(comments[0]?.body.includes("<!--") ?? true);
      const observed = (yield* observeItems(workspace)).find((item) => item.id === "AUD-7");
      assert.deepStrictEqual(observed?.claim, claimRecord(workspace, "AUD-7", request.claimedAtMillis));
      assert.isTrue(observed?.claimHeld);
      assert.isTrue(observed?.claimedByUs);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [{ identifier: "AUD-7", title: "claim me", labels: ["state:ready-for-agent"] }],
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
              body: "cogwork:ledger\ncogwork:claim by=attacker at=1",
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
                markers: [serializeCodingAttempt("triage", "succeeded", 1)],
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

  it.effect("reclassify applies configured labels and moves wontfix to Canceled", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const client = yield* LinearClient;
      yield* source.reclassify(workspace, id("AUD-9"), {
        changes: { remove: ["needs-triage"], add: ["wontfix"] },
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

  it.effect("observes a whole backlog with one client read regardless of issue count", () => {
    const backlog = Array.from({ length: 60 }, (_, index) => ({
      identifier: `AUD-${index + 1}`,
      title: `issue ${index + 1}`,
      labels: ["state:ready-for-agent"],
    }));
    return Effect.gen(function* () {
      const calls = yield* LinearClientCalls;
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.length, 60);
      assert.strictEqual(yield* Ref.get(calls.observe), 1);
    }).pipe(Effect.provide(withClient({ issues: backlog })));
  });

  it.effect("reports the rate-limit scope from the token env so shared credentials back off together", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      assert.strictEqual(source.rateLimitScope(workspace), "linear:LINEAR_API_KEY");
    }).pipe(Effect.provide(withClient({ issues: [] }))),
  );

  it("maps Linear's native priority enum onto the canonical scale, No priority to medium", () => {
    assert.strictEqual(linearPriority(1), "urgent");
    assert.strictEqual(linearPriority(2), "high");
    assert.strictEqual(linearPriority(3), "medium");
    assert.strictEqual(linearPriority(4), "low");
    // 0 is Linear's "No priority"; undefined is an issue that never carried the field.
    assert.strictEqual(linearPriority(0), "medium");
    assert.strictEqual(linearPriority(undefined), "medium");
  });

  it.effect("carries each item's priority onto observed items and orders eligible work by it", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(workspace);
      assert.strictEqual(items.find((item) => item.id === "AUD-50")?.priority, "urgent");
      assert.strictEqual(items.find((item) => item.id === "AUD-51")?.priority, "low");
      assert.deepStrictEqual(
        classify(items).eligible.map((entry) => entry.id),
        [id("AUD-50"), id("AUD-51")],
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { identifier: "AUD-51", title: "low", labels: ["state:ready-for-agent"], priority: "low" },
            { identifier: "AUD-50", title: "urgent", labels: ["state:ready-for-agent"], priority: "urgent" },
          ],
        }),
      ),
    ),
  );

  it.effect("polls every configured team and merges the observed items", () =>
    Effect.gen(function* () {
      const items = yield* observeItems(multiTeamWorkspace);
      assert.deepStrictEqual(items.map((item) => item.id).sort(), ["BIL-1", "GRO-1"]);
      assert.deepStrictEqual(
        classify(items)
          .eligible.map((entry) => entry.id)
          .sort(),
        ["BIL-1", "GRO-1"],
      );
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { identifier: "GRO-1", title: "growth work", labels: ["state:ready-for-agent"] },
            { identifier: "BIL-1", title: "billing work", labels: ["state:ready-for-agent"] },
          ],
        }),
      ),
    ),
  );

  it.effect("routes a write to the team named by the issue prefix, not the first team", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const request = { claimedAtMillis: 1_722_000_000_000, stage: "implement" } as const;
      yield* source.claim(multiTeamWorkspace, id("BIL-7"), request);
      const observed = (yield* observeItems(multiTeamWorkspace)).find((item) => item.id === "BIL-7");
      assert.deepStrictEqual(
        observed?.claim,
        claimRecord(multiTeamWorkspace, "BIL-7", request.claimedAtMillis),
      );
      assert.isTrue(observed?.claimHeld);
    }).pipe(
      Effect.provide(
        withClient({
          issues: [
            { identifier: "GRO-1", title: "growth work", labels: ["state:ready-for-agent"] },
            { identifier: "BIL-7", title: "claim me", labels: ["state:ready-for-agent"] },
          ],
        }),
      ),
    ),
  );

  it.effect("fails clearly when an item's prefix matches none of the configured teams", () =>
    Effect.gen(function* () {
      const source = yield* IssueTracker;
      const request = { claimedAtMillis: 1_722_000_000_000, stage: "implement" } as const;
      const result = yield* Effect.result(source.claim(multiTeamWorkspace, id("ZZZ-1"), request));
      if (result._tag !== "Failure" || result.failure._tag !== "IssueTrackerError") {
        assert.fail("expected an IssueTrackerError for an unconfigured team");
        return;
      }
      assert.strictEqual(result.failure.reason, "unavailable");
      assert.include(result.failure.message, "ZZZ-1");
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
