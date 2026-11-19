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
import { GitHubClient, type GitHubClientService } from "./client";
import {
  firstIssueId,
  githubTrackerInstance,
  issue,
  issueReads,
  registryState,
  secondIssueId,
  subscription,
  thirdIssueId,
  workspaceId,
} from "./trigger-source-fixtures";

describe("GitHub Trigger sources", () => {
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
});
