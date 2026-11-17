import {
  keyOf,
  SourceControlType,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  type WorkItemRef,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { issueTrackerWorkflowCatalogContribution } from "./issue-workflow-catalog";
import type { RegisteredWorkspace } from "./projector";
import { emptyService as emptySourceControl, type PullRequestContext } from "./source-control";
import type { TriggerAdmission } from "./trigger-observation";
import type { TargetContext } from "./workflow-action-entry";
import { actionEntryFor } from "./workflow-action-registry";
import { PullRequestReadiness, WorktreeManager } from "./worktree";

const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const item = Schema.decodeSync(WorkItemId)("#901");
const currentPullRequestActions = [
  "push-to-this-pull-request",
  "comment-on-this-pull-request",
  "request-review",
];
const namedPullRequestActions = ["comment-on-named-pull-request", "post-review", "draft-review"];
const sourceControlActions = ["open-pull-request", ...currentPullRequestActions, ...namedPullRequestActions];

const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  contributions: [],
  repository: "owner/repo",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "repo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
  }),
};
const otherWorkspace = Schema.decodeSync(WorkspaceId)("other");

const issueRef = { _tag: "Issue", workspace: workspace.config.name, id: item } as const;
const pullRequestRef = { _tag: "PullRequest", workspace: workspace.config.name, number: 42 } as const;
const slackRef = { _tag: "SlackMessage", team: "T1", channel: "C1", ts: "1700.01" } as const;

const admissionFor = (ref: WorkItemRef): TriggerAdmission => {
  const entry = decodeEntry("github.issue-changed");
  return {
    event: {
      key: ref,
      revision: "1",
      cause: { _tag: "Unknown" },
      atMillis: 1,
      entry,
      workspace: workspace.config.name,
    },
    subscription: {
      workflow: Schema.decodeSync(WorkflowId)("source-control-writes"),
      trigger: Schema.decodeSync(WorkflowNodeId)("issue-changed"),
      operation: Schema.decodeSync(WorkflowNodeId)("write"),
      entry,
      parameters: [],
      filters: [],
      workspaces: [workspace.config.name],
      catchUp: { since: 0 },
    },
    lineage: {
      root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))(keyOf(ref)),
      parent: null,
      hop: 0,
    },
  };
};

const targetOf = (action: string, ref: WorkItemRef, overrides: Partial<TargetContext> = {}) => {
  const entry = actionEntryFor(`github.${action}`);
  assert.isDefined(entry);
  return entry.target({
    entry: entry.row,
    admission: admissionFor(ref),
    workspaces: [workspace],
    inputs: {},
    parameters: [],
    workspace: workspace.config.name,
    sourceControl: undefined,
    ...overrides,
  });
};

const namedPullRequest: PullRequestContext = {
  number: 826,
  url: "https://github.com/owner/repo/pull/826",
  headBranch: "826-review",
  baseBranch: "main",
  headSha: "read-sha",
  title: "Review",
  description: "",
  diff: "",
  changedFiles: [],
  comments: [],
};

const namedTargetOf = (action: string, snapshots: ReadonlyArray<PullRequestContext>) =>
  targetOf(action, slackRef, {
    inputs: { pull_request: "#826" },
    sourceControl: {
      ...emptySourceControl,
      readPullRequest: () => Effect.succeed({ ...namedPullRequest, headSha: "current-sha" }),
    },
    pullRequestSnapshots: snapshots.map((pullRequest) => ({ workspace: workspace.config.name, pullRequest })),
  });

const frozen = {
  workspace: workspace.config.name,
  app: Schema.decodeSync(SourceControlType)("github"),
  issueTracker: workspace.config.issueTracker,
  repository: "owner/repo",
};

describe("Source control Action entries", () => {
  it("publishes each row in the GitHub tracker catalog", () => {
    const keys = sourceControlActions.map((action) => `github.${action}`);
    const trackerKeys = issueTrackerWorkflowCatalogContribution("github").entries.map(({ key }) => key);
    assert.includeMembers(trackerKeys, keys);
  });

  it.effect("freezes a new pull request for the current Issue only", () =>
    Effect.gen(function* () {
      const worktrees = yield* WorktreeManager;
      assert.deepStrictEqual(
        yield* targetOf("open-pull-request", issueRef, { worktrees, runBranch: "901-run" }),
        {
          _tag: "NewPullRequest",
          ...frozen,
          issue: item,
        },
      );
      const fromPullRequest = yield* Effect.flip(targetOf("open-pull-request", pullRequestRef));
      assert.strictEqual(
        fromPullRequest.message,
        "Open a pull request needs an Issue in the selected Workspace",
      );
      const elsewhere = yield* Effect.flip(
        targetOf("open-pull-request", { ...issueRef, workspace: otherWorkspace }),
      );
      assert.strictEqual(elsewhere.message, "Workspace other does not bind github");
    }).pipe(
      Effect.provide(
        Layer.mock(WorktreeManager, {
          pullRequestReadiness: (_workspace, _item, headBranch = "") =>
            Effect.succeed(PullRequestReadiness.Ready({ headBranch, baseBranch: "main" })),
        }),
      ),
    ),
  );

  it.effect("freezes the current pull request for an Issue and a PullRequest item", () =>
    Effect.gen(function* () {
      for (const action of currentPullRequestActions) {
        for (const ref of [issueRef, pullRequestRef]) {
          assert.deepStrictEqual(yield* targetOf(action, ref), {
            _tag: "CurrentPullRequest",
            ...frozen,
            item: ref,
          });
        }
        const elsewhere = yield* Effect.flip(
          targetOf(action, { ...pullRequestRef, workspace: otherWorkspace }),
        );
        assert.strictEqual(elsewhere.message, "Workspace other does not bind github");
        const slack = yield* Effect.flip(targetOf(action, slackRef));
        assert.strictEqual(
          slack.message,
          "The action cannot target this pull request in the selected Workspace",
        );
      }
    }),
  );

  it.effect("refuses a named pull request that was not read, or whose head moved after the read", () =>
    Effect.gen(function* () {
      for (const action of namedPullRequestActions) {
        const unread = yield* Effect.flip(namedTargetOf(action, []));
        assert.strictEqual(unread._tag, "WorkflowActionPlanDecodeError");
        assert.strictEqual(unread.message, "Read pull request #826 with the pull-request Tool");
        const moved = yield* Effect.flip(namedTargetOf(action, [namedPullRequest]));
        assert.strictEqual(moved._tag, "WorkflowActionPlanDecodeError");
        assert.strictEqual(moved.message, "Pull request #826 received a new commit after it was read");
      }
    }),
  );
});
