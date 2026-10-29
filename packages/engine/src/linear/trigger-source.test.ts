import {
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vitest";
import type { RegisteredWorkspace } from "../projector";
import type { TriggerSubscription } from "../trigger-source";
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
const subscription = (entry: string, trigger: string, label = "needs-triage"): TriggerSubscription => ({
  workflow: Schema.decodeSync(WorkflowId)("coding"),
  trigger: Schema.decodeSync(WorkflowNodeId)(trigger),
  operation: Schema.decodeSync(WorkflowNodeId)("triage"),
  entry: Schema.decodeSync(WorkflowCatalogKey)(entry),
  parameters: [{ id: "label", value: label }],
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
      stateName: "Done",
      stateType: "completed",
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
      [...events].map(({ revision, cause }) => [revision, cause._tag]),
      [
        ["comment:new:label:needs-triage", "Person"],
        ["comment:new:label:ready-for-human", "Person"],
        ["label:needs-triage:3000", "Unknown"],
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
