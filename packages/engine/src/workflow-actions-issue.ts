import {
  WorkflowActionOrigin,
  type WorkflowActionPlanStep,
  type WorkflowActionTarget,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowWorkspaceSource,
  WorkItemId,
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
  type EngineToolName,
  invalidTarget,
  parameterValues,
  stringInput,
  type TargetContext,
  type TargetProducer,
  targetWorkspaceOf,
  WorkflowActionPlanDecodeError,
} from "./workflow-action-entry";

export const issueTrackerApps = ["github", "linear"] as const;
export type IssueTrackerApp = (typeof issueTrackerApps)[number];

type FrozenIssueTarget = Omit<WorkspaceIssueTrackerBinding, "config"> & {
  readonly app: WorkspaceIssueTrackerBinding["config"]["issueTracker"]["type"];
  readonly config: WorkspaceIssueTrackerBinding["config"];
};

const frozenIssueTarget = Effect.fn("WorkflowActionPlan.frozenIssueTarget")(function* (
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

const targetFields = (target: FrozenIssueTarget) => ({
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

const issueTarget = (context: TargetContext) =>
  frozenIssueTarget(context.entry, context.workspaces, targetWorkspaceOf(context));

const currentIssueTargetProducer: TargetProducer = (context) =>
  issueTarget(context).pipe(Effect.flatMap((target) => currentIssueTarget(context.admission, target)));

const newIssueTargetProducer: TargetProducer = (context) =>
  issueTarget(context).pipe(
    Effect.map(
      (target): WorkflowActionTarget =>
        target === null ? { _tag: "NoWorkspace" } : { _tag: "NewIssue", ...targetFields(target) },
    ),
  );

const existingIssueTarget = Effect.fn("WorkflowActionPlan.existingIssueTarget")(function* (
  issueInput: string,
  target: FrozenIssueTarget | null,
) {
  if (target === null) return { _tag: "NoWorkspace" } as const;
  const prefix = `${target.config.name}:`;
  const hasWorkspacePrefix = issueInput.includes(":");
  if (hasWorkspacePrefix && !issueInput.startsWith(prefix)) {
    return yield* decodeFailure("The issue input does not identify the selected Workspace");
  }
  const rawIssue = issueInput.startsWith(prefix) ? issueInput.slice(prefix.length) : issueInput;
  const issue = yield* Schema.decodeEffect(WorkItemId)(rawIssue).pipe(
    Effect.mapError(() =>
      WorkflowActionPlanDecodeError.make({
        reason: "invalid",
        message: `The issue input is invalid: ${issueInput}`,
      }),
    ),
  );
  return { _tag: "ExistingIssue", ...targetFields(target), issue } as const;
});

const existingIssueTargetProducer: TargetProducer = (context) =>
  issueTarget(context).pipe(
    Effect.flatMap((target) =>
      existingIssueTarget(typeof context.inputs.issue === "string" ? context.inputs.issue : "", target),
    ),
  );

const issueParameter = (id: string, required: boolean) =>
  ({
    id,
    required,
    source: "live",
    values: [],
  }) satisfies WorkflowCatalogEntry["parameters"][number];

const issueActionRow = (
  system: IssueTrackerApp,
  id: string,
  name: string,
  agentInputs: ReadonlyArray<string>,
  parameters: WorkflowCatalogEntry["parameters"] = [],
  actsOn: ReadonlyArray<string> = ["*"],
) =>
  ({
    key: Schema.decodeSync(WorkflowCatalogKey)(`${system}.${id}`),
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
  }) satisfies Omit<WorkflowCatalogEntry, "workspaceSource">;

const targetIssue = (step: WorkflowActionPlanStep) => {
  const target = step.target;
  return target._tag === "CurrentIssue" || target._tag === "ExistingIssue" ? target.issue : null;
};

const requireIssueTarget = (step: WorkflowActionPlanStep) => {
  const issue = targetIssue(step);
  return issue === null ? Effect.fail(invalidTarget(step)) : Effect.succeed(issue);
};

const requireWorkspace = (context: ActionContext) =>
  context.workspace === null ? Effect.fail(invalidTarget(context.step)) : Effect.succeed(context.workspace);

const createIssue = Effect.fn("WorkflowActionPlan.createIssue")(function* (context: ActionContext) {
  const workspace = yield* requireWorkspace(context);
  if (context.step.target._tag !== "NewIssue") return yield* invalidTarget(context.step);
  return yield* context.tracker.createIssue(workspace, {
    title: stringInput(context.step, "issue_title"),
    body: stringInput(context.step, "issue_body"),
    labels: parameterValues(context.step.parameters, "label"),
    origin: WorkflowActionOrigin.make({
      item: context.plan.item,
      workflow: context.plan.workflow,
      attempt: context.plan.attempt,
      writeKey: context.step.writeKey,
      lineage: context.plan.lineage,
    }),
  });
});

const commentIssue = Effect.fn("WorkflowActionPlan.commentIssue")(function* (context: ActionContext) {
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

type IssueActionRow = ReturnType<typeof issueActionRow>;

const issueEntry = (
  row: IssueActionRow,
  target: TargetProducer,
  execute: ActionExecutor,
  workspaceSource: WorkflowWorkspaceSource,
  tools: ReadonlyArray<EngineToolName> = [],
): ActionEntry => ({
  row: { ...row, workspaceSource },
  target,
  execute,
  phase: "write",
  tools,
});

const currentIssueEntry = (row: IssueActionRow, execute: ActionExecutor) =>
  issueEntry(row, currentIssueTargetProducer, execute, "item-else-agent");

const issueEntries = (system: IssueTrackerApp) => [
  issueEntry(
    issueActionRow(
      system,
      "create-issue",
      "Create an issue",
      ["issue_title", "issue_body"],
      [issueParameter("label", false)],
    ),
    newIssueTargetProducer,
    createIssue,
    "agent",
    ["issue-search"],
  ),
  issueEntry(
    issueActionRow(system, "comment-issue", "Comment on an existing issue", ["issue", "comment"]),
    existingIssueTargetProducer,
    commentIssue,
    "agent",
    ["issue-search"],
  ),
  issueEntry(
    issueActionRow(system, "comment-this-item", "Comment on this item", ["comment"], [], ["issue"]),
    currentIssueTargetProducer,
    commentIssue,
    "item-else-agent",
    ["issue-search"],
  ),
  currentIssueEntry(
    issueActionRow(system, "add-label", "Add a label", [], [issueParameter("label", true)], ["issue"]),
    addLabel,
  ),
  currentIssueEntry(
    issueActionRow(system, "remove-label", "Remove a label", [], [issueParameter("label", true)], ["issue"]),
    removeLabel,
  ),
  currentIssueEntry(
    issueActionRow(system, "close-this-issue", "Close this issue", [], [], ["issue"]),
    closeIssue,
  ),
];

export const issueActionEntries = issueTrackerApps.flatMap(issueEntries);
