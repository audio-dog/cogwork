import {
  type Claim,
  defaultPriority,
  keyOf,
  type NeedIdentity,
  type RunId,
  RunPlan,
  type WorkflowCatalog,
  type WorkflowOperation,
  type WorkflowRecord,
  WorkItemId,
  WorkspaceId,
  workflowOperationResultJsonSchema,
} from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "./projector";
import type { PreparedRun, ProvisionedRun, RunReadiness } from "./run-preparation";
import type { TriggerAdmission } from "./trigger-observation";

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
const issueSearchActionNames = new Set(["create-issue", "comment-issue", "comment-this-item"]);
const namedPullRequestActionNames = new Set(["comment-on-named-pull-request", "post-review", "draft-review"]);

export type RunPlanRejection = Data.TaggedEnum<{
  NoHarness: Record<never, never>;
  MissingNeed: { readonly needs: ReadonlyArray<NeedIdentity> };
  PreflightFailed: { readonly message: string };
}>;
export const RunPlanRejection = Data.taggedEnum<RunPlanRejection>();

export interface ToolNeeds {
  readonly issueSearch: boolean;
  readonly pullRequest: boolean;
}

export type RunPlanResolution = Data.TaggedEnum<{
  Accepted: { readonly plan: RunPlan; readonly toolNeeds: ToolNeeds; readonly provisioned: ProvisionedRun };
  Rejected: { readonly reason: RunPlanRejection };
}>;
export const RunPlanResolution = Data.taggedEnum<RunPlanResolution>();

export interface RunPlanFacts {
  readonly id: RunId;
  readonly admission: TriggerAdmission;
  readonly workflow: Pick<WorkflowRecord, "id" | "publishedRevision">;
  readonly operation: WorkflowOperation;
  readonly workspace: RegisteredWorkspace | null;
  readonly catalog: WorkflowCatalog;
  readonly outputWorkspaces: ReadonlyArray<WorkspaceId>;
  readonly claim: Claim;
  readonly priorIssues: string | null;
  readonly prepared: PreparedRun;
}

const needsActionTool = (
  operation: WorkflowOperation,
  catalog: WorkflowCatalog,
  names: ReadonlySet<string>,
) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return operation.transitions
    .flatMap(({ actions }) => actions)
    .some(({ entry }) => {
      const catalogEntry = entries.get(entry);
      return catalogEntry?.kind === "action" && names.has(entry.slice(entry.indexOf(".") + 1));
    });
};

const rejections: ReadonlyArray<{
  readonly applies: (readiness: RunReadiness) => boolean;
  readonly reason: (readiness: RunReadiness) => RunPlanRejection;
}> = [
  { applies: ({ harness }) => harness === null, reason: () => RunPlanRejection.NoHarness() },
  {
    applies: ({ missingNeeds }) => missingNeeds.length > 0,
    reason: ({ missingNeeds }) => RunPlanRejection.MissingNeed({ needs: missingNeeds }),
  },
];

const preflightRejection = ({ preflightFailure }: RunReadiness) =>
  RunPlanRejection.PreflightFailed({ message: preflightFailure ?? "Harness preflight failed" });

const rejectionOf = (readiness: RunReadiness) =>
  (rejections.find(({ applies }) => applies(readiness))?.reason ?? preflightRejection)(readiness);

const workContextBody = (admission: TriggerAdmission, workflow: string) => {
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

const workContextProse = (facts: RunPlanFacts, provisioned: ProvisionedRun) => {
  const baseProse = facts.admission.event.workContext ?? {
    body: workContextBody(facts.admission, facts.workflow.id),
    comments: [],
  };
  if (provisioned.lineageArtifacts.length === 0) return baseProse;
  return {
    ...baseProse,
    body: [
      baseProse.body,
      "",
      "## Artifacts this lineage created",
      encodeArtifactContext(
        provisioned.lineageArtifacts.map(({ workspace, issue, url }) => ({ workspace, issue, url })),
      ),
    ].join("\n"),
  };
};

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

const acceptedPlan = (facts: RunPlanFacts, provisioned: ProvisionedRun, toolNeeds: ToolNeeds) => {
  const { admission, operation, priorIssues } = facts;
  const { instructions, handbackNote } = provisioned;
  const observation = {
    generation: facts.workflow.publishedRevision ?? 0,
    observedAtMillis: admission.event.atMillis,
  };
  return RunPlan.make({
    id: facts.id,
    operation: operation.id,
    harness: {
      name: provisioned.harness,
      model: operation.model.model,
      options: provisioned.options,
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
    messages: [
      {
        role: "user",
        content: handbackNote
          ? `Run Workflow Operation: ${operation.name}\n\nPerson's note: ${handbackNote}`
          : `Run Workflow Operation: ${operation.name}`,
      },
    ],
    tools: [
      ...(toolNeeds.issueSearch ? ["issue-search" as const] : []),
      ...(toolNeeds.pullRequest ? ["pull-request" as const] : []),
    ],
    skills: [],
    mcp: [],
    subagents: [],
    commands: [],
    hooks: [],
    middleware: [...provisioned.middleware],
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
      prose: workContextProse(facts, provisioned),
      observation,
    },
    sandbox: {
      workspace: facts.workspace === null ? null : provisioned.checkout.path,
      policy: operation.permissionProfile,
    },
    persistence: { sessionKind: provisioned.sessionKind },
    provenance: {
      resolution: [],
      stamps: [],
      projectedNames: [],
      projection,
      observation,
    },
  });
};

export const resolveRunPlan = (facts: RunPlanFacts) => {
  if (facts.prepared._tag === "Unready") {
    return RunPlanResolution.Rejected({ reason: rejectionOf(facts.prepared.readiness) });
  }
  const provisioned = facts.prepared.provisioned;
  const toolNeeds = {
    issueSearch: needsActionTool(facts.operation, facts.catalog, issueSearchActionNames),
    pullRequest: needsActionTool(facts.operation, facts.catalog, namedPullRequestActionNames),
  };
  return RunPlanResolution.Accepted({
    plan: acceptedPlan(facts, provisioned, toolNeeds),
    toolNeeds,
    provisioned,
  });
};
