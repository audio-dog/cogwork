import { LifecycleStage, OperationSettingRefused, type OperationSettingUpdate } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

export type OperationPolicyProfile = "read-only" | "full";

export const operationPolicyProfile = (stage: LifecycleStage): OperationPolicyProfile =>
  stage === "implement" || stage === "follow-up" ? "full" : "read-only";

const isLifecycleStage = Schema.is(LifecycleStage);

const cellOf = (update: OperationSettingUpdate) => (update._tag === "Set" ? update.row : update.cell);

export const operationSettingRefusal = (update: OperationSettingUpdate) => {
  const cell = cellOf(update);
  if (cell.level._tag === "Default") return null;
  if (cell.level.workflow !== "coding")
    return OperationSettingRefused.make({
      setting: cell.setting,
      source: "Workflow catalog",
      reason: `Unknown Workflow ${cell.level.workflow}`,
    });
  if (cell.level._tag === "Workflow") return null;
  if (!isLifecycleStage(cell.level.operation))
    return OperationSettingRefused.make({
      setting: cell.setting,
      source: "coding Workflow Definition",
      reason: `Unknown Operation ${cell.level.operation}`,
    });
  if (update._tag === "Clear" || cell.setting !== "permission-profile") return null;
  return OperationSettingRefused.make({
    setting: cell.setting,
    source: `${cell.level.operation} Operation Definition`,
    reason: "The Operation Definition locks this setting",
  });
};
