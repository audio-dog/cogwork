import {
  keyOf,
  LineageId,
  RunId,
  WorkflowActionOrigin,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ListedTrackerItem, TrackerComment } from "./issue-tracker";
import type { RegisteredWorkspace, WorkspaceIssueTrackerBinding } from "./projector";
import { makeTrackerTriggerSource } from "./tracker-trigger-source";
import type { TriggerEvent, TriggerSubscription } from "./trigger-source";
import type { WorkflowArtifactStoreService } from "./workflow-artifact-store";

const workspaceId = Schema.decodeSync(WorkspaceId)("github-workspace");
const linearWorkspaceId = Schema.decodeSync(WorkspaceId)("linear-workspace");
const registered = (
  id: WorkspaceId,
  issueTracker: (typeof WorkspaceConfig.Encoded)["issueTracker"],
): RegisteredWorkspace => ({
  source: "test",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id,
    displayName: id,
    checkoutPath: `/repos/${id}`,
    issueTracker,
  }),
});
const githubWorkspace = registered(workspaceId, { type: "github" });
const linearWorkspace = registered(linearWorkspaceId, { type: "linear", teams: ["AUD"] });
const registryState = { workspaces: [linearWorkspace, githubWorkspace], failures: [] };
const workflow = Schema.decodeSync(WorkflowId)("coding");
const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-has-label");
const newCommentKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-comment-from-person");
const issueNotBlockedKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-not-blocked");
const firstIssueId = Schema.decodeSync(WorkItemId)("#1");
const unchangedIssueId = Schema.decodeSync(WorkItemId)("#3");
const commentedTrigger = Schema.decodeSync(WorkflowNodeId)("commented");
const label = [{ id: "label", value: "needs-triage" }];

const subscription = (entry: WorkflowCatalogKey, trigger: string): TriggerSubscription => ({
  workflow,
  trigger: Schema.decodeSync(WorkflowNodeId)(trigger),
  operation: Schema.decodeSync(WorkflowNodeId)("follow-up"),
  entry,
  parameters: label,
  filters: [],
  workspaces: [workspaceId, linearWorkspaceId],
  catchUp: { since: 1_000 },
});

const item = (number: number, overrides: Partial<ListedTrackerItem> = {}): ListedTrackerItem => ({
  id: Schema.decodeSync(WorkItemId)(`#${number}`),
  title: `Issue ${number}`,
  url: `https://github.com/acme/example/issues/${number}`,
  assignees: [],
  openBlockers: 0,
  priority: "high",
  open: true,
  labels: ["needs-triage"],
  createdAtMillis: number,
  ...overrides,
});

const comment = (id: string, createdAtMillis: number, authoredByPerson: boolean): TrackerComment => ({
  id,
  author: authoredByPerson ? "maintainer" : "outside-user",
  authorAssociation: authoredByPerson ? "MEMBER" : "NONE",
  authoredByPerson,
  body: id,
  createdAtMillis,
});

const comments = [comment("1", 900, true), comment("2", 2_000, true), comment("5", 1_600, false)];

const tracker = (options: {
  readonly changed?: ReadonlyArray<ListedTrackerItem>;
  readonly labelled?: ReadonlyArray<ListedTrackerItem>;
  readonly read?: (workspace: WorkspaceIssueTrackerBinding, sinceMillis: number) => void;
}) => ({
  openItemsChangedSince: (workspace: WorkspaceIssueTrackerBinding, sinceMillis: number) => {
    options.read?.(workspace, sinceMillis);
    return Effect.succeed(options.changed ?? []);
  },
  openItemsWithLabel: (_workspace: WorkspaceIssueTrackerBinding, label: string) =>
    Effect.succeed((options.labelled ?? []).filter(({ labels }) => labels.includes(label))),
  readItem: () => Effect.succeed(null),
  readTriggerProse: () => Effect.succeed({ body: "Body", comments }),
  labelAppliedAt: (_workspace: WorkspaceIssueTrackerBinding, id: WorkItemId) =>
    Effect.succeed(id === firstIssueId ? 1_500 : null),
  listLabels: () => Effect.succeed([]),
});

const workContext = {
  body: "Body",
  comments: [
    { author: "maintainer", authorAssociation: "MEMBER", body: "1", createdAtMillis: 900 },
    { author: "maintainer", authorAssociation: "MEMBER", body: "2", createdAtMillis: 2_000 },
    { author: "outside-user", authorAssociation: "NONE", body: "5", createdAtMillis: 1_600 },
  ],
};

describe("Tracker Trigger source", () => {
  it.effect(
    "emits a label condition and person comments after the cutoff, reading only its system's workspaces",
    () => {
      const read: Array<WorkspaceId> = [];
      const source = makeTrackerTriggerSource(
        "github",
        tracker({
          changed: [item(2, { open: false }), item(1)],
          read: (workspace) => read.push(workspace.config.id),
        }),
        Effect.succeed(registryState),
        null,
      );
      return Effect.gen(function* () {
        const events = yield* source
          .observe([subscription(issueHasLabelKey, "labelled"), subscription(newCommentKey, "commented")])
          .pipe(Stream.take(2), Stream.runCollect);
        const shared = {
          key: { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
          workspace: workspaceId,
          priority: "high",
          parameters: label,
          passes: [issueNotBlockedKey],
          subject: { title: "Issue 1", url: "https://github.com/acme/example/issues/1" },
          workContext,
        };

        assert.deepStrictEqual(
          [...events],
          [
            {
              ...shared,
              revision: "label:needs-triage:1500",
              cause: { _tag: "Unknown" },
              atMillis: 1_500,
              entry: issueHasLabelKey,
            },
            {
              ...shared,
              revision: "comment:2:label:needs-triage",
              cause: { _tag: "Person" },
              atMillis: 2_000,
              entry: newCommentKey,
              target: { workflow, trigger: commentedTrigger },
            },
          ],
        );
        assert.deepStrictEqual(read, [workspaceId]);
      });
    },
  );

  it.effect("names the Cogwork write in an item's origin record as the label event's cause", () => {
    const lineage = { root: LineageId.make("issue:root"), parent: null, hop: 4 } as const;
    const origin = WorkflowActionOrigin.make({
      item: keyOf({ _tag: "Issue", workspace: workspaceId, id: firstIssueId }),
      workflow,
      attempt: RunId.make("creating-run"),
      writeKey: "create-issue",
      lineage,
    });
    const artifacts = {
      record: () => Effect.die("unused"),
      all: Effect.die("unused"),
      byLineage: () => Effect.die("unused"),
      origin: () => Effect.succeed(origin),
    } satisfies WorkflowArtifactStoreService;
    const source = makeTrackerTriggerSource(
      "github",
      tracker({ labelled: [item(1)] }),
      Effect.succeed(registryState),
      artifacts,
    );
    return Effect.gen(function* () {
      const [event] = yield* source
        .observe([subscription(issueHasLabelKey, "labelled")])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(event?.cause, { _tag: "Cogwork", origin: origin.item, lineage });
    });
  });

  it.effect(
    "reads open items with a filtered Trigger's label, so an unblocked item that did not change is seen",
    () => {
      const source = makeTrackerTriggerSource(
        "github",
        tracker({ labelled: [item(3), item(4, { labels: ["other"] })] }),
        Effect.succeed(registryState),
        null,
      );
      const filtered = { ...subscription(newCommentKey, "unblocked"), filters: [issueNotBlockedKey] };
      return Effect.gen(function* () {
        const admitted: Array<TriggerEvent["key"]> = [];
        const observing = yield* source.observe([filtered]).pipe(
          Stream.runForEach(({ key }) => Effect.sync(() => admitted.push(key))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(observing);

        assert.deepStrictEqual(admitted, [{ _tag: "Issue", workspace: workspaceId, id: unchangedIssueId }]);
      });
    },
  );

  it.effect("emits an open item that has a condition label at start, with no modified-since read", () => {
    const changedReads: Array<number> = [];
    const source = makeTrackerTriggerSource(
      "github",
      tracker({ labelled: [item(3)], read: (_workspace, since) => changedReads.push(since) }),
      Effect.succeed(registryState),
      null,
    );
    return Effect.gen(function* () {
      const admitted: Array<TriggerEvent["key"]> = [];
      const observing = yield* source.observe([subscription(issueHasLabelKey, "labelled")]).pipe(
        Stream.runForEach(({ key }) => Effect.sync(() => admitted.push(key))),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(observing);

      assert.deepStrictEqual(admitted, [{ _tag: "Issue", workspace: workspaceId, id: unchangedIssueId }]);
      assert.deepStrictEqual(changedReads, []);
    });
  });

  it.effect("starts the first modified-since read at the earliest catch-up cutoff, less the grace", () => {
    const changedReads: Array<number> = [];
    const source = makeTrackerTriggerSource(
      "github",
      tracker({ read: (_workspace, since) => changedReads.push(since) }),
      Effect.succeed(registryState),
      null,
    );
    const catchUpDays = (trigger: string, days: string) => ({
      ...subscription(newCommentKey, trigger),
      parameters: [...label, { id: "catch-up-at-most", value: days }],
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(864_000_000);
      const observing = yield* source
        .observe([catchUpDays("one-day", "1"), catchUpDays("three-days", "3")])
        .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(observing);

      assert.deepStrictEqual(changedReads, [604_770_000]);
    });
  });
});
