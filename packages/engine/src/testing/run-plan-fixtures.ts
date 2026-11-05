import {
  Claim,
  HarnessName,
  LineageId,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkflowOperation,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import type { TriggerAdmission } from "../trigger-observation";

export const workflow = Schema.decodeSync(WorkflowId)("daily-summary");
export const harnessName = Schema.decodeSync(HarnessName)("scripted");
const scheduleEntry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");

export const operation = Schema.decodeSync(WorkflowOperation)({
  id: "summarize",
  name: "Summarize",
  instructionPackage: "implement-agent",
  instruction: "Summarize the day.",
  permissionProfile: "read-only",
  requires: [],
  model: { harness: null, model: null, options: [] },
  forEach: null,
  questions: [],
  transitions: [],
  hints: [],
});

export const admission: TriggerAdmission = {
  event: {
    key: { _tag: "ScheduleInstant", workflow, instantMillis: 1_000 },
    revision: "1000",
    cause: { _tag: "Unknown" },
    atMillis: 1_000,
    entry: scheduleEntry,
    workspace: null,
  },
  subscription: {
    workflow,
    trigger: Schema.decodeSync(WorkflowNodeId)("schedule"),
    operation: operation.id,
    entry: scheduleEntry,
    parameters: [],
    filters: [],
    workspaces: [],
    catchUp: { since: 0 },
  },
  lineage: { root: LineageId.make("schedule:1000"), parent: null, hop: 0 },
};

export const claim = Claim.make({
  by: "cogwork",
  claimedAtMillis: 1,
  operation: { workflow, operation: operation.id },
  lineage: admission.lineage,
});
