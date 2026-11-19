import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { IssueTrackerError, type TrackerItem } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import {
  makeWorkspaceObservation,
  nextSelectedIssueId,
  selectedEvent,
  selectedIssueId,
  selectedTrackerItem,
  selectedWorkspace,
  selectedWorkspaceId,
} from "./trigger-observation-fixtures";

const workspaceTrackedBy = (
  issueTracker: (typeof WorkspaceConfig.Encoded)["issueTracker"],
): RegisteredWorkspace => ({
  ...selectedWorkspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    id: selectedWorkspaceId,
    displayName: "Test workspace",
    checkoutPath: "/repos/selected",
    issueTracker,
  }),
});
const teammateTrackerItem: TrackerItem = {
  ...selectedTrackerItem,
  id: Schema.decodeSync(WorkItemId)("#3"),
  assignees: ["teammate"],
};
const linearTrackerItem: TrackerItem = {
  ...selectedTrackerItem,
  id: Schema.decodeSync(WorkItemId)("FEL-157"),
  assignees: ["linear-owner"],
};
const trackerUnavailable = () =>
  Effect.fail(
    new IssueTrackerError({
      reason: "unavailable",
      retryable: false,
      message: "closing numbers are not Linear items",
    }),
  );
const pullRequestGateCases = [
  {
    case: "admits a pull request whose closing reference names an allowlisted item outside the snapshot",
    options: { exactAssignees: (itemId: WorkItemId) => Effect.succeed(itemId === "#5" ? ["owner"] : []) },
    pullRequest: { author: "teammate", headRef: "feature", closingIssueNumbers: [5] },
    admitted: true,
  },
  {
    case: "declines a pull request linked only to a teammate's item, even from an allowlisted author",
    options: { observedItems: [selectedTrackerItem, teammateTrackerItem] },
    pullRequest: { author: "owner", headRef: "3-fix", closingIssueNumbers: [] },
    admitted: false,
  },
  {
    case: "declines a pull request whose branch names a teammate's item outside the snapshot",
    options: { exactAssignees: (itemId: WorkItemId) => Effect.succeed(itemId === "#42" ? ["teammate"] : []) },
    pullRequest: { author: "owner", headRef: "42-fix", closingIssueNumbers: [] },
    admitted: false,
  },
  {
    case: "admits an unlinked pull request from an allowlisted author",
    options: {},
    pullRequest: { author: "owner", headRef: "feature", closingIssueNumbers: [] },
    admitted: true,
  },
  {
    case: "declines an unlinked pull request from a teammate",
    options: {},
    pullRequest: { author: "teammate", headRef: "feature", closingIssueNumbers: [] },
    admitted: false,
  },
  {
    case: "declines a pull request event without ownership",
    options: {},
    pullRequest: undefined,
    admitted: false,
  },
  {
    case: "admits a pull request linked to a Linear item by its branch prefix, without reading closing numbers",
    options: {
      workspace: workspaceTrackedBy({ type: "linear", teams: ["FEL"], assigneeAllowlist: ["linear-owner"] }),
      observedItems: [linearTrackerItem],
      exactAssignees: trackerUnavailable,
    },
    pullRequest: { author: "teammate", headRef: "fel-157-fix", closingIssueNumbers: [3] },
    admitted: true,
  },
  {
    case: "admits a pull request event without ownership when no allowlist is set",
    options: { workspace: workspaceTrackedBy({ type: "github" }) },
    pullRequest: undefined,
    admitted: true,
  },
];

describe("TriggerObservation", () => {
  it.effect.each(pullRequestGateCases)("$case", ({ options, pullRequest, admitted }) =>
    Effect.gen(function* () {
      const { observation, scripted, observed } = yield* makeWorkspaceObservation(options);
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
        ...(pullRequest === undefined ? {} : { pullRequest }),
      });
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(changed);

      assert.strictEqual(Option.isSome(result), admitted);
      assert.strictEqual(yield* Ref.get(observed), admitted ? 1 : 0);
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
