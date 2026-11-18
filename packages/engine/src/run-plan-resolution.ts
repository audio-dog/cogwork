import {
  type Claim,
  defaultPriority,
  type HandbackRecord,
  type HarnessName,
  keyOf,
  type RunId,
  RunPlan,
  type RunPlanMember,
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
import { type EngineToolName, itemWorkspaceOf } from "./workflow-action-entry";

export interface RunPlanFacts {
  readonly id: RunId;
  readonly admission: TriggerAdmission;
  readonly workflow: Pick<WorkflowRecord, "id" | "publishedRevision">;
  readonly operation: WorkflowOperation;
  readonly catalog: WorkflowCatalog;
  readonly outputWorkspaces: ReadonlyArray<WorkspaceId>;
  readonly harness: {
    readonly name: HarnessName;
    readonly projectedMembers: ReadonlyArray<RunPlanMember>;
    readonly middleware: ReadonlyArray<RunPlanMiddlewareName>;
    readonly sessionKind: SessionKind;
  };
  readonly workspaceCheckout: string | null;
  readonly instructions: AssembledContext;
  readonly previousResultIssues: string | null;
  readonly lineageArtifacts: ReadonlyArray<Pick<WorkflowActionArtifact, "workspace" | "issue" | "url">>;
  readonly claim: Claim;
  readonly handback: HandbackRecord | null;
  readonly toolNeeds: ReadonlySet<EngineToolName>;
  readonly skills: RunPlan["skills"];
  readonly subagents: RunPlan["subagents"];
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

const engineToolOrder: ReadonlyArray<EngineToolName> = ["issue-search", "pull-request"];

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

const memberDisposition = (projectedMembers: ReadonlyArray<RunPlanMember>, member: "Tools" | "Skills") =>
  projectedMembers.includes(member)
    ? { member, disposition: "projected" as const }
    : {
        member,
        disposition: "not-projected" as const,
        reason: `selected harness does not project ${member}`,
      };

export const harnessOptions = (operation: WorkflowOperation) =>
  Object.fromEntries(operation.model.options.map(({ id, value }) => [id, value]));

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
  const prose = admission.event.workContext ?? { body: admissionBody(admission, workflow.id), comments: [] };
  if (lineageArtifacts.length === 0) return prose;
  const artifacts = encodeArtifactContext(
    lineageArtifacts.map(({ workspace, issue, url }) => ({ workspace, issue, url })),
  );
  return { ...prose, body: [prose.body, "", "## Artifacts this lineage created", artifacts].join("\n") };
};

const operationMessage = (operation: WorkflowOperation, handback: HandbackRecord | null) => {
  const request = `Run Workflow Operation: ${operation.name}`;
  const note = handback?.note?.trim();
  return note ? `${request}\n\nPerson's note: ${note}` : request;
};

export const resolveRunPlan = (facts: RunPlanFacts) => {
  const { admission, operation, harness, instructions } = facts;
  const observation = {
    generation: facts.workflow.publishedRevision ?? 0,
    observedAtMillis: admission.event.atMillis,
  };
  return RunPlan.make({
    id: facts.id,
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
        ...(facts.previousResultIssues === null
          ? []
          : [{ source: "previous-result-issues", content: facts.previousResultIssues }]),
      ],
    },
    messages: [{ role: "user", content: operationMessage(operation, facts.handback) }],
    tools: harness.projectedMembers.includes("Tools")
      ? engineToolOrder.filter((tool) => facts.toolNeeds.has(tool))
      : [],
    skills: facts.skills,
    mcp: [],
    subagents: facts.subagents,
    hooks: [],
    middleware: [...harness.middleware],
    structuredOutput: workflowOperationResultJsonSchema(
      operation,
      facts.catalog,
      facts.outputWorkspaces,
      itemWorkspaceOf(admission),
    ),
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
      projection: [
        ...projection,
        memberDisposition(harness.projectedMembers, "Tools"),
        memberDisposition(harness.projectedMembers, "Skills"),
      ],
      observation,
    },
  });
};
