import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { matchTriggerEvent } from "../trigger-observation-subscriptions";
import { GitHubClient } from "./client";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";
import {
  botRegistryState,
  githubTrackerInstance,
  issue,
  issueReads,
  pullDetail,
  registryState,
  subscription,
  trustedPull,
} from "./trigger-source-fixtures";

describe("GitHub Trigger sources", () => {
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
          getPull: (_target, number) => Effect.succeed(pullDetail(number, "clean")),
          listPullFiles: () => Effect.succeed([]),
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
});
