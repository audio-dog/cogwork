import type { ControlStore } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import { operationSettingDisplayRows } from "./operation-settings-view";

const controlStore: ControlStore = {
  daemonLimits: {
    globalConcurrency: 4,
    perWorkspaceConcurrency: 4,
    dailyBudget: 50,
    revision: 0,
  },
  operationSettings: [
    {
      setting: "model",
      level: { _tag: "Default" },
      scope: { _tag: "SettingsProfile" },
      value: "profile-default",
    },
    {
      setting: "model",
      level: { _tag: "Operation", workflow: "coding", operation: "implement" },
      scope: { _tag: "SettingsProfile" },
      value: "operation-model",
    },
  ],
};

describe("Operation settings view", () => {
  it("renders effective values from the Control store's raw rows", () => {
    const rows = operationSettingDisplayRows(controlStore, {
      workflow: "coding",
      operation: "implement",
    });

    expect(rows.find((row) => row.setting === "model")).toEqual({
      setting: "model",
      label: "Model",
      value: "operation-model",
      rawRows: 2,
    });
    expect(rows.find((row) => row.setting === "harness")?.value).toBe("Not set");
  });
});
