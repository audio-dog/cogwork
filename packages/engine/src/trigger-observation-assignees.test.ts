import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { IssueTrackerError } from "./issue-tracker";
import {
  makeWorkspaceObservation,
  nextSelectedIssueId,
  selectedEvent,
  selectedIssueId,
  selectedWorkspaceId,
} from "./trigger-observation-fixtures";

describe("TriggerObservation", () => {
  it.effect("admits a standalone pull request through an assignee-gated Workspace", () =>
    Effect.gen(function* () {
      const { observation, scripted, trackerCalls } = yield* makeWorkspaceObservation();
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        ...selectedEvent,
        key: { _tag: "PullRequest", workspace: selectedWorkspaceId, number: 7 },
        revision: "pull-7",
      });
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(changed);

      assert.isTrue(Option.isSome(result));
      assert.strictEqual(yield* Ref.get(trackerCalls), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reuses one assignee snapshot for a Trigger batch", () =>
    Effect.gen(function* () {
      const { observation, scripted, trackerCalls } = yield* makeWorkspaceObservation();
      const changed = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(selectedEvent);
      yield* scripted.emit({ ...selectedEvent, revision: "issue-2" });
      yield* Fiber.join(changed);

      assert.strictEqual(yield* Ref.get(trackerCalls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("loads and reuses assignees for an item outside the tracker snapshot", () =>
    Effect.gen(function* () {
      const { observation, scripted, trackerCalls, exactAssigneeCalls } = yield* makeWorkspaceObservation({
        observedItems: [],
        exactAssignees: () => Effect.succeed(["owner"]),
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(selectedEvent);
      yield* scripted.emit({ ...selectedEvent, revision: "issue-2" });
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(changed)));
      assert.strictEqual(yield* Ref.get(trackerCalls), 1);
      assert.strictEqual(yield* Ref.get(exactAssigneeCalls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps observing after one assignee lookup fails", () =>
    Effect.gen(function* () {
      const { observation, scripted, exactAssigneeCalls } = yield* makeWorkspaceObservation({
        observedItems: [],
        exactAssignees: (itemId) =>
          itemId === selectedIssueId
            ? Effect.fail(
                new IssueTrackerError({
                  reason: "unavailable",
                  retryable: false,
                  message: "unrecognized work item id",
                }),
              )
            : Effect.succeed(["owner"]),
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* scripted.emit(selectedEvent);
      yield* scripted.emit({
        ...selectedEvent,
        key: { ...selectedEvent.key, id: nextSelectedIssueId },
        revision: "issue-2",
      });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      const result = yield* Fiber.join(changed);
      assert.strictEqual(yield* Ref.get(exactAssigneeCalls), 2);
      assert.isTrue(Option.isSome(result));
      assert.strictEqual(Option.getOrThrow(result)[0]?.event.key._tag, "Issue");
      assert.strictEqual(Option.getOrThrow(result)[0]?.event.revision, "issue-2");
    }).pipe(Effect.scoped),
  );
});
