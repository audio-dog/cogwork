import {
  Claim,
  HarnessName,
  LineageId,
  NeedIdentity,
  RunId,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkflowOperation,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { RunPlanRejection, RunPlanResolution, resolveRunPlan } from "./run-plan-resolution";
import { PreparedRun, type RunReadiness } from "./run-preparation";
import type { TriggerAdmission } from "./trigger-observation";

const workflow = Schema.decodeSync(WorkflowId)("daily-summary");
const scheduleEntry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
const harnessName = Schema.decodeSync(HarnessName)("scripted");
const need = Schema.decodeSync(NeedIdentity)("github");

const operation = Schema.decodeSync(WorkflowOperation)({
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

const admission: TriggerAdmission = {
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

const workflowRecord = { id: workflow, publishedRevision: 1 };

const resolveUnready = (readiness: RunReadiness) =>
  resolveRunPlan({
    id: Schema.decodeSync(RunId)("run-1"),
    admission,
    workflow: workflowRecord,
    operation,
    workspace: null,
    catalog: { entries: [], instructionPackages: [], harnesses: [] },
    outputWorkspaces: [],
    claim: Claim.make({
      by: "cogwork",
      claimedAtMillis: 1,
      operation: { workflow, operation: operation.id },
      lineage: admission.lineage,
    }),
    priorIssues: null,
    prepared: PreparedRun.Unready({ readiness }),
  });

describe("resolveRunPlan", () => {
  it.each([
    {
      name: "no Harness",
      readiness: { harness: null, missingNeeds: [], preflightFailure: null },
      reason: RunPlanRejection.NoHarness(),
    },
    {
      name: "a missing need",
      readiness: { harness: harnessName, missingNeeds: [need], preflightFailure: null },
      reason: RunPlanRejection.MissingNeed({ needs: [need] }),
    },
    {
      name: "a failed preflight",
      readiness: { harness: harnessName, missingNeeds: [], preflightFailure: "Harness unavailable" },
      reason: RunPlanRejection.PreflightFailed({ message: "Harness unavailable" }),
    },
  ])("rejects the Run Plan for $name", ({ readiness, reason }) => {
    assert.deepStrictEqual(resolveUnready(readiness), RunPlanResolution.Rejected({ reason }));
  });
});
