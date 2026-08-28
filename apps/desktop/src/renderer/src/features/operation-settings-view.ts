import {
  type ControlStore,
  type OperationSettingContext,
  type OperationSettingName,
  operationSettingNames,
  operationSettingRowsForContext,
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

const displayValue = (value: ReturnType<typeof resolveOperationSetting>) => {
  if (value === null) return "Not set";
  if (typeof value === "object") return value.length === 0 ? "Not set" : JSON.stringify(value);
  return String(value);
};

export const operationSettingDisplayRows = (controlStore: ControlStore, context: OperationSettingContext) => {
  const contextualRows = operationSettingRowsForContext(controlStore.operationSettings, context);
  return operationSettingNames.map((setting) => ({
    setting,
    label: settingLabels[setting],
    value: displayValue(resolveOperationSetting(controlStore.operationSettings, setting, context)),
    rawRows: contextualRows.filter((row) => row.setting === setting).length,
  }));
};

const codingImplementContext = (workspace: OperationSettingContext["workspace"]) => ({
  workflow: "coding",
  operation: "implement",
  workspace,
});

export const operationSettingDisplaySections = (controlStore: ControlStore) => {
  const workspaces = [
    ...new Set(
      controlStore.operationSettings.flatMap((row) =>
        row.scope._tag === "PrivateWorkspaceOverlay" ? [row.scope.workspace] : [],
      ),
    ),
  ];
  return [
    { key: "global", label: "Coding · Implement", context: codingImplementContext(null) },
    ...workspaces.map((workspace) => ({
      key: workspace,
      label: `Coding · Implement · ${workspace}`,
      context: codingImplementContext(workspace),
    })),
  ];
};
