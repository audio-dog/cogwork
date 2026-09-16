import {
  type ControlStore,
  type HarnessCatalogChoice,
  type HarnessModelOption,
  type HarnessName,
  type HarnessOptionCatalog,
  type HarnessOverview,
  harnessEnabled,
  LifecycleStage,
  OperationModelOption,
  type OperationSettingName,
  type OperationSettingRow,
  type OperationSettingUpdate,
  type RunPlanPolicyProfile,
  resolveOperationSetting,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { providerLabel } from "./provider-presentation";

/** `operationSettingRefusal` refuses any workflow but this one, so it is fixed today. */
export const codingWorkflow = "coding";

export const operations = LifecycleStage.literals;

export const operationLabels: Record<LifecycleStage, string> = {
  triage: "Triage",
  implement: "Implement",
  "follow-up": "Follow-up",
};

export const operationSummaries: Record<LifecycleStage, string> = {
  triage: "Reads a new work item and proposes what happens to it.",
  implement: "Writes the change and opens a pull request.",
  "follow-up": "Answers failing checks and review comments on its own pull request.",
};

export type HarnessCatalog = HarnessOptionCatalog & { readonly harness: HarnessName };

export const availableHarnessCatalogs = (overview: HarnessOverview | null) =>
  overview?.harnesses.flatMap(({ harness, catalog }) =>
    catalog && catalog.policyProfiles.length > 0 ? [{ harness, ...catalog }] : [],
  ) ?? [];

export const harnessCatalogLoad = (overview: HarnessOverview | null, failed: boolean) => {
  if (overview) return { status: "ready" as const, catalogs: availableHarnessCatalogs(overview) };
  if (failed) return { status: "failed" as const };
  return { status: "loading" as const };
};

export const catalogFor = (catalogs: ReadonlyArray<HarnessCatalog>, harness: string | null) =>
  catalogs.find((candidate) => candidate.harness === harness) ?? null;

export const selectableHarnessCatalogs = (
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<HarnessCatalog>,
) => {
  if (!controlStore) return catalogs;
  return catalogs.filter((catalog) => harnessEnabled(controlStore.harnessSettings, catalog.harness));
};

export const harnessIsDisabled = (controlStore: ControlStore | null, harness: string | null) => {
  if (!controlStore || !harness) return false;
  return controlStore.harnessSettings.some((setting) => setting.harness === harness && !setting.enabled);
};

export const unavailableHarnessLabel = (harness: string | null, disabled: boolean) => {
  if (!harness) return "No Harness enabled";
  if (disabled) return `${harness} · disabled`;
  return `${harness} · no longer offered`;
};

const policyProfileLabels: Record<RunPlanPolicyProfile, string> = {
  "read-only": "Read only",
  full: "Full",
};

export const policyProfileChoices = (catalog: HarnessCatalog | null) =>
  catalog?.policyProfiles.map((value) => ({ value, label: policyProfileLabels[value] })) ?? [];

export const catalogChoiceLabel = (choices: ReadonlyArray<HarnessCatalogChoice>, value: string | null) =>
  value === null ? "Not set" : (choices.find((choice) => choice.value === value)?.label ?? value);

const effortOptionId = "effort";

export interface ModelOptionSets {
  readonly own: ReadonlyArray<OperationModelOption> | null;
  readonly inherited: ReadonlyArray<OperationModelOption>;
}

const declaredOptions = (catalog: HarnessCatalog | null, model: string | null) =>
  catalog?.models.find((candidate) => candidate.value === model)?.options ?? [];

export const effortChoices = (catalog: HarnessCatalog | null, model: string | null) =>
  declaredOptions(catalog, model).find((option) => option.id === effortOptionId)?.choices ??
  catalog?.efforts ??
  null;

const declaredControls = (catalog: HarnessCatalog | null, model: string | null) =>
  declaredOptions(catalog, model).filter((option) => option.id !== effortOptionId);

/** No choices, so `modelOptionCell` reads whatever is in effect for it as stale. */
const retiredOption = (id: string): HarnessModelOption => ({
  id,
  label: id,
  choices: [],
  fallback: null,
});

/**
 * A model pick clears this workspace's own set, which lets a parent scope's set apply to a model
 * that never declared its options. Preflight refuses those, so they are shown rather than
 * filtered away: an option nobody can see is one nobody can clear.
 */
export const modelOptionControls = (
  catalog: HarnessCatalog | null,
  model: string | null,
  sets: ModelOptionSets = { own: null, inherited: [] },
) => {
  const declared = declaredControls(catalog, model);
  const undeclared = (sets.own ?? sets.inherited)
    .map(({ option }) => option)
    .filter((option) => option !== effortOptionId && !declared.some((entry) => entry.id === option));
  return [...declared, ...undeclared.map(retiredOption)];
};

/** Seeds an edit, so writing one option cannot persist another the model never declared. */
export const modelOptionsInEffect = (
  catalog: HarnessCatalog | null,
  model: string | null,
  sets: ModelOptionSets,
) => {
  const declared = declaredControls(catalog, model);
  return (sets.own ?? sets.inherited).filter((pair) => declared.some((entry) => entry.id === pair.option));
};

export const selectedModelOption = (selected: ReadonlyArray<OperationModelOption>, option: string) =>
  selected.find((candidate) => candidate.option === option)?.value ?? null;

export const modelOptionsAfter = (
  selected: ReadonlyArray<OperationModelOption>,
  option: string,
  value: string,
) => [...selected.filter((candidate) => candidate.option !== option), { option, value }];

export const catalogChoiceMatches = (choice: HarnessCatalogChoice, query: string) => {
  const needle = query.trim().toLowerCase();
  return choice.label.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle);
};

export const defaultProfile = (operation: LifecycleStage) =>
  operation === "implement" || operation === "follow-up" ? "full" : "read-only";

/**
 * One setting of one operation. `own` is what this page has set; `inherited` is what would
 * win without it. Kept apart so a control can show the inherited value without pretending
 * a person chose it — and so picking the same value as the default is still an override.
 */
export interface SettingCell {
  readonly own: string | null;
  readonly inherited: string | null;
  readonly effective: string | null;
  readonly stale: boolean;
}

const isOverride = (row: OperationSettingRow, operation: LifecycleStage, workspace: WorkspaceId) =>
  row.level._tag === "Operation" &&
  row.level.workflow === codingWorkflow &&
  row.level.operation === operation &&
  row.scope._tag === "PrivateWorkspaceOverlay" &&
  row.scope.workspace === workspace;

const storedOverride = (
  rows: ReadonlyArray<OperationSettingRow>,
  setting: OperationSettingName,
  operation: LifecycleStage,
  workspace: WorkspaceId,
) => rows.find((row) => row.setting === setting && isOverride(row, operation, workspace)) ?? null;

const inheritedValue = (
  rows: ReadonlyArray<OperationSettingRow>,
  setting: OperationSettingName,
  operation: LifecycleStage,
  workspace: WorkspaceId,
) =>
  resolveOperationSetting(
    rows.filter((row) => !isOverride(row, operation, workspace)),
    setting,
    { workflow: codingWorkflow, operation, workspace },
  );

const asDisplayValue = (value: ReturnType<typeof resolveOperationSetting>) => {
  if (value === null) return null;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") return null;
  return value;
};

const effectiveValue = (
  controlStore: ControlStore | null,
  workspace: WorkspaceId,
  operation: LifecycleStage,
  setting: OperationSettingName,
) => {
  const rows = controlStore?.operationSettings ?? [];
  const stored = storedOverride(rows, setting, operation, workspace);
  const inherited = asDisplayValue(inheritedValue(rows, setting, operation, workspace));
  const fallback = setting === "permission-profile" ? defaultProfile(operation) : null;
  return {
    own: stored ? asDisplayValue(stored.value) : null,
    inherited: inherited ?? fallback,
  };
};

export const settingCell = (
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<HarnessCatalog>,
  workspace: WorkspaceId,
  operation: LifecycleStage,
  setting: OperationSettingName,
): SettingCell => {
  const { own, inherited } = effectiveValue(controlStore, workspace, operation, setting);
  const effective = own ?? inherited;
  return {
    own,
    inherited,
    effective,
    stale: isStale(setting, effective, controlStore, catalogs, workspace, operation),
  };
};

/** A saved choice absent from the current catalog is stale drift, never free-form input. */
const isStale = (
  setting: OperationSettingName,
  value: string | null,
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<HarnessCatalog>,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => {
  if (value === null) return false;
  if (setting === "harness") return catalogFor(catalogs, value) === null;
  if (setting !== "model" && setting !== "effort" && setting !== "permission-profile") return false;
  const resolved = (name: OperationSettingName) => {
    const { own, inherited } = effectiveValue(controlStore, workspace, operation, name);
    return own ?? inherited;
  };
  const harness = resolved("harness");
  if (harness === null) return false;
  const catalog = catalogFor(catalogs, harness);
  if (!catalog) return true;
  if (setting === "permission-profile") {
    return !catalog.policyProfiles.some((profile) => profile === value);
  }
  if (setting === "model") return !catalog.models.some((model) => model.value === value);
  return !(effortChoices(catalog, resolved("model")) ?? []).some((choice) => choice.value === value);
};

/** A one-line summary of an operation, for a collapsed row. */
export const operationSummaryLine = (
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<HarnessCatalog>,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => {
  const harness = settingCell(controlStore, catalogs, workspace, operation, "harness").effective;
  const model = settingCell(controlStore, catalogs, workspace, operation, "model").effective;
  const effort = settingCell(controlStore, catalogs, workspace, operation, "effort").effective;
  const catalog = catalogFor(catalogs, harness);
  const harnessLabel = harness && catalog ? providerLabel(harness) : harness;
  const modelLabel = catalog?.models.find((entry) => entry.value === model)?.label ?? model;
  const parts = [harnessLabel, modelLabel, effort].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length === 0 ? "Inherited" : parts.join(" · ");
};

const isModelOptions = Schema.is(Schema.Array(OperationModelOption));

const modelOptionsValue = (value: unknown) => (isModelOptions(value) ? value : []);

export const modelOptionSets = (
  controlStore: ControlStore | null,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => {
  const rows = controlStore?.operationSettings ?? [];
  const stored = storedOverride(rows, "model-options", operation, workspace);
  return {
    own: stored ? modelOptionsValue(stored.value) : null,
    inherited: modelOptionsValue(inheritedValue(rows, "model-options", operation, workspace)),
  };
};

/**
 * The whole set resolves as one value, so the set that wins answers for every option in it.
 * An option the winning set omits falls to the Harness, never to the set it replaced.
 */
export const modelOptionCell = (sets: ModelOptionSets, option: HarnessModelOption) => {
  const own = selectedModelOption(sets.own ?? [], option.id);
  const inherited = selectedModelOption(sets.inherited, option.id) ?? option.fallback;
  const effective = sets.own ? (own ?? option.fallback) : inherited;
  return {
    own,
    inherited,
    effective,
    stale: effective !== null && !option.choices.some((choice) => choice.value === effective),
  };
};

const overlayCell = <Setting extends OperationSettingName>(
  setting: Setting,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => ({
  setting,
  level: { _tag: "Operation" as const, workflow: codingWorkflow, operation },
  scope: { _tag: "PrivateWorkspaceOverlay" as const, workspace },
});

export const modelOptionsUpdate = (
  workspace: WorkspaceId,
  operation: LifecycleStage,
  value: ReadonlyArray<OperationModelOption> | null,
) => {
  const cell = overlayCell("model-options", workspace, operation);
  if (value === null || value.length === 0) return { _tag: "Clear", cell } as OperationSettingUpdate;
  return { _tag: "Set", row: { ...cell, value } } as OperationSettingUpdate;
};

/** The act that writes one setting, or clears it back onto the default. */
export const operationSettingUpdate = (
  workspace: WorkspaceId,
  operation: LifecycleStage,
  setting: OperationSettingName,
  value: string | null,
) => {
  const cell = overlayCell(setting, workspace, operation);
  if (value === null) return { _tag: "Clear", cell } as OperationSettingUpdate;
  // `enabled` is the one boolean in the family; every other setting is a string.
  const row = setting === "enabled" ? { ...cell, value: value === "true" } : { ...cell, value };
  return { _tag: "Set", row } as OperationSettingUpdate;
};
