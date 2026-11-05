import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { LinearClient } from "./client";
import { makeIssueReads } from "./host";

const workspace: WorkspaceIssueTrackerBinding = {
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "linear-workspace",
    checkoutPath: "/repos/linear",
    issueTracker: { type: "linear", teams: ["AUD"] },
  }),
};

const issueId = Schema.decodeSync(WorkItemId)("AUD-7");

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
        ],
      );
    }),
  );
});
