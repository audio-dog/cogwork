import {
  type ControlStore,
  type OperationSettingContext,
  type OperationSettingName,
  resolveOperationSetting,
} from "@cogwork/contracts";

const settingLabels: Record<OperationSettingName, string> = {
  enabled: "Enabled",
  harness: "Harness",
  model: "Model",
  effort: "Effort",
  "permission-profile": "Permission profile",
  bindings: "Bindings",
};

const settings: readonly OperationSettingName[] = [
  "enabled",
  "harness",
  "model",
  "effort",
  "permission-profile",
  "bindings",
];

const displayValue = (value: ReturnType<typeof resolveOperationSetting>) => {
  if (value === null) return "Not set";
  if (typeof value === "object") return value.length === 0 ? "Not set" : JSON.stringify(value);
  return String(value);
};

export const operationSettingDisplayRows = (controlStore: ControlStore, context: OperationSettingContext) =>
  settings.map((setting) => ({
    setting,
    label: settingLabels[setting],
    value: displayValue(resolveOperationSetting(controlStore.operationSettings, setting, context)),
    rawRows: controlStore.operationSettings.filter((row) => row.setting === setting).length,
  }));
