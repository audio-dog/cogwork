import {
  BranchName,
  keyOf,
  LineageId,
  WorkflowActionArtifact,
  type WorkItemRef,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { githubSourceControlActionEntries } from "./github/provider";
import { type IssueTrackerService, makeEmpty as makeEmptyIssueTracker } from "./issue-tracker";
import { issueTrackerWorkflowCatalogContribution } from "./issue-workflow-catalog";
import type { RegisteredWorkspace } from "./projector";
import { emptyRegistry } from "./projector";
import { emptyService as emptySourceControl, SourceControlProvider } from "./source-control";
import type { TriggerAdmission } from "./trigger-observation-admission";
import type { WorkflowsService } from "./workflow";
import { cogworkWorkflowCatalogContribution } from "./workflow-catalog";
import {
  decodeWorkItem,
  decodeWorkspace,
  harnessName,
  workflow,
  workflowServiceWith,
} from "./workflow-run-documents-fixtures";
import { requirements, testProgram } from "./workflow-run-fixtures";
import { PullRequestReadiness, WorktreeManager } from "./worktree";

class CodingPipelineProbe extends Context.Service<CodingPipelineProbe, Ref.Ref<ReadonlyArray<string>>>()(
  "@cogwork/engine/workflow-run-coding-template.test/CodingPipelineProbe",
) {
  static readonly layer = Layer.effect(CodingPipelineProbe, Ref.make<ReadonlyArray<string>>([]));
}

const codingSourceControlLayer = Layer.effect(
  SourceControlProvider,
  Effect.map(CodingPipelineProbe, (calls) => ({
    ...emptySourceControl,
    workflowCatalogContribution: { entries: githubSourceControlActionEntries, templates: [] },
    resolvePullRequest: (_workspace, item) => {
      const pullRequest =
        item._tag === "PullRequest"
          ? {
              number: item.number,
              url: `https://example.test/pull/${item.number}`,
              headBranch: `${item.number}-follow-up`,
              baseBranch: "main",
            }
          : null;
      return Effect.succeed(pullRequest);
    },
    openWorkflowPullRequest: (_workspace, input) =>
      Ref.update(calls, (current) => [...current, `open:${input.title}`]).pipe(
        Effect.map(() =>
          WorkflowActionArtifact.make({
            kind: "PullRequestOpened",
            workspace: decodeWorkspace("github"),
            issue: decodeWorkItem("#802"),
            url: "https://example.test/pull/802",
            origin: input.origin,
          }),
        ),
      ),
    recordPullRequestPush: (_workspace, pullRequest, origin) =>
      Ref.update(calls, (current) => [...current, `push:${pullRequest.number}`]).pipe(
        Effect.map(() =>
          WorkflowActionArtifact.make({
            kind: "PullRequestUpdated",
            workspace: decodeWorkspace("github"),
            issue: decodeWorkItem(`#${pullRequest.number}`),
            url: pullRequest.url,
            origin,
          }),
        ),
      ),
  })),
);

const codingWorktreeLayer = Layer.unwrap(
  Effect.map(CodingPipelineProbe, (calls) =>
    Layer.mock(WorktreeManager, {
      ensure: (_workspace, item) =>
        Effect.succeed({
          branch: BranchName.make(`${item.id.slice(1)}-coding-template`),
          path: `/worktrees/${item.id.slice(1)}`,
          created: true,
          operationInProgress: null,
        }),
      pullRequestReadiness: (_workspace, _item, branch) => {
        if (!branch) return Effect.die("Test run has no branch");
        return Effect.succeed(PullRequestReadiness.Ready({ headBranch: branch, baseBranch: "main" }));
      },
      pushBranch: (_workspace, branch) =>
        Ref.update(calls, (current) => [...current, `push-branch:${branch}`]),
      pushBranchIfAhead: (_workspace, branch) =>
        Ref.update(calls, (current) => [...current, `push-if-ahead:${branch}`]).pipe(Effect.map(() => true)),
    }),
  ),
);

describe("WorkflowRun", () => {
  it.effect("runs the GitHub coding template through tracker and source-control seams", () => {
    const workspace = {
      source: "control-store:workspace",
      repository: "owner/repo",
      contributions: [],
      config: Schema.decodeSync(WorkspaceConfig)({
        id: "github",
        displayName: "github",
        checkoutPath: "/repos/github",
        issueTracker: { type: "github" },
      }),
    } satisfies RegisteredWorkspace;
    const contribution = issueTrackerWorkflowCatalogContribution("github");
    const template = contribution.templates.find(({ id }) => id === "github-coding-pipeline");
    if (!template) return Effect.die("GitHub coding template is missing");
    const codingDocument = template.document;
    const catalogEntries = [
      ...cogworkWorkflowCatalogContribution.entries,
      ...contribution.entries,
      ...githubSourceControlActionEntries,
    ];
    const codingService = {
      ...workflowServiceWith(codingDocument),
      catalog: Effect.succeed({
        catalog: {
          entries: catalogEntries,
          instructionPackages: ["triage-agent", "implement-agent", "follow-up-agent"],
          harnesses: [],
        },
        machine: {
          workspaces: [{ id: workspace.config.id, binds: ["github"] }],
          connections: [],
          harnesses: [{ name: harnessName, available: true }],
          defaultHarness: harnessName,
          readyNeeds: [],
        },
      }),
    } satisfies WorkflowsService;
    const admissionFor = (triggerId: string, item: WorkItemRef) => {
      const selected = codingDocument.triggers.find(({ id }) => id === triggerId);
      if (!selected) throw new Error(`Missing coding Trigger ${triggerId}`);
      return {
        event: {
          key: item,
          revision: `${triggerId}:${keyOf(item)}`,
          cause: triggerId === "needs-info-comment" ? { _tag: "Person" } : { _tag: "Unknown" },
          atMillis: 1_000,
          entry: selected.entry,
          workspace: workspace.config.id,
          parameters: selected.parameters,
        },
        subscription: {
          workflow,
          trigger: selected.id,
          operation: selected.start,
          entry: selected.entry,
          parameters: selected.parameters,
          filters: [],
          workspaces: [workspace.config.id],
          catchUp: { since: 0 },
        },
        lineage: {
          root: LineageId.make(`${triggerId}:${keyOf(item)}`),
          parent: null,
          hop: 0,
        },
      } satisfies TriggerAdmission;
    };
    const testLayer = Layer.mergeAll(requirements, codingSourceControlLayer, codingWorktreeLayer).pipe(
      Layer.provideMerge(CodingPipelineProbe.layer),
    );

    return Effect.gen(function* () {
      const calls = yield* CodingPipelineProbe;
      const sourceControl = yield* SourceControlProvider;
      const baseTracker = yield* makeEmptyIssueTracker;
      const tracker = {
        ...baseTracker,
        commentIssue: (_workspace, issue, body) =>
          Ref.update(calls, (current) => [...current, `comment:${issue}:${body}`]),
        addLabels: (_workspace, issue, labels) =>
          Ref.update(calls, (current) => [...current, `labels:${issue}:${labels.join(",")}`]),
        removeLabel: (_workspace, issue, label) =>
          Ref.update(calls, (current) => [...current, `unlabel:${issue}:${label}`]),
      } satisfies IssueTrackerService;
      const registry = { ...emptyRegistry, workspaces: [workspace] };
      const runCodingAdmission = (admission: TriggerAdmission, result: unknown) =>
        testProgram([result], { issueTracker: tracker, registry, sourceControl }, codingService).pipe(
          Effect.tap(({ observationStore }) => observationStore.putAll([admission])),
          Effect.tap(({ runner }) => runner.execute(admission)),
        );
      const issue = (id: string) =>
        ({
          _tag: "Issue",
          workspace: workspace.config.id,
          id: decodeWorkItem(id),
        }) satisfies WorkItemRef;
      const needsInfoProgram = yield* runCodingAdmission(admissionFor("needs-triage", issue("#800")), {
        summary: "More information needed",
        stuck: false,
        answers: { role: "needs-info" },
        inputs: { comment: "Please add the failing logs.", hand_off: "Waiting for logs." },
      });
      yield* runCodingAdmission(admissionFor("needs-info-comment", issue("#801")), {
        summary: "Ready after reporter reply",
        stuck: false,
        answers: { role: "ready-for-agent" },
        inputs: { comment: "Thanks, this is ready.", hand_off: "" },
      });
      yield* runCodingAdmission(admissionFor("ready-for-agent", issue("#802")), {
        summary: "Implementation complete",
        stuck: false,
        answers: {},
        inputs: { pr_title: "Implement retries", pr_body: "Closes #802" },
      });
      yield* runCodingAdmission(
        admissionFor("checks-failed", {
          _tag: "PullRequest",
          workspace: workspace.config.id,
          number: 803,
        }),
        {
          summary: "Fixed failing check",
          stuck: false,
          answers: { reply: "no" },
          inputs: { comment: "" },
        },
      );

      assert.deepStrictEqual(yield* Ref.get(calls), [
        "comment:#800:Please add the failing logs.",
        "labels:#800:needs-info",
        "unlabel:#800:needs-triage",
        "comment:#801:Thanks, this is ready.",
        "labels:#801:ready-for-agent",
        "unlabel:#801:needs-triage",
        "push-branch:802",
        "open:Implement retries",
        "push-if-ahead:803-follow-up",
        "push:803",
      ]);
      assert.strictEqual(
        (yield* Ref.get(needsInfoProgram.coordination.parks)).at(-1)?.reason._tag,
        "HandedToYou",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  });
});
