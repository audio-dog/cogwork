import {
  defaultControlStore,
  HarnessCatalog,
  type HarnessCatalogChoice,
  HarnessEnablement,
  HarnessName,
  HarnessOptionCatalog,
  HarnessReadiness,
  HarnessReadinessItem,
  HarnessSignIn,
  HarnessState,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  availableHarnessCatalogs,
  catalogChoiceLabel,
  catalogChoiceMatches,
  harnessCatalogLoad,
  harnessIsDisabled,
  harnessSelectionUpdates,
  modelOptionChoice,
  modelOptionStates,
  modelOptionSummary,
  modelOptionsCell,
  modelOptionUpdates,
  operationSettingBatch,
  operationSettingUpdate,
  policyProfileChoices,
  providerPickerCatalogs,
  selectableHarnessCatalogs,
  settingCell,
  unavailableHarnessLabel,
} from "./operation-settings";

const workspace = Schema.decodeSync(WorkspaceId)("w");
const other = Schema.decodeSync(WorkspaceId)("other");
const harness = Schema.decodeSync(HarnessName);

const harnessItem = (harness: string, catalog: HarnessOptionCatalog) =>
  HarnessCatalog.make({
    harness: Schema.decodeSync(HarnessName)(harness),
    catalog,
  });

const optionCatalog = (policyProfiles: ReadonlyArray<"read-only" | "full">) =>
  HarnessOptionCatalog.make({
    models: [
      { value: "model-a", label: "Model A" },
      { value: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
    ],
    policyProfiles,
    provenance: { source: "managed" },
  });

const optionModel = {
  value: "model-a",
  label: "Model A",
  options: [
    {
      type: "select",
      id: "effort",
      label: "Effort",
      values: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      defaultValue: "high",
    },
    { type: "boolean", id: "speed", label: "Speed", defaultValue: false },
  ],
} satisfies HarnessCatalogChoice;

describe("availableHarnessCatalogs", () => {
  it("keeps every Provider independent of its declared permission profiles", () => {
    const catalogs = [
      harnessItem("codex", optionCatalog(["read-only", "full"])),
      harnessItem("provider", optionCatalog(["full"])),
      harnessItem("cursor", optionCatalog([])),
    ];

    const available = availableHarnessCatalogs(catalogs);

    expect(available.map(({ harness }) => harness)).toEqual(["codex", "provider", "cursor"]);
    expect(available[0]?.models[0]?.label).toBe("Model A");
    expect(available[0]?.policyProfiles).toEqual(["read-only", "full"]);
    expect(available[0]?.provenance).toEqual({ source: "managed" });
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

describe("providerPickerCatalogs", () => {
  const pickerCatalogs = availableHarnessCatalogs([
    harnessItem("codex", optionCatalog(["read-only", "full"])),
    harnessItem("cursor", optionCatalog(["full"])),
  ]);

  it("keeps readiness-pending Providers pickable", () => {
    const readiness = HarnessReadiness.make({
      checkedAtMillis: 0,
      harnesses: [
        HarnessReadinessItem.make({
          harness: harness("codex"),
          version: null,
          state: HarnessState.cases.Unknown.make({
            diagnostic: "Harness readiness has not been checked yet",
          }),
        }),
      ],
    });
    const providers = providerPickerCatalogs(pickerCatalogs, readiness);

    expect(providers.map(({ availability }) => availability)).toEqual([
      { pickable: true, stateLabel: "Not checked yet", reason: "Readiness check pending" },
      { pickable: true, stateLabel: "Not checked yet", reason: "Readiness check pending" },
    ]);
  });

  it("refuses a Provider when a completed readiness check reached no conclusion", () => {
    const readiness = HarnessReadiness.make({
      checkedAtMillis: 1,
      harnesses: [
        HarnessReadinessItem.make({
          harness: harness("codex"),
          version: null,
          state: HarnessState.cases.Unknown.make({ diagnostic: "probe timed out" }),
        }),
      ],
    });

    expect(providerPickerCatalogs(pickerCatalogs, readiness)[0]?.availability).toEqual({
      pickable: false,
      stateLabel: "Readiness unknown",
      reason: "probe timed out",
    });
  });

  it("keeps unavailable Providers visible with their reason but not pickable", () => {
    const readiness = HarnessReadiness.make({
      checkedAtMillis: 1,
      harnesses: [
        HarnessReadinessItem.make({
          harness: harness("codex"),
          version: null,
          state: HarnessState.cases.NotInstalled.make({ diagnostic: "codex is not on PATH" }),
        }),
        HarnessReadinessItem.make({
          harness: harness("cursor"),
          version: null,
          state: HarnessState.cases.NotSignedIn.make({
            signIn: HarnessSignIn.make({ command: "cursor agent login" }),
          }),
        }),
      ],
    });

    expect(providerPickerCatalogs(pickerCatalogs, readiness).map(({ availability }) => availability)).toEqual(
      [
        { pickable: false, stateLabel: "Not installed", reason: "codex is not on PATH" },
        { pickable: false, stateLabel: "Not signed in", reason: "Run cursor agent login" },
      ],
    );
  });
});

describe("modelOptionSummary", () => {
  it("summarizes effective option labels for the Provider picker trigger", () => {
    expect(
      modelOptionSummary([
        { descriptor: optionModel.options[0], value: "high", source: "inherited" },
        { descriptor: optionModel.options[1], value: false, source: "default" },
      ]),
    ).toBe("High · Speed Off");
  });
});

describe("harnessSelectionUpdates", () => {
  it("clears settings constrained by a newly selected Harness", () => {
    expect(harnessSelectionUpdates("codex", "cursor", "cursor-auto")).toEqual([
      { setting: "harness", value: "cursor" },
      { setting: "model", value: "cursor-auto" },
      { setting: "model-options", value: {} },
      { setting: "permission-profile", value: null },
    ]);
  });

  it("keeps Permissions when only the model changes", () => {
    expect(harnessSelectionUpdates("codex", "codex", "gpt-5.6-sol")).toEqual([
      { setting: "harness", value: "codex" },
      { setting: "model", value: "gpt-5.6-sol" },
      { setting: "model-options", value: {} },
    ]);
  });

  it("restores inherited model options when Harness and model overrides are reverted", () => {
    expect(harnessSelectionUpdates("codex", null, null)).toEqual([
      { setting: "harness", value: null },
      { setting: "model", value: null },
      { setting: "model-options", value: null },
      { setting: "permission-profile", value: null },
    ]);
  });
});

describe("harnessCatalogLoad", () => {
  it("does not represent a pending or failed query as an empty catalog", () => {
    expect(harnessCatalogLoad(null, false)).toEqual({ status: "loading" });
    expect(harnessCatalogLoad(null, true)).toEqual({ status: "failed" });
  });

  it("represents a successful empty catalog list as ready", () => {
    expect(harnessCatalogLoad([], false)).toEqual({ status: "ready", catalogs: [] });
  });
});

const catalogs = availableHarnessCatalogs([harnessItem("codex", optionCatalog(["read-only", "full"]))]);

describe("selectableHarnessCatalogs", () => {
  it("omits disabled Harnesses from new choices", () => {
    const controlStore = {
      ...defaultControlStore,
      harnessSettings: [HarnessEnablement.make({ harness: harness("codex"), enabled: false })],
    };

    expect(selectableHarnessCatalogs(controlStore, catalogs)).toEqual([]);
  });

  it("offers every enabled Harness for every Operation", () => {
    const operationCatalogs = availableHarnessCatalogs([
      harnessItem("codex", optionCatalog(["read-only", "full"])),
      harnessItem("cursor", optionCatalog(["full"])),
      harnessItem("reader", optionCatalog(["read-only"])),
    ]);

    expect(selectableHarnessCatalogs(defaultControlStore, operationCatalogs)).toEqual(operationCatalogs);
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

const profileDefault = (setting: string, value: string | Record<string, string | boolean>) => ({
  setting,
  level: { _tag: "Default" },
  scope: { _tag: "SettingsProfile" },
  value,
});

const overlayOperation = (
  setting: string,
  operation: string,
  value: string | Record<string, string | boolean>,
  target = workspace,
) => ({
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

  it("uses the Operation default when the selected Harness declares it", () => {
    const controlStore = store([profileDefault("harness", "codex")]);

    expect(settingCell(controlStore, catalogs, workspace, "triage", "permission-profile")).toMatchObject({
      inherited: "read-only",
      effective: "read-only",
      stale: false,
    });
    expect(settingCell(controlStore, catalogs, workspace, "implement", "permission-profile")).toMatchObject({
      inherited: "full",
      effective: "full",
      stale: false,
    });
  });

  it("uses the selected Harness profile when it does not declare the Operation default", () => {
    const cursorCatalogs = availableHarnessCatalogs([harnessItem("cursor", optionCatalog(["full"]))]);
    const controlStore = store([profileDefault("harness", "cursor")]);

    expect(
      settingCell(controlStore, cursorCatalogs, workspace, "triage", "permission-profile"),
    ).toMatchObject({ inherited: "full", effective: "full", stale: false });
  });

  it("marks a saved profile the selected Harness does not declare stale", () => {
    const cursorCatalogs = availableHarnessCatalogs([harnessItem("cursor", optionCatalog(["full"]))]);
    const controlStore = store([
      profileDefault("harness", "cursor"),
      overlayOperation("permission-profile", "triage", "read-only"),
    ]);

    expect(
      settingCell(controlStore, cursorCatalogs, workspace, "triage", "permission-profile"),
    ).toMatchObject({ own: "read-only", effective: "read-only", stale: true });
  });
});

describe("model options", () => {
  it("distinguishes inherited selections from descriptor defaults", () => {
    const controlStore = store([profileDefault("model-options", { effort: "low" })]);

    const cell = modelOptionsCell(controlStore, workspace, "implement");

    expect(cell).toEqual({ own: null, inherited: { effort: "low" }, effective: { effort: "low" } });
    expect(modelOptionStates(optionModel, cell)).toEqual([
      { descriptor: optionModel.options[0], value: "low", source: "inherited" },
      { descriptor: optionModel.options[1], value: false, source: "default" },
    ]);
  });

  it("treats an atomic override as replacing inherited selections", () => {
    const controlStore = store([
      profileDefault("model-options", { effort: "low", speed: true }),
      overlayOperation("model-options", "implement", { effort: "high" }),
    ]);

    const states = modelOptionStates(optionModel, modelOptionsCell(controlStore, workspace, "implement"));

    expect(states.map(({ value, source }) => ({ value, source }))).toEqual([
      { value: "high", source: "own" },
      { value: false, source: "default" },
    ]);
  });

  it("surfaces stale selections beside their descriptor defaults", () => {
    const states = modelOptionStates(optionModel, {
      own: { effort: "missing" },
      inherited: null,
      effective: { effort: "missing" },
    });

    expect(states[0]).toMatchObject({ value: "high", source: "stale", staleValue: "missing" });
  });

  it("resolves each available choice to a valid managed selection", () => {
    const catalog = {
      ...optionCatalog(["full"]),
      rawModelSelections: {
        "model-high": { model: "model-a", options: { effort: "high", speed: false } },
        "model-high-fast": { model: "model-a", options: { effort: "high", speed: true } },
        "model-low": { model: "model-a", options: { effort: "low", speed: false } },
      },
    };

    expect(modelOptionChoice(catalog, optionModel, { effort: "low", speed: false }, "speed", true)).toEqual({
      effort: "high",
      speed: true,
    });
    expect(modelOptionChoice(catalog, optionModel, { effort: "high", speed: true }, "effort", "low")).toEqual(
      {
        effort: "low",
        speed: false,
      },
    );
    expect(modelOptionChoice(optionCatalog(["full"]), optionModel, { effort: "low" }, "speed", true)).toEqual(
      {
        effort: "low",
        speed: true,
      },
    );
  });

  it("writes the effective model and complete options in one batch", () => {
    expect(modelOptionUpdates(optionModel, { effort: "low", speed: true })).toEqual([
      { setting: "model", value: "model-a" },
      { setting: "model-options", value: { effort: "low", speed: true } },
    ]);
  });
});

describe("policyProfileChoices", () => {
  it("offers exactly the selected Harness profiles", () => {
    expect(policyProfileChoices(catalogs[0] ?? null)).toEqual([
      { value: "read-only", label: "Read only" },
      { value: "full", label: "Full" },
    ]);
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

  it("builds one batch for one Provider and model pick", () => {
    expect(
      operationSettingBatch(
        workspace,
        "implement",
        harnessSelectionUpdates("codex", "cursor", "cursor-auto"),
      ),
    ).toEqual([
      {
        _tag: "Set",
        row: {
          setting: "harness",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace },
          value: "cursor",
        },
      },
      {
        _tag: "Set",
        row: {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace },
          value: "cursor-auto",
        },
      },
      {
        _tag: "Set",
        row: {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace },
          value: {},
        },
      },
      {
        _tag: "Clear",
        cell: {
          setting: "permission-profile",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace },
        },
      },
    ]);
  });

  it("clears the cell when the value is null, which puts it back on the default", () => {
    expect(operationSettingUpdate(workspace, "follow-up", "model-options", null)).toEqual({
      _tag: "Clear",
      cell: {
        setting: "model-options",
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

describe("an unregistered Harness", () => {
  it("makes the model saved under it stale, because no catalog can vouch for it", () => {
    const controlStore = store([
      profileDefault("harness", "provider"),
      profileDefault("model", "gpt-5.6-sol"),
    ]);
    expect(settingCell(controlStore, catalogs, workspace, "triage", "harness").stale).toBe(true);
    expect(settingCell(controlStore, catalogs, workspace, "triage", "model").stale).toBe(true);
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
  it("does not make the Harness selection stale", () => {
    const controlStore = store([profileDefault("harness", "codex")]);
    const fullOnlyCatalogs = availableHarnessCatalogs([harnessItem("codex", optionCatalog(["full"]))]);

    expect(settingCell(controlStore, fullOnlyCatalogs, workspace, "triage", "harness").stale).toBe(false);
    expect(settingCell(controlStore, fullOnlyCatalogs, workspace, "implement", "harness").stale).toBe(false);
  });
});
