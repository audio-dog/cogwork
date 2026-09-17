import {
  LifecycleStage,
  OperationSettingRefused,
  OperationSettingUpdate,
  operationPolicyProfiles,
  type RunPlanPolicyProfile,
  SettingLevel,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";

export type OperationPolicyProfile = RunPlanPolicyProfile;

export const operationPolicyProfile = (stage: LifecycleStage) => operationPolicyProfiles[stage];

const isLifecycleStage = Schema.is(LifecycleStage);

export const operationSettingRefusal = (update: OperationSettingUpdate) => {
  const cell = OperationSettingUpdate.match(update, {
    Set: ({ row }) => row,
    Clear: ({ cell }) => cell,
  });
  return SettingLevel.match(cell.level, {
    Default: () => null,
    Workflow: ({ workflow }) => {
      if (workflow === "coding") return null;
      return OperationSettingRefused.make({
        setting: cell.setting,
        source: "Workflow catalog",
        reason: `Unknown Workflow ${workflow}`,
      });
    },
    Operation: ({ workflow, operation }) => {
      if (workflow !== "coding")
        return OperationSettingRefused.make({
          setting: cell.setting,
          source: "Workflow catalog",
          reason: `Unknown Workflow ${workflow}`,
        });
      if (!isLifecycleStage(operation))
        return OperationSettingRefused.make({
          setting: cell.setting,
          source: "coding Workflow Definition",
          reason: `Unknown Operation ${operation}`,
        });
      if (!OperationSettingUpdate.guards.Set(update) || cell.setting !== "permission-profile") return null;
      return OperationSettingRefused.make({
        setting: cell.setting,
        source: `${operation} Operation Definition`,
        reason: "The Operation Definition locks this setting",
      });
    },
  });
};
