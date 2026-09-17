import {
  defaultControlStore,
  HarnessEnablement,
  HarnessItem,
  HarnessName,
  HarnessOptionCatalog,
  HarnessOverview,
  HarnessState,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { operationSettingAtomKey } from "../daemon/atoms";
import {
  availableHarnessCatalogs,
  catalogChoiceLabel,
  catalogChoiceMatches,
  harnessCatalogLoad,
  harnessIsDisabled,
  lockedPolicyProfile,
  operationSettingUpdate,
  selectableHarnessCatalogs,
  settingCell,
  unavailableHarnessLabel,
} from "./operation-settings";

const workspace = Schema.decodeSync(WorkspaceId)("w");
const other = Schema.decodeSync(WorkspaceId)("other");
const harness = Schema.decodeSync(HarnessName);

const harnessItem = (harness: string, catalog: HarnessOptionCatalog | null) =>
  HarnessItem.make({
    harness: Schema.decodeSync(HarnessName)(harness),
    version: null,
    state: HarnessState.cases.Ready.make({}),
    models: catalog?.models.map(({ value }) => value) ?? [],
    catalog,
  });

const optionCatalog = (
  policyProfiles: ReadonlyArray<"read-only" | "full">,
  efforts?: ReadonlyArray<{ readonly value: string; readonly label: string }>,
) =>
  HarnessOptionCatalog.make({
    models: [
      { value: "model-a", label: "Model A" },
      { value: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
    ],
    ...(efforts ? { efforts } : {}),
    policyProfiles,
    provenance: { source: "cogwork-fallback", fallbackVersion: "test-1" },
  });

describe("availableHarnessCatalogs", () => {
  it("keeps published labels and absence of effort while excluding unusable harnesses", () => {
    const overview = HarnessOverview.make({
      harnesses: [
        harnessItem("codex", optionCatalog(["read-only", "full"])),
        harnessItem("provider", optionCatalog(["full"])),
        harnessItem("cursor", optionCatalog([])),
        harnessItem("broken", null),
      ],
      checkedAtMillis: 1,
    });

    const catalogs = availableHarnessCatalogs(overview);

    expect(catalogs.map(({ harness }) => harness)).toEqual(["codex", "provider"]);
    expect(catalogs[0]?.models[0]?.label).toBe("Model A");
    expect(catalogs[0]?.policyProfiles).toEqual(["read-only", "full"]);
    expect(catalogs[1]?.efforts).toBeUndefined();
    expect(catalogs[0]?.provenance).toEqual({
      source: "cogwork-fallback",
      fallbackVersion: "test-1",
    });
  });
});

describe("catalog choices", () => {
  const choice = { value: "model-a", label: "Model A" };

  it("uses the published label for a selected value", () => {
    expect(catalogChoiceLabel([choice], choice.value)).toBe("Model A");
  });

  it("matches searches against labels and values", () => {
    expect(catalogChoiceMatches(choice, "model a")).toBe(true);
    expect(catalogChoiceMatches(choice, "model-a")).toBe(true);
  });
});

describe("harnessCatalogLoad", () => {
  it("does not represent a pending or failed query as an empty catalog", () => {
    expect(harnessCatalogLoad(null, false)).toEqual({ status: "loading" });
    expect(harnessCatalogLoad(null, true)).toEqual({ status: "failed" });
  });

  it("represents a successful empty overview as ready", () => {
    const overview = HarnessOverview.make({ harnesses: [], checkedAtMillis: 1 });

    expect(harnessCatalogLoad(overview, false)).toEqual({ status: "ready", catalogs: [] });
  });
});

const catalogs = availableHarnessCatalogs(
  HarnessOverview.make({
    harnesses: [harnessItem("codex", optionCatalog(["read-only", "full"]))],
    checkedAtMillis: 1,
  }),
);

describe("selectableHarnessCatalogs", () => {
  it("omits disabled Harnesses from new choices", () => {
    const controlStore = {
      ...defaultControlStore,
      harnessSettings: [HarnessEnablement.make({ harness: harness("codex"), enabled: false })],
    };

    expect(selectableHarnessCatalogs(controlStore, catalogs, "triage")).toEqual([]);
  });

  it("offers only Harnesses that declare the Operation's locked profile", () => {
    const operationCatalogs = availableHarnessCatalogs(
      HarnessOverview.make({
        harnesses: [
          harnessItem("codex", optionCatalog(["read-only", "full"])),
          harnessItem("cursor", optionCatalog(["full"])),
          harnessItem("reader", optionCatalog(["read-only"])),
        ],
        checkedAtMillis: 1,
      }),
    );

    expect(selectableHarnessCatalogs(defaultControlStore, operationCatalogs, "triage")).toEqual([
      operationCatalogs[0],
      operationCatalogs[2],
    ]);
    expect(selectableHarnessCatalogs(defaultControlStore, operationCatalogs, "implement")).toEqual([
      operationCatalogs[0],
      operationCatalogs[1],
    ]);
    expect(selectableHarnessCatalogs(defaultControlStore, operationCatalogs, "follow-up")).toEqual([
      operationCatalogs[0],
      operationCatalogs[1],
    ]);
  });

  it("identifies a disabled Harness without a published catalog", () => {
    const disabled = harness("claude");

    expect(
      harnessIsDisabled(
        {
          ...defaultControlStore,
          harnessSettings: [HarnessEnablement.make({ harness: disabled, enabled: false })],
        },
        disabled,
      ),
    ).toBe(true);
  });

  it("distinguishes an enabled unavailable Harness from a disabled one", () => {
    expect(unavailableHarnessLabel("claude", false)).toBe("claude · no longer offered");
    expect(unavailableHarnessLabel("claude", true)).toBe("claude · disabled");
  });
});

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

    const triage = settingCell(controlStore, catalogs, workspace, "triage", "model");
    expect(triage.own).toBe("gpt-5.6-luna");
    expect(triage.inherited).toBe("gpt-5.6-sol");
    expect(triage.effective).toBe("gpt-5.6-luna");

    const implement = settingCell(controlStore, catalogs, workspace, "implement", "model");
    expect(implement.own).toBeNull();
    expect(implement.effective).toBe("gpt-5.6-sol");
  });

  it("ignores another workspace's overlay row", () => {
    const controlStore = store([
      profileDefault("model", "gpt-5.6-sol"),
      overlayOperation("model", "triage", "gpt-5.6-luna", other),
    ]);
    expect(settingCell(controlStore, catalogs, workspace, "triage", "model").own).toBeNull();
  });

  it("counts a value equal to the default as this workspace's own", () => {
    const controlStore = store([
      profileDefault("model", "gpt-5.6-sol"),
      overlayOperation("model", "triage", "gpt-5.6-sol"),
    ]);
    const cell = settingCell(controlStore, catalogs, workspace, "triage", "model");
    expect(cell.own).toBe("gpt-5.6-sol");
    expect(cell.inherited).toBe("gpt-5.6-sol");
  });

  it("calls a saved choice the current catalog no longer offers stale", () => {
    const controlStore = store([
      profileDefault("harness", "codex"),
      overlayOperation("model", "triage", "gpt-4-retired"),
    ]);
    expect(settingCell(controlStore, catalogs, workspace, "triage", "model").stale).toBe(true);
    expect(settingCell(controlStore, catalogs, workspace, "implement", "model").stale).toBe(false);
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
    expect(operationSettingUpdate(workspace, "follow-up", "effort", null)).toEqual({
      _tag: "Clear",
      cell: {
        setting: "effort",
        level: { _tag: "Operation", workflow: "coding", operation: "follow-up" },
        scope: { _tag: "PrivateWorkspaceOverlay", workspace },
      },
    });
  });

  it("sends enabled as the boolean its row schema expects", () => {
    expect(operationSettingUpdate(workspace, "follow-up", "enabled", "false")).toEqual({
      _tag: "Set",
      row: {
        setting: "enabled",
        level: { _tag: "Operation", workflow: "coding", operation: "follow-up" },
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
    expect(settingCell(controlStore, catalogs, workspace, "follow-up", "enabled").effective).toBe("false");
    // Clearing would fall back to the profile's `false`, so "on" has to be an explicit true.
    expect(operationSettingUpdate(workspace, "follow-up", "enabled", "true")).toEqual({
      _tag: "Set",
      row: {
        setting: "enabled",
        level: { _tag: "Operation", workflow: "coding", operation: "follow-up" },
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
    expect(settingCell(controlStore, catalogs, workspace, "triage", "harness").stale).toBe(true);
    expect(settingCell(controlStore, catalogs, workspace, "triage", "model").stale).toBe(true);
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
    const cell = settingCell(controlStore, catalogs, workspace, "triage", "harness");
    expect(cell.effective).toBeNull();
    expect(cell.stale).toBe(false);
    expect(settingCell(controlStore, catalogs, workspace, "triage", "model").stale).toBe(false);
  });
});

describe("a policy profile the selected harness cannot enforce", () => {
  it("makes the saved Harness selection stale", () => {
    const controlStore = store([profileDefault("harness", "codex")]);
    const fullOnlyCatalogs = availableHarnessCatalogs(
      HarnessOverview.make({
        harnesses: [harnessItem("codex", optionCatalog(["full"]))],
        checkedAtMillis: 1,
      }),
    );

    expect(settingCell(controlStore, fullOnlyCatalogs, workspace, "triage", "harness").stale).toBe(true);
    expect(settingCell(controlStore, fullOnlyCatalogs, workspace, "implement", "harness").stale).toBe(false);
  });
});

describe("lockedPolicyProfile", () => {
  it.each([
    ["triage", "read-only", "Read only", "Triage Operation Definition"],
    ["implement", "full", "Full", "Implement Operation Definition"],
    ["follow-up", "full", "Full", "Follow-up Operation Definition"],
  ] as const)("describes %s from its Operation Definition", (operation, value, label, provenance) => {
    expect(lockedPolicyProfile(operation)).toEqual({ value, label, provenance });
  });
});
