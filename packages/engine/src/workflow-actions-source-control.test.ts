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
import * as Schema from "effect/Schema";
import { githubSourceControlActionEntries } from "./github/provider";
import { issueTrackerWorkflowCatalogContribution } from "./issue-workflow-catalog";
import type { RegisteredWorkspace } from "./projector";
import type { TriggerAdmission } from "./trigger-observation";
import { actionEntryFor } from "./workflow-action-registry";

const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const item = Schema.decodeSync(WorkItemId)("#901");
const currentPullRequestActions = [
  "push-to-this-pull-request",
  "comment-on-this-pull-request",
  "request-review",
];
const sourceControlActions = ["open-pull-request", ...currentPullRequestActions];

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

const targetOf = (action: string, ref: WorkItemRef) => {
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
  });
};

const frozen = {
  workspace: workspace.config.name,
  app: Schema.decodeSync(SourceControlType)("github"),
  issueTracker: workspace.config.issueTracker,
  repository: "owner/repo",
};

describe("Source control Action entries", () => {
  it("publishes each row once, from the GitHub tracker catalog", () => {
    const keys = sourceControlActions.map((action) => `github.${action}`);
    const trackerKeys = issueTrackerWorkflowCatalogContribution("github").entries.map(({ key }) => key);
    const providerKeys = githubSourceControlActionEntries.map(({ key }) => key);
    assert.includeMembers(trackerKeys, keys);
    assert.notIncludeMembers(providerKeys, keys);
  });

  it.effect("freezes a new pull request for the current Issue only", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* targetOf("open-pull-request", issueRef), {
        _tag: "NewPullRequest",
        ...frozen,
        issue: item,
      });
      const fromPullRequest = yield* Effect.flip(targetOf("open-pull-request", pullRequestRef));
      assert.strictEqual(
        fromPullRequest.message,
        "Open a pull request needs an Issue in the selected Workspace",
      );
      const elsewhere = yield* Effect.flip(
        targetOf("open-pull-request", { ...issueRef, workspace: otherWorkspace }),
      );
      assert.strictEqual(elsewhere.message, "Workspace other does not bind github");
    }),
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
});
