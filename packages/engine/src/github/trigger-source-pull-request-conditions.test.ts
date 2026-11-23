import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";

import { GitHubClient } from "./client";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";
import { pullDetail, registryState, subscription, trustedPull } from "./trigger-source-fixtures";

describe("GitHub pull request condition dates", () => {
  it.effect("dates a failing check by its completion and a conflict by the poll that first saw it", () => {
    const mergeability = ["clean", "dirty", "unknown"];
    const listPulls = vi.fn(() =>
      Effect.succeed([{ ...trustedPull, baseSha: listPulls.mock.calls.length > 3 ? "base-2" : "base-sha" }]),
    );
    const getPull = vi.fn((_target: unknown, number: number) =>
      Effect.succeed(pullDetail(number, mergeability[getPull.mock.calls.length - 1] ?? "dirty")),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const observed = yield* makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState))
        .observe([
          subscription("github.pull-request-checks-failed", "checks"),
          subscription("github.pull-request-conflicts-with-base", "conflicts"),
        ])
        .pipe(Stream.take(6), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("61 seconds");
      yield* TestClock.adjust("61 seconds");
      yield* TestClock.adjust("61 seconds");
      const events = yield* Fiber.join(observed);

      assert.deepStrictEqual(
        [...events].map(({ revision, atMillis }) => [revision, atMillis]),
        [
          ["checks:head-sha:test:failure", 2_900],
          ["checks:head-sha:test:failure", 2_900],
          ["conflict:head-sha:base-sha", 60_000],
          ["checks:head-sha:test:failure", 2_900],
          ["checks:head-sha:test:failure", 2_900],
          ["conflict:head-sha:base-2", 60_000],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
          listPulls,
          listCheckRuns: () =>
            Effect.succeed([
              {
                name: "test",
                status: "completed",
                conclusion: "failure",
                startedAtMillis: 2_500,
                completedAtMillis: 2_900,
              },
            ]),
          getPull,
          listPullFiles: () => Effect.succeed([]),
          listTriggerComments: () => Effect.succeed([]),
          listReviewComments: () => Effect.succeed([]),
          listReviews: () => Effect.succeed([]),
        }),
      ),
    );
  });

  it.effect("remembers a clean pull across a restarted observation", () => {
    const getPull = vi.fn((_target: unknown, number: number) =>
      Effect.succeed(pullDetail(number, getPull.mock.calls.length > 1 ? "dirty" : "clean")),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = makeGitHubPullRequestTriggerSource(client, Effect.succeed(registryState));
      const observe = source
        .observe([
          subscription("github.pull-request-checks-failed", "checks"),
          subscription("github.pull-request-conflicts-with-base", "conflicts"),
        ])
        .pipe(Stream.take(1), Stream.runCollect);
      yield* observe;
      yield* TestClock.adjust("10 seconds");
      const events = yield* source
        .observe([subscription("github.pull-request-conflicts-with-base", "conflicts")])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ revision, atMillis }) => [revision, atMillis]),
        [["conflict:head-sha:base-sha", 10_000]],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
          listPulls: () => Effect.succeed([trustedPull]),
          listCheckRuns: () =>
            Effect.succeed([
              { name: "test", status: "completed", conclusion: "failure", startedAtMillis: 2_500 },
            ]),
          getPull,
          listPullFiles: () => Effect.succeed([]),
          listTriggerComments: () => Effect.succeed([]),
          listReviewComments: () => Effect.succeed([]),
          listReviews: () => Effect.succeed([]),
        }),
      ),
    );
  });
});
