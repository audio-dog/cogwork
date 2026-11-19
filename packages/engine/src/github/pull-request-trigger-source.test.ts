import { IssueTrackerError } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import { GitHubClient } from "./client";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";
import {
  botRegistryState,
  githubTrackerInstance,
  issue,
  issueReads,
  pullClientLayer,
  registryState,
  reviewTrigger,
  subscription,
  targetOf,
  trustedPull,
  workflow,
  workspaceId,
} from "./trigger-source-fixtures";

describe("GitHub pull request Trigger source", () => {
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
