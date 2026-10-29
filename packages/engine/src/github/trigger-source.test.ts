import {
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { RegisteredWorkspace } from "../projector";
import type { TriggerSubscription } from "../trigger-source";
import { GitHubClient, type RawPull } from "./client";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";
import {
  issueHasLabelKey,
  makeGitHubTrackerTriggerSource,
  newIssueCommentKey,
} from "./tracker-trigger-source";

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
const workflow = Schema.decodeSync(WorkflowId)("coding");
const operation = Schema.decodeSync(WorkflowNodeId)("follow-up");
const linkedIssueId = Schema.decodeSync(WorkItemId)("#7");
const firstIssueId = Schema.decodeSync(WorkItemId)("#1");
const secondIssueId = Schema.decodeSync(WorkItemId)("#2");
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
  {
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
  },
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
          authorLogin: "maintainer",
          authorAssociation: "MEMBER",
          authorType: "User",
          state: "COMMENTED",
          body: "Review body",
          submittedAtMillis: 2_800,
        },
      ]),
  });

describe("GitHub Trigger sources", () => {
  it.effect("emits current labels and only new markerless person comments", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubTrackerTriggerSource(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([
          subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }]),
          subscription("github.new-comment-from-person", "comment", [
            { id: "label", value: "needs-triage" },
            { id: "catch-up-at-most", value: "7" },
          ]),
        ])
        .pipe(Stream.take(2), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ entry, revision, cause }) => [entry, revision, cause._tag]),
        [
          [issueHasLabelKey, "label:needs-triage:1500", "Unknown"],
          [newIssueCommentKey, "comment:2", "Person"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          listIssues: () => Effect.succeed([issue(2, true), issue(1)]),
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

  it.effect("holds item 51 for the next poll", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubTrackerTriggerSource(client, Effect.succeed(registryState));
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

  it.effect("keeps distinct items that share one source revision", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubTrackerTriggerSource(client, Effect.succeed(registryState));
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
      const source = makeGitHubTrackerTriggerSource(client, Effect.succeed(registryState));
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
      assert.strictEqual(Option.getOrThrow(result)[0]?.revision, "comment:1");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
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
        _tag: "Issue",
        workspace: workspaceId,
        id: linkedIssueId,
      });
    }).pipe(Effect.provide(pullClientLayer())),
  );

  it.effect("carries review bodies in occurrence prose", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([subscription("github.new-review-comment-from-person", "review")])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(events[0]?.revision, "review-2800-0");
      assert.strictEqual(events[0]?.prose?.comments[0]?.body, "Review body");
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
});
