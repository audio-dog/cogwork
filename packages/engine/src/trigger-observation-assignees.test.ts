import type { WorkItemId } from "@cogwork/contracts";
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
  unassignedIssueId,
  ungatedWorkspace,
} from "./trigger-observation-fixtures";

describe("TriggerObservation", () => {
  it.effect("admits a standalone pull request through an assignee-gated Workspace", () =>
    Effect.gen(function* () {
      const { observation, scripted, assigneeReads } = yield* makeWorkspaceObservation();
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
      assert.deepStrictEqual(yield* Ref.get(assigneeReads), []);
    }).pipe(Effect.scoped),
  );

  it.effect("admits an Issue only when its own assignee is on the allowlist", () =>
    Effect.gen(function* () {
      const assigneesById = new Map([
        [nextSelectedIssueId, ["someone-else"]],
        [unassignedIssueId, []],
      ]);
      const { observation, scripted, assigneeReads } = yield* makeWorkspaceObservation({
        assignees: (itemId) => Effect.succeed(assigneesById.get(itemId) ?? ["owner"]),
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      const issueEvent = (id: WorkItemId, revision: string) => ({
        ...selectedEvent,
        key: { ...selectedEvent.key, id },
        revision,
      });
      yield* scripted.emit(issueEvent(nextSelectedIssueId, "someone-else"));
      yield* scripted.emit(issueEvent(unassignedIssueId, "unassigned"));
      yield* scripted.emit(issueEvent(selectedIssueId, "owner"));
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(changed);

      assert.deepStrictEqual(
        Option.map(result, (admissions) => admissions.map(({ event }) => event.revision)),
        Option.some(["owner"]),
      );
      assert.deepStrictEqual(yield* Ref.get(assigneeReads), [
        nextSelectedIssueId,
        unassignedIssueId,
        selectedIssueId,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("admits an Issue without reading assignees when the Workspace has no allowlist", () =>
    Effect.gen(function* () {
      const { observation, scripted, assigneeReads } = yield* makeWorkspaceObservation({
        workspace: ungatedWorkspace,
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(selectedEvent);
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(changed)));
      assert.deepStrictEqual(yield* Ref.get(assigneeReads), []);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps observing after one assignee lookup fails", () =>
    Effect.gen(function* () {
      const { observation, scripted, assigneeReads } = yield* makeWorkspaceObservation({
        assignees: (itemId) =>
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
      assert.strictEqual((yield* Ref.get(assigneeReads)).length, 2);
      assert.isTrue(Option.isSome(result));
      assert.strictEqual(Option.getOrThrow(result)[0]?.event.key._tag, "Issue");
      assert.strictEqual(Option.getOrThrow(result)[0]?.event.revision, "issue-2");
    }).pipe(Effect.scoped),
  );
});
