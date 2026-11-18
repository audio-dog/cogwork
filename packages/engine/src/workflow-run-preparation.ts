import {
  BranchName,
  PluginContributionLoad,
  WorkItemId,
  WorkItemRef,
  type workflowOperationResultSchema,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { makeIssueSearchTool } from "./issue-search-tool";
import { IssueTracker, IssueTrackerError } from "./issue-tracker";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";
import { makePullRequestTool } from "./pull-request-tool";
import { type PullRequestContext, SourceControlProvider } from "./source-control";
import type { TriggerAdmission } from "./trigger-observation";
import type { buildWorkflowActionPlan } from "./workflow-action-plan";
import { actionEntryFor } from "./workflow-action-registry";
import { ticketSlug, WorktreeManager } from "./worktree";

const workItemId = Schema.decodeSync(WorkItemId);

export const engineToolsFor = (
  operation: Parameters<typeof workflowOperationResultSchema>[0],
  catalog: Parameters<typeof workflowOperationResultSchema>[1],
) => {
  const actionKeys = new Set(catalog.entries.filter(({ kind }) => kind === "action").map(({ key }) => key));
  return new Set(
    operation.transitions
      .flatMap(({ actions }) => actions)
      .filter(({ entry }) => actionKeys.has(entry))
      .flatMap(({ entry }) => actionEntryFor(entry)?.tools ?? []),
  );
};

export const selectedWorkspaceIds = (
  document: Parameters<typeof buildWorkflowActionPlan>[0]["document"],
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) => {
  const registered = workspaces.map(({ config }) => config.name);
  return document.workspaces._tag === "Every"
    ? registered
    : document.workspaces.workspaces.filter((workspace) => registered.includes(workspace));
};

const fallbackBranch = WorkItemRef.match({
  Issue: ({ id }) => ticketSlug(id),
  PullRequest: () => "pull-request",
  GranolaNote: () => "workflow",
  SlackMessage: () => "workflow",
  SlackConversation: () => "workflow",
  ScheduleInstant: () => "workflow",
  FanOutChild: () => "workflow",
});

const runItemId = WorkItemRef.match({
  Issue: ({ id }) => id,
  PullRequest: ({ number }) => workItemId(`#${number}`),
  GranolaNote: () => workItemId("#workflow"),
  SlackMessage: () => workItemId("#workflow"),
  SlackConversation: () => workItemId("#workflow"),
  ScheduleInstant: () => workItemId("#workflow"),
  FanOutChild: () => workItemId("#workflow"),
});

export const makeWorkflowRunPreparation = Effect.fn("WorkflowRun.makePreparation")(function* () {
  const plugins = yield* PluginManager;
  const issueTracker = yield* IssueTracker;
  const fs = yield* FileSystem.FileSystem;
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
  const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));

  const admittedSkills = Effect.fn("WorkflowRun.admittedSkills")(function* (
    workspace: RegisteredWorkspace | null,
    required: ReadonlyArray<string>,
  ) {
    if (workspace === null) return [];
    const fromPlugins = yield* plugins.contributions(workspace.config.name).pipe(
      Effect.map((contributions) =>
        contributions.filter(({ load }) => PluginContributionLoad.guards.Loaded(load)),
      ),
      Effect.orElseSucceed(() => []),
    );
    const available = [...workspace.contributions, ...fromPlugins].filter(({ kind }) => kind === "skill");
    const contributions = [
      ...available.filter(({ id }) => required.includes(id)),
      ...available.filter(({ id }) => !required.includes(id)),
    ];
    return contributions
      .filter(
        (skill, index) => contributions.findIndex(({ localName }) => localName === skill.localName) === index,
      )
      .map(({ id, localName, file }) => ({ identity: id, name: localName, source: file }));
  });

  const prepareCheckout = Effect.fn("WorkflowRun.prepareCheckout")(function* (
    admission: TriggerAdmission,
    workspace: RegisteredWorkspace | null,
    permissionProfile: "read-only" | "full",
    resume: boolean,
  ) {
    if (workspace === null) {
      const path = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workflow-" });
      return { path, branch: null, operationInProgress: null } as const;
    }
    if (permissionProfile === "read-only") {
      return { path: workspace.config.checkoutPath, branch: null, operationInProgress: null } as const;
    }
    const pullRequest =
      sourceControl === null ? null : yield* sourceControl.resolvePullRequest(workspace, admission.event.key);
    const branch = BranchName.make(pullRequest?.headBranch ?? fallbackBranch(admission.event.key));
    const item = { id: runItemId(admission.event.key), title: "" };
    if (worktrees === null) {
      return yield* new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "Worktree manager is not configured",
      });
    }
    const checkout = yield* worktrees.ensure(workspace, item, {
      branch,
      pushOwner: "engine",
      resume,
    });
    return { path: checkout.path, branch, operationInProgress: checkout.operationInProgress } as const;
  });

  const runTools = Effect.fn("WorkflowRun.runTools")(function* (
    actionTools: ReturnType<typeof engineToolsFor>,
    toolWorkspaces: ReadonlyArray<RegisteredWorkspace>,
  ) {
    const pullRequestSnapshots = yield* Ref.make<
      ReadonlyArray<{ readonly workspace: string; readonly pullRequest: PullRequestContext }>
    >([]);
    const engineTools = [
      ...(actionTools.has("issue-search") ? [makeIssueSearchTool(issueTracker, toolWorkspaces)] : []),
      ...(actionTools.has("pull-request") && sourceControl
        ? [
            makePullRequestTool(sourceControl, toolWorkspaces, (selected, pullRequest) =>
              Ref.update(pullRequestSnapshots, (snapshots) => [
                ...snapshots,
                { workspace: selected.config.name, pullRequest },
              ]),
            ),
          ]
        : []),
    ];
    return { engineTools, pullRequestSnapshots };
  });

  return { admittedSkills, prepareCheckout, runTools };
});
