import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeIssueSearchTool } from "./issue-search-tool";
import { makeEmpty } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

const workspace: RegisteredWorkspace = {
  source: "test",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "cogwork",
    checkoutPath: "/cogwork",
    issueTracker: { type: "github" },
  }),
};

it.effect("searches only the supplied Workspaces without a write surface", () =>
  Effect.gen(function* () {
    const base = yield* makeEmpty;
    const tool = makeIssueSearchTool(
      {
        ...base,
        observe: () =>
          Effect.succeed([
            {
              claimHeld: false,
              claim: null,
              claimedByUs: false,
              attempts: [],
              handback: null,
              id: WorkItemId.make("#813"),
              title: "Fan out Workflow results",
              url: "https://example.test/issues/813",
              roles: [],
              assignees: [],
              openBlockers: 0,
              proposal: null,
              priority: "medium" as const,
              followUp: null,
            },
          ]),
        readProse: () => Effect.succeed({ body: "Create one child per commitment.", comments: [] }),
      },
      [workspace],
    );
    const execute = tool.execute;
    if (execute === undefined) throw new Error("issue search tool is missing a server executor");
    const searched = yield* Effect.promise(() => Promise.resolve(execute({ query: "child commitment" })));

    assert.deepStrictEqual(searched, {
      matches: [
        {
          workspace: "cogwork",
          id: "#813",
          title: "Fan out Workflow results",
          url: "https://example.test/issues/813",
          body: "Create one child per commitment.",
        },
      ],
    });
  }),
);
