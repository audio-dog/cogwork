import { type WorkflowCatalogEntry, WorkflowCatalogKey, type WorkflowTemplate } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface WorkflowCatalogContribution {
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly templates: ReadonlyArray<WorkflowTemplate>;
}

export class WorkflowCatalogContributions extends Context.Service<
  WorkflowCatalogContributions,
  ReadonlyArray<WorkflowCatalogContribution>
>()("@cogwork/engine/workflow-catalog/WorkflowCatalogContributions") {}

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
]);
