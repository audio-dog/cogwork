import {
  IssueTrackerError,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import type { RegisteredWorkspace } from "../projector";
import { matchTriggerEvent } from "../trigger-observation";
import { Recheck, type TriggerSubscription } from "../trigger-source";
import { makeWorkflowOptions } from "../workflow-options";
import { LinearClient, type LinearClientService } from "./client";
import { makeLinearTrackerTriggerSource } from "./tracker-trigger-source";

const workspaceId = Schema.decodeSync(WorkspaceId)("linear-workspace");
const workspace: RegisteredWorkspace = {
  source: "test",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: workspaceId,
    checkoutPath: "/repos/example",
    issueTracker: { type: "linear", teams: ["ENG"], assigneeAllowlist: ["owner"] },
  }),
};
const registryState = { workspaces: [workspace], failures: [] };
const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("linear.issue-has-label");
const issueNotBlockedKey = Schema.decodeSync(WorkflowCatalogKey)("linear.issue-not-blocked");
const firstIssueId = Schema.decodeSync(WorkItemId)("ENG-1");
const secondIssueId = Schema.decodeSync(WorkItemId)("ENG-2");
const thirdIssueId = Schema.decodeSync(WorkItemId)("ENG-3");
const subscription = (entry: string, trigger: string, label = "needs-triage"): TriggerSubscription => ({
  workflow: Schema.decodeSync(WorkflowId)("coding"),
  trigger: Schema.decodeSync(WorkflowNodeId)(trigger),
  operation: Schema.decodeSync(WorkflowNodeId)("triage"),
  entry: Schema.decodeSync(WorkflowCatalogKey)(entry),
  parameters: [{ id: "label", value: label }],
  filters: [],
  workspaces: [workspaceId],
  catchUp: { since: 1_000 },
});

const observeIssues = vi.fn<LinearClientService["observeIssues"]>(() =>
  Effect.succeed([
    {
      id: "issue-id",
      identifier: "ENG-1",
      title: "Issue",
      url: "https://linear.app/acme/issue/ENG-1",
      labels: ["needs-triage", "ready-for-human"],
      assignees: ["owner"],
      stateName: "In Progress",
      stateType: "started",
      openBlockers: 0,
      priority: "medium" as const,
      updatedAtMillis: 3_000,
      coordinationComments: [],
    },
  ]),
);

const readTriggerProse = vi.fn(() =>
  Effect.succeed({
    body: "Body",
    comments: [
      {
        id: "old",
        authorId: "person",
        authorAssociation: "MEMBER" as const,
        body: "old",
        createdAtMillis: 900,
      },
      {
        id: "new",
        authorId: "person",
        authorAssociation: "MEMBER" as const,
        body: "new",
        createdAtMillis: 2_000,
      },
      {
        id: "marked",
        authorId: "person",
        authorAssociation: "MEMBER" as const,
        body: "cogwork:agent-note",
        createdAtMillis: 1_900,
      },
    ],
  }),
);
const readProse = vi.fn(() => readTriggerProse());
const targetTriggerOf = (event: object) => {
  if (!("target" in event) || typeof event.target !== "object" || event.target === null) return undefined;
  return "trigger" in event.target ? event.target.trigger : undefined;
};

it.effect("lists the team's Linear labels without reading its issues", () => {
  const listLabels = vi.fn<LinearClientService["listLabels"]>(() =>
    Effect.succeed(["state:needs-triage", "unused-yet"]),
  );

  return Effect.gen(function* () {
    const client = yield* LinearClient;
    const source = makeLinearTrackerTriggerSource(client, Effect.succeed(registryState));
    const entry = source.entries.find(({ key }) => key === issueHasLabelKey);
    if (!entry) return assert.fail("missing issue-has-label entry");
    const options = yield* makeWorkflowOptions(source.options ?? []).list(entry, "label", [workspaceId]);

    assert.deepStrictEqual(options, [
      { value: "state:needs-triage", name: "state:needs-triage", listedIn: [workspaceId] },
      { value: "unused-yet", name: "unused-yet", listedIn: [workspaceId] },
    ]);
    assert.strictEqual(listLabels.mock.calls.length, 1);
  }).pipe(Effect.provide(Layer.mock(LinearClient, { listLabels })));
});

it.effect("reads Linear updates and keeps comment revisions distinct by label", () =>
  Effect.gen(function* () {
    const client = yield* LinearClient;
    const events = yield* makeLinearTrackerTriggerSource(client, Effect.succeed(registryState))
      .observe([
        subscription("linear.issue-has-label", "label"),
        subscription("linear.new-comment-from-person", "comment"),
        subscription("linear.new-comment-from-person", "ready-comment", "ready-for-human"),
      ])
      .pipe(Stream.take(3), Stream.runCollect);

    assert.deepStrictEqual(
      [...events].map((event) => [event.revision, event.cause._tag, targetTriggerOf(event)]),
      [
        ["comment:new:label:needs-triage", "Person", "comment"],
        ["comment:new:label:ready-for-human", "Person", "ready-comment"],
        ["label:needs-triage:3000", "Unknown", undefined],
      ],
    );
    assert.isTrue(observeIssues.mock.calls[0]?.[4]);
    assert.strictEqual(readTriggerProse.mock.calls.length, 1);
    assert.strictEqual(readProse.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      Layer.mock(LinearClient, {
        observeIssues,
        readProse,
        readTriggerProse,
        labelAppliedAt: () => Effect.succeed(3_000),
      }),
    ),
  ),
);

const issue = (number: number) => ({
  id: `issue-${number}`,
  identifier: `ENG-${number}`,
  title: `Issue ${number}`,
  url: `https://linear.app/acme/issue/ENG-${number}`,
  labels: ["needs-triage"],
  assignees: ["owner"],
  stateName: "In Progress",
  stateType: "started",
  openBlockers: 0,
  priority: "medium" as const,
  updatedAtMillis: number + 3_000,
  coordinationComments: [],
});

it.effect("matches open issues only, and a not-blocked filter only unblocked issues", () =>
  Effect.gen(function* () {
    const client = yield* LinearClient;
    const source = makeLinearTrackerTriggerSource(client, Effect.succeed(registryState));
    const labelled = { ...subscription("linear.issue-has-label", "labelled"), catchUp: null };
    const unblocked = {
      ...subscription("linear.issue-has-label", "unblocked"),
      catchUp: null,
      filters: [issueNotBlockedKey],
    };
    const events = yield* source.observe([labelled, unblocked]).pipe(Stream.take(2), Stream.runCollect);
    const admitted = (selected: TriggerSubscription) =>
      [...events].filter((event) => matchTriggerEvent([selected], event).length > 0).map(({ key }) => key);

    assert.deepStrictEqual(admitted(labelled), [
      { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
      { _tag: "Issue", workspace: workspaceId, id: secondIssueId },
    ]);
    assert.deepStrictEqual(admitted(unblocked), [
      { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mock(LinearClient, {
        observeIssues: () =>
          Effect.succeed([
            { ...issue(3), stateType: "canceled" },
            { ...issue(4), stateType: "completed" },
            issue(1),
            { ...issue(2), openBlockers: 1 },
          ]),
        observeLabelledIssues: () => Effect.succeed([]),
        readTriggerProse: () => Effect.succeed({ body: "Body", comments: [] }),
        labelAppliedAt: (_target, id) => Effect.succeed(id === "issue-3" || id === "issue-4" ? 1_000 : 3_000),
      }),
    ),
  ),
);

it.effect("reads every open issue with a filtered Trigger's label, so an unblocked issue is seen", () => {
  const observeLabelledIssues = vi.fn<LinearClientService["observeLabelledIssues"]>(() =>
    Effect.succeed([issue(1)]),
  );
  return Effect.gen(function* () {
    const client = yield* LinearClient;
    const source = makeLinearTrackerTriggerSource(client, Effect.succeed(registryState));
    const filtered = {
      ...subscription("linear.issue-has-label", "unblocked"),
      catchUp: null,
      filters: [issueNotBlockedKey],
    };
    const events = yield* source.observe([filtered]).pipe(Stream.take(1), Stream.runCollect);

    assert.deepStrictEqual(
      [...events].map(({ key }) => key),
      [{ _tag: "Issue", workspace: workspaceId, id: firstIssueId }],
    );
    assert.strictEqual(observeLabelledIssues.mock.calls[0]?.[1], "needs-triage");
  }).pipe(
    Effect.provide(
      Layer.mock(LinearClient, {
        observeIssues: () => Effect.succeed([]),
        observeLabelledIssues,
        readTriggerProse: () => Effect.succeed({ body: "Body", comments: [] }),
        labelAppliedAt: () => Effect.succeed(3_000),
      }),
    ),
  );
});

it.effect.each([
  { case: "still matches", read: issue(1), expected: Recheck.Matches() },
  {
    case: "is canceled",
    read: { ...issue(1), stateType: "canceled" },
    expected: Recheck.Ended({ reason: "ENG-1 is closed" }),
  },
  {
    case: "is blocked",
    read: { ...issue(1), openBlockers: 1 },
    expected: Recheck.Waiting({ reason: "ENG-1 fails Issue is not blocked" }),
  },
  { case: "no longer exists", read: null, expected: Recheck.Ended({ reason: "ENG-1 no longer exists" }) },
])("rechecks a Linear issue that $case", ({ read, expected }) =>
  Effect.gen(function* () {
    const client = yield* LinearClient;
    const source = makeLinearTrackerTriggerSource(client, Effect.succeed(registryState));
    const selected = {
      ...subscription("linear.issue-has-label", "unblocked"),
      filters: [issueNotBlockedKey],
    };
    const event = {
      key: { _tag: "Issue" as const, workspace: workspaceId, id: firstIssueId },
      revision: "label:needs-triage:1",
      cause: { _tag: "Unknown" as const },
      atMillis: 1,
      entry: issueHasLabelKey,
      workspace: workspaceId,
    };
    const result = yield* source.recheck?.(event, selected) ?? Effect.die("missing recheck");

    assert.deepStrictEqual(result, expected);
  }).pipe(
    Effect.provide(
      Layer.mock(LinearClient, {
        readTriggerIssue: () => Effect.succeed(read),
      }),
    ),
  ),
);

it.effect("skips a failed Linear issue read and advances the workspace cursor", () => {
  const listIssues = vi
    .fn<LinearClientService["observeIssues"]>()
    .mockReturnValueOnce(Effect.succeed([issue(1), issue(2)]))
    .mockReturnValue(Effect.succeed([issue(3)]));

  return Effect.gen(function* () {
    yield* TestClock.setTime(100_000);
    const client = yield* LinearClient;
    const observed = yield* makeLinearTrackerTriggerSource(client, Effect.succeed(registryState))
      .observe([subscription("linear.issue-has-label", "label")])
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
    assert.strictEqual(listIssues.mock.calls[1]?.[3], 70_000);
  }).pipe(
    Effect.provide(
      Layer.mock(LinearClient, {
        observeIssues: listIssues,
        readTriggerProse: (_target, id) =>
          id === "issue-1"
            ? Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "issue read failed" }))
            : Effect.succeed({ body: "Body", comments: [] }),
        labelAppliedAt: () => Effect.succeed(3_000),
      }),
    ),
  );
});
