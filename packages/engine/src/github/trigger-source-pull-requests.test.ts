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
  pullClientLayer,
  pullDetail,
  registryState,
  reviewTrigger,
  subscription,
  targetOf,
  trustedPull,
  workflow,
  workspaceId,
} from "./trigger-source-fixtures";

describe("GitHub Trigger sources", () => {
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

  it.effect(
    "freezes the failed check, mergeability, refs and changed files in pull request Work Context",
    () =>
      Effect.gen(function* () {
        const client = yield* GitHubClient;
        const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
        const events = yield* source
          .observe([subscription("github.pull-request-checks-failed", "checks")])
          .pipe(Stream.take(1), Stream.runCollect);
        const body = events[0]?.workContext?.body ?? "";

        assert.include(
          body,
          "- test: completed, failure, https://github.com/acme/example/actions/runs/1\n  - Title: 1 test failed\n  - Summary:\n    expected 1 to equal 2",
        );
        assert.include(body, "## Description\n    Pull request description");
        assert.include(body, "## Mergeability\ndirty, conflicts with base");
        assert.include(body, "- Head: 7-work@head-sha\n- Base: main@base-sha");
        assert.include(body, "## Changed files\n- src/index.ts (modified, +3 -1)");
        assert.notInclude(body, "secret patch");
      }).pipe(Effect.provide(pullClientLayer())),
  );

  it.effect(
    "reads changed files only for a pull that emits an event and reads each pull once per poll",
    () => {
      const quietPull = { ...trustedPull, number: 12, headSha: "quiet-sha" };
      const getPull = vi.fn((_target: unknown, number: number) =>
        Effect.succeed(pullDetail(number, "clean")),
      );
      const listPullFiles = vi.fn((_target: unknown, _baseSha: string, _headSha: string) =>
        Effect.succeed([]),
      );

      return Effect.gen(function* () {
        const client = yield* GitHubClient;
        yield* makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState))
          .observe([
            subscription("github.pull-request-checks-failed", "checks"),
            subscription("github.pull-request-conflicts-with-base", "conflicts"),
          ])
          .pipe(Stream.take(1), Stream.runCollect);

        assert.deepStrictEqual(getPull.mock.calls.map(([, number]) => number).toSorted(), [10, 12]);
        assert.deepStrictEqual(
          listPullFiles.mock.calls.map(([, baseSha, headSha]) => [baseSha, headSha]),
          [["base-sha", "head-sha"]],
        );
      }).pipe(
        Effect.provide(
          Layer.mock(GitHubClient, {
            authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
            listPulls: () => Effect.succeed([quietPull, trustedPull]),
            listCheckRuns: (_target, sha) =>
              Effect.succeed([
                {
                  name: "test",
                  status: "completed",
                  conclusion: sha === "quiet-sha" ? "success" : "failure",
                  startedAtMillis: 2_500,
                },
              ]),
            getPull,
            listPullFiles,
            listTriggerComments: () => Effect.succeed([]),
            listReviewComments: () => Effect.succeed([]),
            listReviews: () => Effect.succeed([]),
          }),
        ),
      );
    },
  );

  it.effect("keeps a checks-failed event when the changed files read fails", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const observed = yield* makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState))
        .observe([subscription("github.pull-request-checks-failed", "checks")])
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("1 second"),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const events = Option.getOrElse(yield* Fiber.join(observed), () => []);

      assert.strictEqual(events[0]?.revision, "checks:head-sha:test:failure");
      assert.include(events[0]?.workContext?.body ?? "", "## Changed files\nunavailable");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
          listPulls: () => Effect.succeed([trustedPull]),
          listCheckRuns: () =>
            Effect.succeed([
              { name: "test", status: "completed", conclusion: "failure", startedAtMillis: 2_500 },
            ]),
          getPull: (_target, number) => Effect.succeed(pullDetail(number, "clean")),
          listPullFiles: () =>
            Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "compare timed out" })),
          listTriggerComments: () => Effect.succeed([]),
          listReviewComments: () => Effect.succeed([]),
          listReviews: () => Effect.succeed([]),
        }),
      ),
    ),
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
          getPull: (_target, number) => Effect.succeed(pullDetail(number, "clean")),
          listPullFiles: () => Effect.succeed([]),
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
          getPull: (_target, number) => Effect.succeed(pullDetail(number, "clean")),
          listPullFiles: () => Effect.succeed([]),
          listTriggerComments: () => Effect.succeed([]),
          listReviewComments: () => Effect.succeed([]),
          listReviews: () => Effect.succeed([]),
        }),
      ),
    );
  });

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
