import { WorkflowCatalog } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

const cogworkAction = (key: string, name: string, agentInputs: ReadonlyArray<string>) =>
  ({
    key,
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
  }) as const;

export const workflowCatalog = Schema.decodeSync(WorkflowCatalog)({
  entries: [
    cogworkAction("cogwork.notify", "Notify me", ["notification"]),
    cogworkAction("cogwork.wait-for-approval", "Wait for my approval", ["approval_request"]),
    cogworkAction("cogwork.withdraw-pending-approval", "Withdraw the pending approval", []),
    cogworkAction("cogwork.hand-to-me", "Hand to me", ["hand_off"]),
    cogworkAction("cogwork.stop", "Stop", []),
  ],
  instructionPackages: [],
  models: [],
  defaultHarness: null,
  registeredWorkspaces: [],
  systemBindings: [],
  readyConnections: [],
  readyNeeds: [],
});
