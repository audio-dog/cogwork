import { IssueTrackerError } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import { matchTriggerEvent } from "../trigger-observation";
import type { TriggerEvent } from "../trigger-source";
import { GitHubClient, type GitHubClientService } from "./client";
import {
  firstIssueId,
  githubTrackerInstance,
  issue,
  issueReads,
  registryState,
  secondIssueId,
  subscription,
  workspaceId,
} from "./trigger-source-fixtures";

describe("GitHub Tracker Trigger source polling", () => {
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
        .observe([
          subscription("github.new-comment-from-person", "comment", [{ id: "label", value: "needs-triage" }]),
        ])
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
          listTriggerComments: () =>
            Effect.succeed([
              {
                id: 1,
                authorLogin: "maintainer",
                authorAssociation: "MEMBER",
                body: "new",
                createdAtMillis: 90_000,
              },
            ]),
        }),
      ),
    );
  });

  it.effect("skips a failed GitHub issue read and admits the unchanged issue on the next poll", () => {
    const changedOnce = vi
      .fn<GitHubClientService["listIssues"]>(() => Effect.succeed([]))
      .mockReturnValueOnce(Effect.succeed([issue(1), issue(2)]));
    const listIssues: GitHubClientService["listIssues"] = (target, query) =>
      query?.label === undefined ? changedOnce(target, query) : Effect.succeed([issue(1), issue(2)]);
    const listIssueEvents = vi
      .fn<GitHubClientService["listIssueEvents"]>((_target, number) =>
        Effect.succeed([
          { id: number, event: "labeled", labelName: "needs-triage", createdAtMillis: number },
        ]),
      )
      .mockReturnValueOnce(
        Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "issue read failed" })),
      );

    return Effect.gen(function* () {
      yield* TestClock.setTime(100_000);
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const admitted: Array<TriggerEvent["key"]> = [];
      const observing = yield* source
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(
          Stream.runForEach(({ key }) => Effect.sync(() => admitted.push(key))),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("60 seconds");
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(observing);

      assert.deepStrictEqual(admitted, [
        { _tag: "Issue", workspace: workspaceId, id: secondIssueId },
        { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
        { _tag: "Issue", workspace: workspaceId, id: secondIssueId },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues,
          listIssueEvents,
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
});
