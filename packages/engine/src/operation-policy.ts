import {
  type HarnessName,
  type HarnessOptionCatalog,
  LifecycleStage,
  type ModelOptionSelections,
  type OperationSettingName,
  OperationSettingRefused,
  OperationSettingUpdate,
  operationDefaultProfiles,
  type RunPlanPolicyProfile,
  SettingLevel,
  selectedHarnessCatalogModel,
  unsupportedHarnessModelOption,
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

type CatalogSetting = Extract<OperationSettingName, "model" | "permission-profile">;

const catalogValues: Record<CatalogSetting, (catalog: HarnessOptionCatalog) => ReadonlyArray<string>> = {
  model: (catalog: HarnessOptionCatalog) => catalog.models.map(({ value }) => value),
  "permission-profile": (catalog: HarnessOptionCatalog) => catalog.policyProfiles,
};

const catalogValueNames = {
  model: "model",
  "permission-profile": "permission profile",
} satisfies Record<CatalogSetting, string>;

export const catalogMembershipRefusal = (
  setting: CatalogSetting,
  value: string,
  harness: HarnessName,
  catalog: HarnessOptionCatalog,
) => {
  if (catalogValues[setting](catalog).includes(value)) return null;
  return OperationSettingRefused.make({
    setting,
    source: `Harness ${harness}`,
    reason: `${harness} does not offer ${catalogValueNames[setting]} ${value}`,
  });
};

export const modelOptionsMembershipRefusal = (
  options: ModelOptionSelections,
  model: string | null,
  harness: HarnessName,
  catalog: HarnessOptionCatalog,
) => {
  const selectedModel = selectedHarnessCatalogModel(catalog.models, model);
  const stale = unsupportedHarnessModelOption(selectedModel, options);
  if (!stale) return null;
  const [id, value] = stale;
  return OperationSettingRefused.make({
    setting: "model-options",
    source: `Harness ${harness}`,
    reason: `${harness} does not offer model option ${id}=${JSON.stringify(value)} for ${model ?? "its default model"}`,
  });
};
