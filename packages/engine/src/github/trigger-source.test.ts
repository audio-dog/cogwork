import {
  GitHubIssueFieldId,
  IssueTrackerError,
  keyOf,
  LineageId,
  RunId,
  WorkflowActionOrigin,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import type { RegisteredWorkspace, RegistryState } from "../projector";
import { makeTrackerTriggerSource } from "../tracker-trigger-source";
import { matchTriggerEvent } from "../trigger-observation";
import { Recheck, type TriggerSubscription } from "../trigger-source";
import type { WorkflowArtifactStoreService } from "../workflow-artifact-store";
import { makeWorkflowOptions } from "../workflow-options";
import { GitHubClient, type GitHubClientService, type GitHubRepoRef, type RawPull } from "./client";
import { makeIssueReads } from "./host";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";

const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-has-label");
const newIssueCommentKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-comment-from-person");
const githubTrackerInstance = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
  artifacts: WorkflowArtifactStoreService | null = null,
) => makeTrackerTriggerSource("github", makeIssueReads(client), registry, artifacts);

const workspaceId = Schema.decodeSync(WorkspaceId)("github-workspace");
const workspace: RegisteredWorkspace = {
  source: "test",
  repository: "acme/example",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: workspaceId,
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
  }),
};
const registryState = { workspaces: [workspace], failures: [] };
const botWorkspace: RegisteredWorkspace = {
  ...workspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: workspaceId,
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
    sourceControl: { type: "github", botAllowlist: ["maintainer"] },
  }),
};
const botRegistryState = { workspaces: [botWorkspace], failures: [] };
const prioritizedWorkspace: RegisteredWorkspace = {
  ...workspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: workspaceId,
    checkoutPath: "/repos/example",
    issueTracker: { type: "github", priority: { field: 42 } },
  }),
};
const priorityFieldId = Schema.decodeSync(GitHubIssueFieldId)(42);
const workflow = Schema.decodeSync(WorkflowId)("coding");
const operation = Schema.decodeSync(WorkflowNodeId)("follow-up");
const reviewTrigger = Schema.decodeSync(WorkflowNodeId)("review");
const issueNotBlockedKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-not-blocked");
const firstIssueId = Schema.decodeSync(WorkItemId)("#1");
const secondIssueId = Schema.decodeSync(WorkItemId)("#2");
const thirdIssueId = Schema.decodeSync(WorkItemId)("#3");
const subscription = (
  entry: string,
  trigger: string,
  parameters: TriggerSubscription["parameters"] = [],
  since = 1_000,
): TriggerSubscription => ({
  workflow,
  trigger: Schema.decodeSync(WorkflowNodeId)(trigger),
  operation,
  entry: Schema.decodeSync(WorkflowCatalogKey)(entry),
  parameters,
  filters: [],
  workspaces: [workspaceId],
  catchUp: { since },
});

const issue = (number: number, isPullRequest = false) => ({
  nodeId: `issue-${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/example/issues/${number}`,
  labels: ["needs-triage"],
  assignees: ["maintainer"],
  isPullRequest,
  openBlockers: 0,
  body: "Body",
  state: "open" as const,
  createdAtMillis: number,
  updatedAtMillis: number + 3_000,
});

const issueReads = {
  readIssue: (_target: GitHubRepoRef, number: number) => Effect.succeed(issue(number)),
  listTriggerComments: () => Effect.succeed([]),
} satisfies Partial<GitHubClientService>;

const trustedPull: RawPull = {
  number: 10,
  url: "https://github.com/acme/example/pull/10",
  authorLogin: "maintainer",
  authorAssociation: "MEMBER",
  draft: false,
  headSha: "head-sha",
  baseSha: "base-sha",
  headRef: "7-work",
  headRepository: "acme/example",
  closingIssueNumbers: [7],
  updatedAtMillis: 3_000,
};

const pulls: Array<RawPull> = [
  {
    number: 11,
    url: "https://github.com/acme/example/pull/11",
    authorLogin: "outside-user",
    authorAssociation: "NONE",
    draft: false,
    headSha: "outside-sha",
    baseSha: "base-sha",
    headRef: "99-work",
    headRepository: "outside/fork",
    closingIssueNumbers: [99],
    updatedAtMillis: 2_900,
  },
  trustedPull,
];

const pullClientLayer = (listedPulls = pulls) =>
  Layer.mock(GitHubClient, {
    authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
    listPulls: () => Effect.succeed(listedPulls),
    listCheckRuns: () =>
      Effect.succeed([{ name: "test", status: "completed", conclusion: "failure", startedAtMillis: 2_500 }]),
    pullMergeableState: () => Effect.succeed("dirty"),
    listTriggerComments: () => Effect.succeed([]),
    listReviewComments: () => Effect.succeed([]),
    listReviews: () =>
      Effect.succeed([
        {
          id: 88,
          authorLogin: "maintainer",
          authorAssociation: "MEMBER",
          authorType: "User",
          state: "COMMENTED",
          body: "Review body",
          submittedAtMillis: 2_800,
        },
      ]),
  });

const targetOf = (event: object) => ("target" in event ? event.target : undefined);

describe("GitHub Trigger sources", () => {
  it.effect("lists the repository's labels without reading its issues", () => {
    const listLabels = vi.fn<GitHubClientService["listLabels"]>(() =>
      Effect.succeed(["needs-triage", "unused-yet"]),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const entry = source.entries.find(({ key }) => key === issueHasLabelKey);
      if (!entry) return assert.fail("missing issue-has-label entry");
      const options = yield* makeWorkflowOptions(source.options ?? []).list(entry, "label", [workspaceId]);

      assert.deepStrictEqual(options, [
        { value: "needs-triage", name: "needs-triage", listedIn: [workspaceId] },
        { value: "unused-yet", name: "unused-yet", listedIn: [workspaceId] },
      ]);
      assert.strictEqual(listLabels.mock.calls.length, 1);
    }).pipe(Effect.provide(Layer.mock(GitHubClient, { listLabels })));
  });

  it.effect("emits current labels and keeps person-comment revisions distinct by label", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([
          subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }]),
          subscription("github.new-comment-from-person", "comment", [
            { id: "label", value: "needs-triage" },
            { id: "catch-up-at-most", value: "7" },
          ]),
          subscription("github.new-comment-from-person", "ready-comment", [
            { id: "label", value: "ready-for-human" },
            { id: "catch-up-at-most", value: "7" },
          ]),
        ])
        .pipe(Stream.take(3), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ entry, revision, cause }) => [entry, revision, cause._tag]),
        [
          [issueHasLabelKey, "label:needs-triage:1500", "Unknown"],
          [newIssueCommentKey, "comment:2:label:needs-triage", "Person"],
          [newIssueCommentKey, "comment:2:label:ready-for-human", "Person"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () =>
            Effect.succeed([issue(2, true), { ...issue(1), labels: ["needs-triage", "ready-for-human"] }]),
          listIssueEvents: (_target, number) =>
            Effect.succeed([
              {
                id: number,
                event: "labeled",
                labelName: "needs-triage",
                createdAtMillis: number === 2 ? 1_200 : 1_500,
              },
            ]),
          listTriggerComments: (_target, number) =>
            Effect.succeed(
              number === 2
                ? []
                : [
                    {
                      id: 1,
                      authorLogin: "maintainer",
                      authorAssociation: "MEMBER",
                      body: "old",
                      createdAtMillis: 900,
                    },
                    {
                      id: 2,
                      authorLogin: "maintainer",
                      authorAssociation: "MEMBER",
                      body: "new",
                      createdAtMillis: 2_000,
                    },
                    {
                      id: 5,
                      authorLogin: "outside-user",
                      authorAssociation: "NONE",
                      body: "outside",
                      createdAtMillis: 1_600,
                    },
                    {
                      id: 3,
                      authorLogin: "maintainer",
                      authorAssociation: "MEMBER",
                      body: "written by Cogwork\n<!-- cogwork:agent-note -->",
                      createdAtMillis: 1_900,
                    },
                    {
                      id: 4,
                      authorLogin: "review-bot",
                      authorAssociation: "NONE",
                      authorType: "Bot",
                      body: "automated",
                      createdAtMillis: 1_800,
                    },
                  ],
            ),
        }),
      ),
    ),
  );

  it.effect("matches open issues only, and a not-blocked filter only unblocked issues", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const label = [{ id: "label", value: "needs-triage" }];
      const labelled = { ...subscription("github.issue-has-label", "labelled", label), catchUp: null };
      const unblocked = { ...labelled, trigger: reviewTrigger, filters: [issueNotBlockedKey] };
      const events = yield* source.observe([labelled, unblocked]).pipe(Stream.take(2), Stream.runCollect);
      const admitted = (selected: TriggerSubscription) =>
        [...events].filter((event) => matchTriggerEvent([selected], event).length > 0).map(({ key }) => key);

      assert.deepStrictEqual(admitted(labelled), [
        { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
        { _tag: "Issue", workspace: workspaceId, id: secondIssueId },
      ]);
      assert.deepStrictEqual(admitted(unblocked), [
        { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () =>
            Effect.succeed([
              { ...issue(3), state: "closed", createdAtMillis: 0 },
              issue(1),
              { ...issue(2), openBlockers: 1 },
            ]),
          listIssueEvents: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("reads every open issue with a filtered Trigger's label, so an unblocked issue is seen", () => {
    const listIssues = vi.fn<GitHubClientService["listIssues"]>((_target, query) =>
      Effect.succeed(query?.label === "needs-triage" ? [issue(1)] : []),
    );
    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const filtered = {
        ...subscription("github.issue-has-label", "unblocked", [{ id: "label", value: "needs-triage" }]),
        catchUp: null,
        filters: [issueNotBlockedKey],
      };
      const events = yield* source.observe([filtered]).pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ key }) => key),
        [{ _tag: "Issue", workspace: workspaceId, id: firstIssueId }],
      );
      assert.deepStrictEqual(listIssues.mock.calls.at(-1)?.[1], { state: "open", label: "needs-triage" });
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, { ...issueReads, listIssues, listIssueEvents: () => Effect.succeed([]) }),
      ),
    );
  });

  it.effect.each([
    { case: "still matches", read: issue(1), filtered: true, expected: Recheck.Matches() },
    {
      case: "is closed",
      read: { ...issue(1), state: "closed" as const },
      filtered: false,
      expected: Recheck.Ended({ reason: "#1 is closed" }),
    },
    {
      case: "lost its label",
      read: { ...issue(1), labels: [] },
      filtered: false,
      expected: Recheck.Ended({ reason: "#1 no longer has label needs-triage" }),
    },
    {
      case: "is blocked",
      read: { ...issue(1), openBlockers: 2 },
      filtered: true,
      expected: Recheck.Waiting({ reason: "#1 fails Issue is not blocked" }),
    },
    {
      case: "is blocked, unfiltered",
      read: { ...issue(1), openBlockers: 2 },
      filtered: false,
      expected: Recheck.Matches(),
    },
  ])("rechecks an issue that $case", ({ read, filtered, expected }) =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const labelled = subscription("github.issue-has-label", "label", [
        { id: "label", value: "needs-triage" },
      ]);
      const selected = filtered ? { ...labelled, filters: [issueNotBlockedKey] } : labelled;
      const event = {
        key: { _tag: "Issue" as const, workspace: workspaceId, id: firstIssueId },
        revision: "label:needs-triage:1",
        cause: { _tag: "Unknown" as const },
        atMillis: 1,
        entry: issueHasLabelKey,
        workspace: workspaceId,
      };
      const result = yield* source.recheck?.(event, selected) ?? Effect.die("missing recheck");

      assert.deepStrictEqual(result, expected);
    }).pipe(Effect.provide(Layer.mock(GitHubClient, { readIssue: () => Effect.succeed(read) }))),
  );

  it.effect("carries the trimmed issue title and its link on a label event", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ subject }) => subject),
        [{ title: "Fix login", url: "https://github.com/acme/example/issues/1" }],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([{ ...issue(1), title: "  Fix login " }]),
          listIssueEvents: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("carries the creating Workflow lineage into issue label events", () =>
    Effect.gen(function* () {
      const inherited = { root: LineageId.make("issue:root"), parent: null, hop: 4 } as const;
      const origin = WorkflowActionOrigin.make({
        item: keyOf({ _tag: "Issue", workspace: workspaceId, id: firstIssueId }),
        workflow,
        attempt: RunId.make("creating-run"),
        writeKey: "create-issue",
        lineage: inherited,
      });
      const artifacts = {
        record: () => Effect.die("unused"),
        all: Effect.die("unused"),
        byLineage: () => Effect.die("unused"),
        origin: () => Effect.succeed(origin),
      } satisfies WorkflowArtifactStoreService;
      const client = yield* GitHubClient;
      const [event] = yield* githubTrackerInstance(client, Effect.succeed(registryState), artifacts)
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(event?.cause, {
        _tag: "Cogwork",
        origin: origin.item,
        lineage: inherited,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1)]),
          listIssueEvents: () =>
            Effect.succeed([{ id: 1, event: "labeled", labelName: "needs-triage", createdAtMillis: 1_500 }]),
          listTriggerComments: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("ranks issue events by the configured priority field", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const events = yield* githubTrackerInstance(
        client,
        Effect.succeed({ workspaces: [prioritizedWorkspace], failures: [] }),
      )
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(Stream.take(2), Stream.runCollect);

      assert.deepStrictEqual(
        Array.from(events, (event) => [event.key, event.priority]),
        [
          [{ _tag: "Issue", workspace: workspaceId, id: firstIssueId }, "urgent"],
          [{ _tag: "Issue", workspace: workspaceId, id: secondIssueId }, "medium"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1), issue(2)]),
          listIssueEvents: () => Effect.succeed([]),
          listTriggerComments: () => Effect.succeed([]),
          listPriorityFields: () => Effect.succeed([{ id: priorityFieldId, name: "Priority" }]),
          listIssueFieldValues: () => Effect.succeed(new Map([[1, new Map([[42, "Urgent"]])]])),
        }),
      ),
    ),
  );

  it.effect("holds item 51 for the next poll", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const collected = yield* source
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(Stream.take(51), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;

      assert.isUndefined(collected.pollUnsafe());

      yield* TestClock.adjust("60 seconds");
      const events = yield* Fiber.join(collected);
      assert.lengthOf(events, 51);
      assert.strictEqual(events.at(-1)?.revision, "label:needs-triage:51");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed(Array.from({ length: 51 }, (_, index) => issue(index + 1))),
          listIssueEvents: (_target, number) =>
            Effect.succeed([
              { id: number, event: "labeled", labelName: "needs-triage", createdAtMillis: number },
            ]),
          listTriggerComments: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("starts the next tracker read before updates made during a long poll", () => {
    const firstEvent = Deferred.makeUnsafe<void>();
    const secondRead = Deferred.makeUnsafe<void>();
    const listIssues = vi.fn<GitHubClientService["listIssues"]>((_target, _options) => {
      if (listIssues.mock.calls.length === 1) {
        return TestClock.adjust("100 seconds").pipe(
          Effect.map(() => [
            { ...issue(1), updatedAtMillis: 90_000 },
            { ...issue(2), labels: [], updatedAtMillis: 190_000 },
          ]),
        );
      }
      return Deferred.succeed(secondRead, undefined).pipe(Effect.map(() => []));
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(100_000);
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const running = yield* source
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(
          Stream.tap(() => Deferred.succeed(firstEvent, undefined)),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(firstEvent);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.await(secondRead);

      assert.strictEqual(listIssues.mock.calls[1]?.[1]?.since, 70_000);
      yield* Fiber.interrupt(running);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues,
          listIssueEvents: () =>
            Effect.succeed([{ id: 1, event: "labeled", labelName: "needs-triage", createdAtMillis: 90_000 }]),
          listTriggerComments: () => Effect.succeed([]),
        }),
      ),
    );
  });

  it.effect("skips a failed GitHub issue read and advances the workspace cursor", () => {
    const listIssues = vi
      .fn<GitHubClientService["listIssues"]>()
      .mockReturnValueOnce(Effect.succeed([issue(1), issue(2)]))
      .mockReturnValue(Effect.succeed([issue(3)]));

    return Effect.gen(function* () {
      yield* TestClock.setTime(100_000);
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const observed = yield* source
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.catchTag("SourceFailure", () => Effect.succeed([] as const)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("60 seconds");
      const events = yield* Fiber.join(observed);

      assert.deepStrictEqual(
        [...events].map(({ key }) => key),
        [
          { _tag: "Issue", workspace: workspaceId, id: secondIssueId },
          { _tag: "Issue", workspace: workspaceId, id: thirdIssueId },
        ],
      );
      assert.strictEqual(listIssues.mock.calls[1]?.[1]?.since, 70_000);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues,
          listIssueEvents: (_target, number) =>
            number === 1
              ? Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "issue read failed" }))
              : Effect.succeed([
                  { id: number, event: "labeled", labelName: "needs-triage", createdAtMillis: number },
                ]),
          listTriggerComments: () => Effect.succeed([]),
        }),
      ),
    );
  });

  it.effect("keeps distinct items that share one source revision", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const collected = yield* source
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.timeoutOption("1 second"),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      const result = yield* Fiber.join(collected);
      assert.isTrue(Option.isSome(result));
      assert.deepStrictEqual(
        Option.getOrThrow(result).map(({ key }) => key),
        [
          { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
          { _tag: "Issue", workspace: workspaceId, id: secondIssueId },
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1), issue(2)]),
          listIssueEvents: () =>
            Effect.succeed([{ id: 1, event: "labeled", labelName: "needs-triage", createdAtMillis: 1_500 }]),
          listTriggerComments: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("admits live comments with zero catch-up", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(120_000);
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const collected = yield* source
        .observe([
          subscription("github.new-comment-from-person", "comment", [
            { id: "label", value: "needs-triage" },
            { id: "catch-up-at-most", value: "0" },
          ]),
        ])
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("1 second"),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      const result = yield* Fiber.join(collected);
      assert.isTrue(Option.isSome(result));
      assert.strictEqual(Option.getOrThrow(result)[0]?.revision, "comment:1:label:needs-triage");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1)]),
          listIssueEvents: () => Effect.succeed([]),
          listTriggerComments: () =>
            Effect.succeed([
              {
                id: 2,
                authorLogin: "maintainer",
                authorAssociation: "MEMBER",
                body: "stale",
                createdAtMillis: 29_000,
              },
              {
                id: 1,
                authorLogin: "maintainer",
                authorAssociation: "MEMBER",
                body: "new",
                createdAtMillis: 60_001,
              },
            ]),
        }),
      ),
    ),
  );

  it.effect("keeps catch-up scoped to the Trigger that accepted the comment", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const wide = subscription(
        "github.new-comment-from-person",
        "wide-comment",
        [
          { id: "label", value: "needs-triage" },
          { id: "catch-up-at-most", value: "7" },
        ],
        0,
      );
      const live = subscription(
        "github.new-comment-from-person",
        "live-comment",
        [
          { id: "label", value: "needs-triage" },
          { id: "catch-up-at-most", value: "0" },
        ],
        0,
      );
      const events = yield* source.observe([wide, live]).pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        matchTriggerEvent([wide, live], events[0] ?? assert.fail("missing comment event")).map(
          ({ trigger }) => trigger,
        ),
        [wide.trigger],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1)]),
          listIssueEvents: () => Effect.succeed([]),
          listTriggerComments: () =>
            Effect.succeed([
              {
                id: 1,
                authorLogin: "maintainer",
                authorAssociation: "MEMBER",
                body: "caught up",
                createdAtMillis: 100_000,
              },
            ]),
        }),
      ),
    ),
  );

  it.effect("keys pull conditions by head and base revisions", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([
          subscription("github.pull-request-checks-failed", "checks"),
          subscription("github.pull-request-conflicts-with-base", "conflicts"),
        ])
        .pipe(Stream.take(2), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ revision }) => revision),
        ["checks:head-sha:test:failure", "conflict:head-sha:base-sha"],
      );
      assert.deepStrictEqual(events[0]?.key, {
        _tag: "PullRequest",
        workspace: workspaceId,
        number: 10,
      });
    }).pipe(Effect.provide(pullClientLayer())),
  );

  it.effect("skips a failed GitHub pull request read", () => {
    const failedPull = { ...trustedPull, number: 12, headSha: "failed-sha", closingIssueNumbers: [12] };
    const healthyPull = { ...trustedPull, number: 13, headSha: "healthy-sha", closingIssueNumbers: [13] };

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const events = yield* makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState))
        .observe([subscription("github.pull-request-checks-failed", "checks")])
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.catchTag("SourceFailure", () => Effect.succeed([] as const)),
        );

      assert.strictEqual(events[0]?.revision, "checks:healthy-sha:test:failure");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
          listPulls: () => Effect.succeed([failedPull, healthyPull]),
          listCheckRuns: (_target, sha) =>
            sha === "failed-sha"
              ? Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "pull read failed" }))
              : Effect.succeed([
                  {
                    name: "test",
                    status: "completed",
                    conclusion: "failure",
                    startedAtMillis: 2_500,
                  },
                ]),
          pullMergeableState: () => Effect.succeed("clean"),
          listTriggerComments: () => Effect.succeed([]),
          listReviewComments: () => Effect.succeed([]),
          listReviews: () => Effect.succeed([]),
        }),
      ),
    );
  });

  it.effect("polls pull conditions when the pull watermark does not move", () => {
    const listCheckRuns = vi.fn((_target: unknown, sha: string) =>
      Effect.succeed([
        {
          name: "test",
          status: "completed",
          conclusion:
            sha === "head-sha" &&
            listCheckRuns.mock.calls.filter(([, current]) => current === "head-sha").length > 1
              ? "failure"
              : "success",
          startedAtMillis: 2_500,
        },
      ]),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const observed = yield* source
        .observe([subscription("github.pull-request-checks-failed", "checks")])
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("61 seconds"),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("61 seconds");
      const result = yield* Fiber.join(observed);

      assert.isTrue(Option.isSome(result));
      assert.strictEqual(Option.getOrThrow(result)[0]?.revision, "checks:head-sha:test:failure");
      assert.strictEqual(listCheckRuns.mock.calls.filter(([, sha]) => sha === "head-sha").length, 2);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
          listPulls: () =>
            Effect.succeed([
              trustedPull,
              {
                ...trustedPull,
                number: 12,
                headSha: "new-head-sha",
                updatedAtMillis: 100_000,
              },
            ]),
          listCheckRuns,
          pullMergeableState: () => Effect.succeed("clean"),
          listTriggerComments: () => Effect.succeed([]),
          listReviewComments: () => Effect.succeed([]),
          listReviews: () => Effect.succeed([]),
        }),
      ),
    );
  });

  it.effect("excludes allowlisted bots from person-comment Triggers", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const sources = [
        githubTrackerInstance(client, Effect.succeed(botRegistryState)).observe([
          subscription("github.new-comment-from-person", "comment", [{ id: "label", value: "needs-triage" }]),
        ]),
        makeGitHubPullRequestTriggerSource(client, Effect.succeed(botRegistryState)).observe([
          subscription("github.new-review-comment-from-person", "review"),
        ]),
      ];
      const observed = yield* Effect.forEach(
        sources,
        (source) => source.pipe(Stream.take(1), Stream.runCollect, Effect.timeoutOption("1 second")),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      assert.isTrue((yield* Fiber.join(observed)).every(Option.isNone));
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1)]),
          listIssueEvents: () => Effect.succeed([]),
          listTriggerComments: (_target, number) =>
            Effect.succeed([
              {
                id: number,
                authorLogin: "maintainer",
                authorAssociation: "MEMBER",
                authorType: "User",
                body: "automated",
                createdAtMillis: 2_000,
              },
            ]),
          authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
          listPulls: () => Effect.succeed([trustedPull]),
          listCheckRuns: () => Effect.succeed([]),
          pullMergeableState: () => Effect.succeed("clean"),
          listReviewComments: () => Effect.succeed([]),
          listReviews: () =>
            Effect.succeed([
              {
                id: 89,
                authorLogin: "maintainer",
                authorAssociation: "MEMBER",
                authorType: "User",
                state: "COMMENTED",
                body: "automated",
                submittedAtMillis: 2_000,
              },
            ]),
        }),
      ),
    ),
  );

  it.effect("carries the pull request's ownership on condition and occurrence events", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([
          subscription("github.pull-request-checks-failed", "checks"),
          subscription("github.pull-request-conflicts-with-base", "conflicts"),
          subscription("github.new-review-comment-from-person", "review"),
        ])
        .pipe(Stream.take(3), Stream.runCollect);

      const ownership = { author: "maintainer", headRef: "7-work", closingIssueNumbers: [7] };
      assert.deepStrictEqual([...events].map(({ entry }) => entry).toSorted(), [
        "github.new-review-comment-from-person",
        "github.pull-request-checks-failed",
        "github.pull-request-conflicts-with-base",
      ]);
      assert.deepStrictEqual(
        [...events].map(({ pullRequest }) => pullRequest),
        [ownership, ownership, ownership],
      );
    }).pipe(Effect.provide(pullClientLayer())),
  );

  it.effect("carries review bodies in occurrence prose", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([subscription("github.new-review-comment-from-person", "review")])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(events[0]?.revision, "review-88");
      assert.strictEqual(events[0]?.workContext?.comments[0]?.body, "Review body");
      assert.deepStrictEqual(events[0] ? targetOf(events[0]) : undefined, {
        workflow,
        trigger: reviewTrigger,
      });
    }).pipe(Effect.provide(pullClientLayer())),
  );

  it.effect("keeps an unlinked digit-prefixed branch as a pull request item", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([subscription("github.pull-request-checks-failed", "checks")])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(events[0]?.key, {
        _tag: "PullRequest",
        workspace: workspaceId,
        number: 20,
      });
    }).pipe(
      Effect.provide(
        pullClientLayer([
          {
            number: 20,
            url: "https://github.com/acme/example/pull/20",
            authorLogin: "maintainer",
            authorAssociation: "MEMBER",
            draft: false,
            headSha: "release-sha",
            baseSha: "base-sha",
            headRef: "2026-release",
            headRepository: "acme/example",
            closingIssueNumbers: [],
            updatedAtMillis: 3_000,
          },
        ]),
      ),
    ),
  );

  it.effect("keeps a Linear-style branch unlinked in a GitHub tracker Workspace", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([subscription("github.pull-request-checks-failed", "checks")])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(events[0]?.key, {
        _tag: "PullRequest",
        workspace: workspaceId,
        number: 21,
      });
    }).pipe(
      Effect.provide(
        pullClientLayer([
          {
            ...trustedPull,
            number: 21,
            headRef: "ENG-123-work",
            closingIssueNumbers: [],
          },
        ]),
      ),
    ),
  );
});
