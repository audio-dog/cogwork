import {
  type WorkflowActionPlanStep,
  type WorkflowActionTarget,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace, WorkspaceIssueTrackerBinding } from "./projector";
import type { TriggerAdmission } from "./trigger-observation";
import {
  type ActionContext,
  type ActionEntry,
  type ActionExecutor,
  decodeFailure,
  invalidTarget,
  itemWorkspaceOf,
  parameterValues,
  requireWorkspace,
  stringInput,
  type TargetProducer,
} from "./workflow-action-entry";

const decodeKey = Schema.decodeSync(WorkflowCatalogKey);
const issueTrackerApps = ["github", "linear"] as const;
type IssueTrackerApp = (typeof issueTrackerApps)[number];

export const liveParameter = (id: string, required: boolean) =>
  ({
    id,
    required,
    source: "live",
    values: [],
  }) satisfies WorkflowCatalogEntry["parameters"][number];

export const issueActionRow = (
  system: IssueTrackerApp,
  id: string,
  name: string,
  agentInputs: ReadonlyArray<string>,
  parameters: WorkflowCatalogEntry["parameters"] = [],
  actsOn: ReadonlyArray<string> = ["*"],
) =>
  ({
    key: decodeKey(`${system}.${id}`),
    name,
    kind: "action",
    system,
    connection: system,
    requires: [],
    parameters,
    itemKind: null,
    actsOn,
    requiresWorkspace: true,
    permissionProfile: "read-only",
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

export type FrozenIssueTarget = Omit<WorkspaceIssueTrackerBinding, "config"> & {
  readonly app: WorkspaceIssueTrackerBinding["config"]["issueTracker"]["type"];
  readonly config: WorkspaceIssueTrackerBinding["config"];
};

export const frozenIssueTarget = Effect.fn("WorkflowActionPlan.frozenIssueTarget")(function* (
  entry: WorkflowCatalogEntry,
  selected: ReadonlyArray<RegisteredWorkspace>,
  workspaceId: string | undefined,
) {
  if (workspaceId === "none") return null;
  if (workspaceId === undefined) return yield* decodeFailure(`Action ${entry.key} needs a Workspace`);
  const app = issueTrackerApps.find((candidate) => candidate === entry.system);
  const workspace = selected.find(({ config }) => config.name === workspaceId);
  if (!app || workspace?.config.issueTracker.type !== app) {
    return yield* decodeFailure(`Workspace ${workspaceId} does not bind ${entry.system ?? "the action app"}`);
  }
  return {
    app: workspace.config.issueTracker.type,
    config: { name: workspace.config.name, issueTracker: workspace.config.issueTracker },
    repository: workspace.repository,
  } satisfies FrozenIssueTarget;
});

export const targetFields = (target: FrozenIssueTarget) => ({
  workspace: target.config.name,
  app: target.app,
  issueTracker: target.config.issueTracker,
  repository: target.repository ?? null,
});

const currentIssueTarget = (admission: TriggerAdmission, target: FrozenIssueTarget | null) => {
  if (target === null) return Effect.succeed<WorkflowActionTarget>({ _tag: "NoWorkspace" });
  const ref = admission.event.key;
  if (ref._tag !== "Issue" || ref.workspace !== target.config.name) {
    return decodeFailure("The action cannot target this item in the selected Workspaces");
  }
  return Effect.succeed<WorkflowActionTarget>({
    _tag: "CurrentIssue",
    ...targetFields(target),
    issue: ref.id,
  });
};

const currentIssueTargetProducer: TargetProducer = (context) =>
  frozenIssueTarget(
    context.entry,
    context.workspaces,
    itemWorkspaceOf(context.admission) ?? context.workspace,
  ).pipe(Effect.flatMap((target) => currentIssueTarget(context.admission, target)));

const targetIssue = (step: WorkflowActionPlanStep) => {
  const target = step.target;
  return target._tag === "CurrentIssue" || target._tag === "ExistingIssue" ? target.issue : null;
};

const requireIssueTarget = (step: WorkflowActionPlanStep) => {
  const issue = targetIssue(step);
  return issue === null ? Effect.fail(invalidTarget(step)) : Effect.succeed(issue);
};

export const commentIssue = Effect.fn("WorkflowActionPlan.commentIssue")(function* (context: ActionContext) {
  const workspace = yield* requireWorkspace(context);
  const issue = yield* requireIssueTarget(context.step);
  yield* context.tracker.commentIssue(
    workspace,
    issue,
    stringInput(context.step, "comment"),
    context.step.writeKey,
  );
  return null;
});

const addLabel = Effect.fn("WorkflowActionPlan.addLabel")(function* (context: ActionContext) {
  const workspace = yield* requireWorkspace(context);
  const issue = yield* requireIssueTarget(context.step);
  const labels = parameterValues(context.step.parameters, "label");
  if (labels.length === 0) return yield* invalidTarget(context.step);
  yield* context.tracker.addLabels(workspace, issue, labels);
  return null;
});

const removeLabel = Effect.fn("WorkflowActionPlan.removeLabel")(function* (context: ActionContext) {
  const workspace = yield* requireWorkspace(context);
  const issue = yield* requireIssueTarget(context.step);
  const label = parameterValues(context.step.parameters, "label").at(0);
  if (!label) return yield* invalidTarget(context.step);
  yield* context.tracker.removeLabel(workspace, issue, label);
  return null;
});

const closeIssue = Effect.fn("WorkflowActionPlan.closeIssue")(function* (context: ActionContext) {
  const workspace = yield* requireWorkspace(context);
  const issue = yield* requireIssueTarget(context.step);
  yield* context.tracker.closeIssue(workspace, issue);
  return null;
});

const currentIssueEntry = (
  row: WorkflowCatalogEntry,
  execute: ActionExecutor,
  tools: ActionEntry["tools"] = [],
): ActionEntry => ({
  row,
  target: currentIssueTargetProducer,
  execute,
  phase: "write",
  tools,
});

const currentIssueEntries = (system: IssueTrackerApp) => [
  currentIssueEntry(
    issueActionRow(system, "comment-this-item", "Comment on this item", ["comment"], [], ["issue"]),
    commentIssue,
    ["issue-search"],
  ),
  currentIssueEntry(
    issueActionRow(system, "add-label", "Add a label", [], [liveParameter("label", true)], ["issue"]),
    addLabel,
  ),
  currentIssueEntry(
    issueActionRow(system, "remove-label", "Remove a label", [], [liveParameter("label", true)], ["issue"]),
    removeLabel,
  ),
  currentIssueEntry(
    issueActionRow(system, "close-this-issue", "Close this issue", [], [], ["issue"]),
    closeIssue,
  ),
];

export const issueActionEntries = issueTrackerApps.flatMap(currentIssueEntries);
