import {
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowOptionList,
  type WorkflowTemplate,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { clockEntries, clockSource } from "./clock-source";
import { granolaWorkflowCatalogContribution } from "./granola-source";

export interface WorkflowCatalogContribution {
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly templates: ReadonlyArray<WorkflowTemplate>;
  readonly listOptions?: (
    entry: WorkflowCatalogKey,
    parameter: string,
    workspaces: ReadonlyArray<WorkspaceId>,
  ) => Effect.Effect<WorkflowOptionList>;
}

export class WorkflowCatalogContributions extends Context.Service<
  WorkflowCatalogContributions,
  ReadonlyArray<WorkflowCatalogContribution>
>()("@cogwork/engine/workflow-catalog/WorkflowCatalogContributions") {}

export const firstPartyInstructionPackages = ["triage-agent", "implement-agent", "follow-up-agent"];

const cogworkAction = (
  key: string,
  name: string,
  agentInputs: ReadonlyArray<string>,
): WorkflowCatalogEntry => ({
  key: Schema.decodeSync(WorkflowCatalogKey)(key),
  name,
  kind: "action",
  system: null,
  connection: null,
  requires: [],
  parameters: [],
  itemKind: null,
  actsOn: ["*"],
  requiresWorkspace: false,
  permissionProfile: "read-only",
  agentInputs,
  emits: [],
});

export const cogworkWorkflowCatalogContribution: WorkflowCatalogContribution = {
  entries: [
    cogworkAction("cogwork.notify", "Notify me", ["notification"]),
    cogworkAction("cogwork.wait-for-approval", "Wait for my approval", ["approval_request"]),
    cogworkAction("cogwork.withdraw-pending-approval", "Withdraw the pending approval", []),
    cogworkAction("cogwork.hand-to-me", "Hand to me", ["hand_off"]),
    cogworkAction("cogwork.stop", "Stop", []),
  ],
  templates: [],
};

export const workflowCatalogContributionsLayer = Layer.succeed(WorkflowCatalogContributions, [
  cogworkWorkflowCatalogContribution,
  granolaWorkflowCatalogContribution,
  {
    entries: clockEntries,
    templates: [],
    listOptions: (entry, parameter, workspaces) =>
      clockSource.listOptions(entry, parameter).pipe(
        Effect.map((options) => options.map((option) => ({ ...option, listedIn: workspaces }))),
        Effect.catchTag("SourceFailure", () => Effect.succeed([])),
      ),
  },
]);
