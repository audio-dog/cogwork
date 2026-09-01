import { type ControlStore, WorkspaceId } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { operationSettingDisplayRows, operationSettingDisplaySections } from "./operation-settings-view";

const workspace = Schema.decodeSync(WorkspaceId)("example");
const unrelatedWorkspace = Schema.decodeSync(WorkspaceId)("unrelated");
const globalWorkspace = Schema.decodeSync(WorkspaceId)("global");

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
    {
      setting: "model",
      level: { _tag: "Operation", workflow: "coding", operation: "implement" },
      scope: { _tag: "PrivateWorkspaceOverlay", workspace },
      value: "workspace-model",
    },
    {
      setting: "model",
      level: { _tag: "Operation", workflow: "coding", operation: "triage" },
      scope: { _tag: "SettingsProfile" },
      value: "triage-model",
    },
    {
      setting: "model",
      level: { _tag: "Operation", workflow: "coding", operation: "triage" },
      scope: { _tag: "PrivateWorkspaceOverlay", workspace: unrelatedWorkspace },
      value: "workspace-triage-model",
    },
  ],
  connections: [],
  pluginInstalls: [],
  contributionSettings: [],
};

describe("Operation settings view", () => {
  it("counts only raw rows applicable to the work context", () => {
    const rows = operationSettingDisplayRows(controlStore, {
      workflow: "coding",
      operation: "implement",
      workspace: null,
    });

    expect(rows.find((row) => row.setting === "model")).toEqual({
      setting: "model",
      label: "Model",
      value: "operation-model",
      rawRows: 2,
    });
    expect(rows.find((row) => row.setting === "harness")?.value).toBe("Not set");
  });

  it("renders each applicable Private workspace overlay in its own ladder", () => {
    const sections = operationSettingDisplaySections(controlStore);

    expect(sections.map((section) => section.label)).toEqual([
      "Coding · Implement",
      "Coding · Implement · example",
    ]);
    const workspaceSection = sections.find((section) => section.context.workspace === workspace);
    expect(workspaceSection).toBeDefined();
    if (!workspaceSection) return;
    expect(
      operationSettingDisplayRows(controlStore, workspaceSection.context).find(
        (row) => row.setting === "model",
      )?.value,
    ).toBe("workspace-model");
  });

  it("gives machine and workspace ladders distinct keys", () => {
    const sections = operationSettingDisplaySections({
      ...controlStore,
      operationSettings: [
        ...controlStore.operationSettings,
        {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: globalWorkspace },
          value: "global-workspace-model",
        },
      ],
    });

    expect(sections.map((section) => section.key)).toEqual([
      "global",
      "workspace:example",
      "workspace:global",
    ]);
  });
});
