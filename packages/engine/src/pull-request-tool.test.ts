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
    id: "cogwork",
    displayName: "cogwork",
    checkoutPath: "/cogwork",
    issueTracker: { type: "github" },
  }),
};

it.effect("reads a named pull request from a selected Workspace", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make<ReadonlyArray<readonly [RegisteredWorkspace, string]>>([]);
    const recorded = yield* Ref.make<ReadonlyArray<readonly [RegisteredWorkspace, number]>>([]);
    const pullRequest = {
      number: 826,
      url: "https://github.com/owner/repo/pull/826",
      headBranch: "review-actions",
      baseBranch: "main",
      headSha: "abc123",
      title: "Add review actions",
      description: "Adds review actions.",
      diff: "diff --git a/src.ts b/src.ts",
      changedFiles: [],
      comments: [],
    };
    const tool = makePullRequestTool(
      {
        ...emptyService,
        readPullRequest: (selected, reference) =>
          Ref.update(reads, (current) => [...current, [selected, reference] as const]).pipe(
            Effect.map(() => pullRequest),
          ),
      },
      [workspace],
      (selected, observed) =>
        Ref.update(recorded, (current) => [...current, [selected, observed.number] as const]),
    );
    const execute = tool.execute;
    if (execute === undefined) throw new Error("pull request tool is missing a server executor");
    const result = yield* Effect.promise(() =>
      Promise.resolve(execute({ workspace: "cogwork", pull_request: "#826" })),
    );

    assert.deepStrictEqual(yield* Ref.get(reads), [[workspace, "#826"]]);
    assert.deepStrictEqual(yield* Ref.get(recorded), [[workspace, 826]]);
    assert.deepStrictEqual(result, { pullRequest });
  }),
);
