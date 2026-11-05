import {
  type Claim,
  defaultPriority,
  type HarnessName,
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
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "./projector";
import type { PreflightFacts, PreparedRun } from "./run-preparation";
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

interface ToolNeeds {
  readonly issueSearch: boolean;
  readonly pullRequest: boolean;
}

interface RunPlanFacts {
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

const rejections: ReadonlyArray<(facts: PreflightFacts) => RunPlanRejection | undefined> = [
  ({ missingNeeds }) =>
    missingNeeds.length === 0 ? undefined : RunPlanRejection.MissingNeed({ needs: missingNeeds }),
  ({ preflightFailure }) =>
    preflightFailure === null ? undefined : RunPlanRejection.PreflightFailed({ message: preflightFailure }),
];

export const resolvePreflight = (facts: PreflightFacts): Result.Result<HarnessName, RunPlanRejection> => {
  if (facts.harness === null) return Result.fail(RunPlanRejection.NoHarness());
  const rejection = rejections
    .map((rejectionOf) => rejectionOf(facts))
    .find((reason) => reason !== undefined);
  return rejection === undefined ? Result.succeed(facts.harness) : Result.fail(rejection);
};

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

const workContextProse = (facts: RunPlanFacts) => {
  const baseProse = facts.admission.event.workContext ?? {
    body: workContextBody(facts.admission, facts.workflow.id),
    comments: [],
  };
  if (facts.prepared.lineageArtifacts.length === 0) return baseProse;
  return {
    ...baseProse,
    body: [
      baseProse.body,
      "",
      "## Artifacts this lineage created",
      encodeArtifactContext(
        facts.prepared.lineageArtifacts.map(({ workspace, issue, url }) => ({ workspace, issue, url })),
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

const acceptedPlan = (facts: RunPlanFacts, toolNeeds: ToolNeeds) => {
  const { admission, operation, priorIssues } = facts;
  const { prepared } = facts;
  const { instructions, handbackNote } = prepared;
  const observation = {
    generation: facts.workflow.publishedRevision ?? 0,
    observedAtMillis: admission.event.atMillis,
  };
  return RunPlan.make({
    id: facts.id,
    operation: operation.id,
    harness: {
      name: prepared.harness,
      model: operation.model.model,
      options: prepared.options,
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
    middleware: [...prepared.middleware],
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
    sandbox: {
      workspace: facts.workspace === null ? null : prepared.checkout.path,
      policy: operation.permissionProfile,
    },
    persistence: { sessionKind: prepared.sessionKind },
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
  const toolNeeds = {
    issueSearch: needsActionTool(facts.operation, facts.catalog, issueSearchActionNames),
    pullRequest: needsActionTool(facts.operation, facts.catalog, namedPullRequestActionNames),
  };
  return { plan: acceptedPlan(facts, toolNeeds), toolNeeds };
};
