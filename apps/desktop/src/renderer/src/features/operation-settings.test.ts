import { defaultControlStore, WorkspaceId } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { operationSettingAtomKey } from "../daemon/atoms";
import { operationSettingUpdate, settingCell } from "./operation-settings";

const workspace = Schema.decodeSync(WorkspaceId)("w");
const other = Schema.decodeSync(WorkspaceId)("other");

const store = (rows: ReadonlyArray<Record<string, unknown>>): Parameters<typeof settingCell>[0] =>
  ({ ...defaultControlStore, operationSettings: rows }) as Parameters<typeof settingCell>[0];

const profileDefault = (setting: string, value: string) => ({
  setting,
  level: { _tag: "Default" },
  scope: { _tag: "SettingsProfile" },
  value,
});

const overlayOperation = (setting: string, operation: string, value: string, target = workspace) => ({
  setting,
  level: { _tag: "Operation", workflow: "coding", operation },
  scope: { _tag: "PrivateWorkspaceOverlay", workspace: target },
  value,
});

describe("settingCell", () => {
  it("separates this workspace's value from the one it would inherit", () => {
    const controlStore = store([
      profileDefault("model", "gpt-5.6-sol"),
      overlayOperation("model", "triage", "gpt-5.6-luna"),
    ]);

    const triage = settingCell(controlStore, workspace, "triage", "model");
    expect(triage.own).toBe("gpt-5.6-luna");
    expect(triage.inherited).toBe("gpt-5.6-sol");
    expect(triage.effective).toBe("gpt-5.6-luna");

    const implement = settingCell(controlStore, workspace, "implement", "model");
    expect(implement.own).toBeNull();
    expect(implement.effective).toBe("gpt-5.6-sol");
  });

  it("ignores another workspace's overlay row", () => {
    const controlStore = store([
      profileDefault("model", "gpt-5.6-sol"),
      overlayOperation("model", "triage", "gpt-5.6-luna", other),
    ]);
    expect(settingCell(controlStore, workspace, "triage", "model").own).toBeNull();
  });

  it("counts a value equal to the default as this workspace's own", () => {
    const controlStore = store([
      profileDefault("model", "gpt-5.6-sol"),
      overlayOperation("model", "triage", "gpt-5.6-sol"),
    ]);
    const cell = settingCell(controlStore, workspace, "triage", "model");
    expect(cell.own).toBe("gpt-5.6-sol");
    expect(cell.inherited).toBe("gpt-5.6-sol");
  });

  it("calls a saved choice the current catalog no longer offers stale", () => {
    const controlStore = store([
      profileDefault("harness", "codex"),
      overlayOperation("model", "triage", "gpt-4-retired"),
    ]);
    expect(settingCell(controlStore, workspace, "triage", "model").stale).toBe(true);
    expect(settingCell(controlStore, workspace, "implement", "model").stale).toBe(false);
  });
});

describe("operationSettingUpdate", () => {
  it("sets a value at this workspace's overlay, at the Operation level", () => {
    expect(operationSettingUpdate(workspace, "triage", "model", "auto")).toEqual({
      _tag: "Set",
      row: {
        setting: "model",
        level: { _tag: "Operation", workflow: "coding", operation: "triage" },
        scope: { _tag: "PrivateWorkspaceOverlay", workspace },
        value: "auto",
      },
    });
  });

  it("clears the cell when the value is null, which puts it back on the default", () => {
    expect(operationSettingUpdate(workspace, "verify", "effort", null)).toEqual({
      _tag: "Clear",
      cell: {
        setting: "effort",
        level: { _tag: "Operation", workflow: "coding", operation: "verify" },
        scope: { _tag: "PrivateWorkspaceOverlay", workspace },
      },
    });
  });

  it("sends enabled as the boolean its row schema expects", () => {
    expect(operationSettingUpdate(workspace, "verify", "enabled", "false")).toEqual({
      _tag: "Set",
      row: {
        setting: "enabled",
        level: { _tag: "Operation", workflow: "coding", operation: "verify" },
        scope: { _tag: "PrivateWorkspaceOverlay", workspace },
        value: false,
      },
    });
  });
});

describe("enabled", () => {
  it("can be turned back on when the profile default is off", () => {
    const controlStore = store([
      { setting: "enabled", level: { _tag: "Default" }, scope: { _tag: "SettingsProfile" }, value: false },
    ]);
    expect(settingCell(controlStore, workspace, "verify", "enabled").effective).toBe("false");
    // Clearing would fall back to the profile's `false`, so "on" has to be an explicit true.
    expect(operationSettingUpdate(workspace, "verify", "enabled", "true")).toEqual({
      _tag: "Set",
      row: {
        setting: "enabled",
        level: { _tag: "Operation", workflow: "coding", operation: "verify" },
        scope: { _tag: "PrivateWorkspaceOverlay", workspace },
        value: true,
      },
    });
  });
});

describe("an unknown harness", () => {
  it("makes the model saved under it stale, because no catalog can vouch for it", () => {
    const controlStore = store([
      profileDefault("harness", "retired-harness"),
      profileDefault("model", "gpt-5.6-sol"),
    ]);
    expect(settingCell(controlStore, workspace, "triage", "harness").stale).toBe(true);
    expect(settingCell(controlStore, workspace, "triage", "model").stale).toBe(true);
  });
});

describe("operationSettingAtomKey", () => {
  it("separates two workspaces writing the same setting", () => {
    expect(operationSettingAtomKey(workspace, "model")).not.toBe(operationSettingAtomKey(other, "model"));
    expect(operationSettingAtomKey(workspace, "model")).not.toBe(
      operationSettingAtomKey(workspace, "harness"),
    );
  });
});

describe("an unset harness", () => {
  it("is not stale, because there is no choice to have gone out of date", () => {
    const controlStore = store([]);
    const cell = settingCell(controlStore, workspace, "triage", "harness");
    expect(cell.effective).toBeNull();
    expect(cell.stale).toBe(false);
    expect(settingCell(controlStore, workspace, "triage", "model").stale).toBe(false);
  });
});
