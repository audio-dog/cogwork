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
import type { RegisteredWorkspace } from "../projector";
import type { TriggerSubscription } from "../trigger-source";
import { LinearClient } from "./client";
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
const subscription = (entry: string, trigger: string): TriggerSubscription => ({
  workflow: Schema.decodeSync(WorkflowId)("coding"),
  trigger: Schema.decodeSync(WorkflowNodeId)(trigger),
  operation: Schema.decodeSync(WorkflowNodeId)("triage"),
  entry: Schema.decodeSync(WorkflowCatalogKey)(entry),
  parameters: [{ id: "label", value: "needs-triage" }],
  workspaces: [workspaceId],
  catchUp: { since: 1_000 },
});

it.effect("reads Linear updates and filters old or marked comments", () =>
  Effect.gen(function* () {
    const client = yield* LinearClient;
    const events = yield* makeLinearTrackerTriggerSource(client, Effect.succeed(registryState))
      .observe([
        subscription("linear.issue-has-label", "label"),
        subscription("linear.new-comment-from-person", "comment"),
      ])
      .pipe(Stream.take(2), Stream.runCollect);

    assert.deepStrictEqual(
      [...events].map(({ revision, cause }) => [revision, cause._tag]),
      [
        ["comment:new", "Person"],
        ["label:needs-triage:3000", "Unknown"],
      ],
    );
  }).pipe(
    Effect.provide(
      Layer.mock(LinearClient, {
        observeIssues: () =>
          Effect.succeed([
            {
              id: "issue-id",
              identifier: "ENG-1",
              title: "Issue",
              url: "https://linear.app/acme/issue/ENG-1",
              labels: ["needs-triage"],
              assignees: ["owner"],
              stateName: "Todo",
              stateType: "unstarted",
              openBlockers: 0,
              priority: "medium",
              updatedAtMillis: 3_000,
              coordinationComments: [],
            },
          ]),
        readProse: () =>
          Effect.succeed({
            body: "Body",
            comments: [
              {
                id: "old",
                authorId: "person",
                authorAssociation: "MEMBER",
                body: "old",
                createdAtMillis: 900,
              },
              {
                id: "new",
                authorId: "person",
                authorAssociation: "MEMBER",
                body: "new",
                createdAtMillis: 2_000,
              },
              {
                id: "marked",
                authorId: "person",
                authorAssociation: "MEMBER",
                body: "cogwork:agent-note",
                createdAtMillis: 1_900,
              },
            ],
          }),
      }),
    ),
  ),
);
