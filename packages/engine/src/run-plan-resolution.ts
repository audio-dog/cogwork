import {
  type Claim,
  defaultPriority,
  type HandbackRecord,
  type HarnessName,
  keyOf,
  type MachineReadiness,
  type RunId,
  RunPlan,
  type RunPlanMiddlewareName,
  type SessionKind,
  type WorkflowActionArtifact,
  type WorkflowCatalog,
  type WorkflowOperation,
  type WorkflowRecord,
  WorkItemId,
  WorkspaceId,
  workflowOperationResultJsonSchema,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import type { AssembledContext } from "./context-assembler";
import type { TriggerAdmission } from "./trigger-observation";

export interface RunPlanFacts {
  readonly id: RunId;
  readonly admission: TriggerAdmission;
  readonly workflow: Pick<WorkflowRecord, "id" | "publishedRevision">;
  readonly operation: WorkflowOperation;
  readonly catalog: WorkflowCatalog;
  readonly harness: {
    readonly name: HarnessName;
    readonly middleware: ReadonlyArray<RunPlanMiddlewareName>;
    readonly sessionKind: SessionKind;
  };
  readonly outputWorkspaces: ReadonlyArray<WorkspaceId>;
  readonly workspaceCheckout: string | null;
  readonly instructions: AssembledContext;
  readonly priorIssues: string | null;
  readonly claim: Claim;
  readonly handback: HandbackRecord | null;
  readonly lineageArtifacts: ReadonlyArray<WorkflowActionArtifact>;
}

const workItemId = Schema.decodeSync(WorkItemId);
const encodeArtifactContext = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        workspace: WorkspaceId,
        issue: WorkItemId,
        url: Schema.String,
      }),
    ),
  ),
);

const toolActionNames = [
  { tool: "issue-search", actions: new Set(["create-issue", "comment-issue", "comment-this-item"]) },
  {
    tool: "pull-request",
    actions: new Set(["comment-on-named-pull-request", "post-review", "draft-review"]),
  },
] as const;

const projection = [
  "Harness Adapter",
  "Instructions",
  "Messages",
  "Work Context",
  "Middleware",
  "Sandbox",
  "Structured Output",
  "Persistence",
  "Provenance",
].map((member) => ({ member, disposition: "projected" as const }));

export const selectRunHarness = (operation: WorkflowOperation, machine: MachineReadiness) => {
  const harness = operation.model.harness ?? machine.defaultHarness;
  const hasMissingNeed = operation.requires.some((need) => !machine.readyNeeds.includes(need));
  return hasMissingNeed ? null : harness;
};

export const harnessOptions = (operation: WorkflowOperation) =>
  Object.fromEntries(operation.model.options.map(({ id, value }) => [id, value]));

const operationActionNames = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const actionKeys = new Set(catalog.entries.filter(({ kind }) => kind === "action").map(({ key }) => key));
  return operation.transitions
    .flatMap(({ actions }) => actions)
    .filter(({ entry }) => actionKeys.has(entry))
    .map(({ entry }) => entry.slice(entry.indexOf(".") + 1));
};

const runTools = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const names = operationActionNames(operation, catalog);
  return toolActionNames
    .filter(({ actions }) => names.some((name) => actions.has(name)))
    .map(({ tool }) => tool);
};

const admissionBody = (admission: TriggerAdmission, workflow: string) => {
  const payload = admission.event.payload;
  if (payload?._tag !== "GranolaNote") {
    return `Scheduled instant ${admission.event.revision} for Workflow ${workflow}.`;
  }
  return [
    `# ${payload.title}`,
    "",
    "## Attendees",
    payload.attendees.join("\n"),
    "",
    "## Calendar event",
    payload.calendarEvent,
    "",
    "## Summary",
    payload.summary,
    "",
    "## Transcript",
    payload.transcript,
  ].join("\n");
};

const workContextProse = ({ admission, workflow, lineageArtifacts }: RunPlanFacts) => {
  const prose = admission.event.workContext ?? {
    body: admissionBody(admission, workflow.id),
    comments: [],
  };
  if (lineageArtifacts.length === 0) return prose;
  return {
    ...prose,
    body: [
      prose.body,
      "",
      "## Artifacts this lineage created",
      encodeArtifactContext(lineageArtifacts.map(({ workspace, issue, url }) => ({ workspace, issue, url }))),
    ].join("\n"),
  };
};

const operationMessage = (operation: WorkflowOperation, handback: HandbackRecord | null) => {
  const note = handback?.note?.trim();
  return note
    ? `Run Workflow Operation: ${operation.name}\n\nPerson's note: ${note}`
    : `Run Workflow Operation: ${operation.name}`;
};

export const resolveRunPlan = (facts: RunPlanFacts) => {
  const { id, admission, operation, harness, instructions, priorIssues } = facts;
  const observation = {
    generation: facts.workflow.publishedRevision ?? 0,
    observedAtMillis: admission.event.atMillis,
  };
  return RunPlan.make({
    id,
    operation: operation.id,
    harness: {
      name: harness.name,
      model: operation.model.model,
      options: harnessOptions(operation),
      profile: operation.permissionProfile,
    },
    instructions: instructions.layers,
    operatingInstructions: {
      name: instructions.operatingInstructionsName,
      path: instructions.operatingInstructionsPath,
      resources: [
        ...instructions.operatingInstructionResources,
        ...(priorIssues === null ? [] : [{ source: "previous-result-issues", content: priorIssues }]),
      ],
    },
    messages: [{ role: "user", content: operationMessage(operation, facts.handback) }],
    tools: runTools(operation, facts.catalog),
    skills: [],
    mcp: [],
    subagents: [],
    commands: [],
    hooks: [],
    middleware: [...harness.middleware],
    structuredOutput: workflowOperationResultJsonSchema(operation, facts.catalog, facts.outputWorkspaces)[
      "~standard"
    ].jsonSchema.input({ target: "draft-2020-12" }),
    connections: [],
    workContext: {
      reference: {
        workItem: workItemId(keyOf(admission.event.key)),
        url: admission.event.subject?.url ?? null,
      },
      facts: {
        assignees: [],
        openBlockers: 0,
        claim: facts.claim,
        priority: admission.event.priority ?? defaultPriority,
      },
      prose: workContextProse(facts),
      observation,
    },
    sandbox: { workspace: facts.workspaceCheckout, policy: operation.permissionProfile },
    persistence: { sessionKind: harness.sessionKind },
    provenance: {
      resolution: [],
      stamps: [],
      projectedNames: [],
      projection,
      observation,
    },
  });
};
