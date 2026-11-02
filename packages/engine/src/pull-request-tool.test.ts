import { WorkspaceConfig } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "./projector";
import { makePullRequestTool } from "./pull-request-tool";
import { emptyService } from "./source-control";

const workspace: RegisteredWorkspace = {
  source: "test",
  repository: "owner/repo",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "cogwork",
    checkoutPath: "/cogwork",
    issueTracker: { type: "github" },
  }),
};

it.effect("reads a named pull request from a selected Workspace", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const tool = makePullRequestTool(
      {
        ...emptyService,
        readPullRequest: () =>
          Ref.update(reads, (count) => count + 1).pipe(
            Effect.map(() => ({
              number: 826,
              url: "https://github.com/owner/repo/pull/826",
              headBranch: "review-actions",
              baseBranch: "main",
              headSha: "abc123",
              title: "Add review actions",
              description: "Adds review actions.",
              diff: "diff --git a/src.ts b/src.ts",
              changedFiles: [
                {
                  path: "src.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 0,
                  changes: 1,
                  patch: "@@ -1 +1 @@\n-old\n+new",
                },
              ],
              comments: [{ author: "reviewer", body: "Please check this.", path: null, line: null }],
            })),
          ),
      },
      [workspace],
    );
    const execute = tool.execute;
    if (execute === undefined) throw new Error("pull request tool is missing a server executor");
    const result = yield* Effect.promise(() =>
      Promise.resolve(execute({ workspace: "cogwork", pull_request: "#826" })),
    );

    assert.strictEqual(yield* Ref.get(reads), 1);
    assert.deepStrictEqual(result, {
      pullRequest: {
        number: 826,
        url: "https://github.com/owner/repo/pull/826",
        headBranch: "review-actions",
        baseBranch: "main",
        headSha: "abc123",
        title: "Add review actions",
        description: "Adds review actions.",
        diff: "diff --git a/src.ts b/src.ts",
        changedFiles: [
          {
            path: "src.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
        comments: [{ author: "reviewer", body: "Please check this.", path: null, line: null }],
      },
    });
  }),
);
