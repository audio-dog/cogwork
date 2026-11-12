import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { LinearClient } from "./client";
import { makeIssueReads } from "./host";
import { wireCodec } from "./markers";

const workspace: WorkspaceIssueTrackerBinding = {
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "linear-workspace",
    checkoutPath: "/repos/linear",
    issueTracker: { type: "linear", teams: ["AUD"] },
  }),
};

const issueId = Schema.decodeSync(WorkItemId)("AUD-7");
const completedIssueId = Schema.decodeSync(WorkItemId)("AUD-8");

describe("Linear trigger prose", () => {
  it.effect("marks a comment with no steering association as not a person's", () =>
    Effect.gen(function* () {
      const client = yield* LinearClient.pipe(
        Effect.provide(
          Layer.mock(LinearClient, {
            readTriggerProse: () =>
              Effect.succeed({
                body: "",
                comments: [
                  { id: "a", authorId: "owner", authorAssociation: "OWNER", body: "", createdAtMillis: 1 },
                  { id: "b", authorId: "member", authorAssociation: "MEMBER", body: "", createdAtMillis: 2 },
                  { id: "c", authorId: "guest", authorAssociation: "NONE", body: "", createdAtMillis: 3 },
                  {
                    id: "d",
                    authorId: "member",
                    authorAssociation: "MEMBER",
                    body: wireCodec.encode({ name: "agent-note", pairs: "" }),
                    createdAtMillis: 4,
                  },
                ],
              }),
          }),
        ),
      );

      const prose = yield* makeIssueReads(client).readTriggerProse(workspace, issueId);

      assert.deepStrictEqual(
        prose.comments.map(({ author, authoredByPerson }) => ({ author, authoredByPerson })),
        [
          { author: "owner", authoredByPerson: true },
          { author: "member", authoredByPerson: true },
          { author: "guest", authoredByPerson: false },
          { author: "member", authoredByPerson: false },
        ],
      );
    }),
  );
});

describe("Linear issue listing", () => {
  it.effect("lists completed issues since a cursor, and open ones when observing or by label", () =>
    Effect.gen(function* () {
      const issue = (identifier: string, stateType: string) => ({
        id: identifier,
        identifier,
        title: identifier,
        url: `https://linear.app/acme/issue/${identifier}`,
        labels: [],
        assignees: [],
        stateName: stateType,
        stateType,
        openBlockers: 0,
        priority: "medium" as const,
        updatedAtMillis: 1,
        coordinationComments: [],
      });
      const client = yield* LinearClient.pipe(
        Effect.provide(
          Layer.mock(LinearClient, {
            observeIssues: (_ref, _coordination, _assignees, _updatedSince, includeCompleted) =>
              Effect.succeed(
                includeCompleted
                  ? [issue("AUD-7", "started"), issue("AUD-8", "completed")]
                  : [issue("AUD-7", "started")],
              ),
            observeLabelledIssues: (_ref, label) =>
              Effect.succeed([{ ...issue("AUD-7", "started"), labels: [label] }]),
          }),
        ),
      );
      const reads = makeIssueReads(client);

      const observed = yield* reads.observe(workspace);
      const changed = yield* reads.itemsChangedSince(workspace, 1);
      const labelled = yield* reads.openItemsWithLabel(workspace, "needs-triage");

      assert.deepStrictEqual(
        observed.map(({ id }) => id),
        [issueId],
      );
      assert.deepStrictEqual(
        changed.map(({ id, open }) => [id, open]),
        [
          [issueId, true],
          [completedIssueId, false],
        ],
      );
      assert.deepStrictEqual(
        labelled.map(({ id, labels }) => [id, labels]),
        [[issueId, ["needs-triage"]]],
      );
    }),
  );
});
