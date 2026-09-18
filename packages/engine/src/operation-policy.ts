import {
  type HarnessName,
  LifecycleStage,
  OperationSettingRefused,
  OperationSettingUpdate,
  operationDefaultProfiles,
  type RunPlanPolicyProfile,
  SettingLevel,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";

export type OperationPolicyProfile = RunPlanPolicyProfile;

export const operationDefaultProfile = (stage: LifecycleStage) => operationDefaultProfiles[stage];

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
      return null;
    },
  });
};

export const permissionProfileRefusal = (
  update: OperationSettingUpdate,
  harness: HarnessName,
  profiles: ReadonlyArray<RunPlanPolicyProfile>,
) => {
  if (!OperationSettingUpdate.guards.Set(update)) return null;
  const { row } = update;
  if (row.setting !== "permission-profile") return null;
  if (profiles.some((profile) => profile === row.value)) return null;
  return OperationSettingRefused.make({
    setting: row.setting,
    source: `Harness ${harness}`,
    reason: `${harness} does not declare ${row.value} as a permission profile`,
  });
};
