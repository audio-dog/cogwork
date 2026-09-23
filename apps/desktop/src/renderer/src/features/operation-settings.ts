import {
  type ControlStore,
  defaultPermissionProfile,
  type HarnessCatalog,
  type HarnessCatalogChoice,
  HarnessModelOptionDescriptor,
  type HarnessName,
  type HarnessOptionCatalog,
  type HarnessReadiness,
  HarnessState,
  harnessEnabled,
  harnessModelOptionAccepts,
  LifecycleStage,
  ModelOptionSelections,
  type OperationSettingBatch,
  type OperationSettingName,
  type OperationSettingRow,
  OperationSettingUpdate,
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

export type AvailableHarnessCatalog = HarnessOptionCatalog & { readonly harness: HarnessName };

export interface ProviderAvailability {
  readonly pickable: boolean;
  readonly stateLabel: string;
  readonly reason: string | null;
}

export type ProviderPickerCatalog = AvailableHarnessCatalog & {
  readonly availability: ProviderAvailability;
};

export interface ModelOptionsCell {
  readonly own: ModelOptionSelections | null;
  readonly inherited: ModelOptionSelections | null;
  readonly effective: ModelOptionSelections;
}

export interface ModelOptionState {
  readonly descriptor: NonNullable<HarnessCatalogChoice["options"]>[number];
  readonly value: string | boolean;
  readonly source: "own" | "inherited" | "default" | "stale";
  readonly staleValue?: string | boolean;
}

export const availableHarnessCatalogs = (catalogs: ReadonlyArray<HarnessCatalog> | null) =>
  catalogs?.map(({ harness, catalog }) => ({ harness, ...catalog })) ?? [];

const catalogLoadRules = [
  {
    when: (catalogs: ReadonlyArray<HarnessCatalog> | null, _failed: boolean) => catalogs !== null,
    produce: (catalogs: ReadonlyArray<HarnessCatalog> | null) => ({
      status: "ready" as const,
      catalogs: availableHarnessCatalogs(catalogs),
    }),
  },
  {
    when: (_catalogs: ReadonlyArray<HarnessCatalog> | null, failed: boolean) => failed,
    produce: () => ({ status: "failed" as const }),
  },
] as const;

export const harnessCatalogLoad = (catalogs: ReadonlyArray<HarnessCatalog> | null, failed: boolean) =>
  catalogLoadRules.find(({ when }) => when(catalogs, failed))?.produce(catalogs) ?? {
    status: "loading" as const,
  };

export const catalogFor = <Catalog extends AvailableHarnessCatalog>(
  catalogs: ReadonlyArray<Catalog>,
  harness: string | null,
) => catalogs.find((candidate) => candidate.harness === harness) ?? null;

export const selectableHarnessCatalogs = <Catalog extends AvailableHarnessCatalog>(
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<Catalog>,
) =>
  catalogs.filter((catalog) =>
    controlStore ? harnessEnabled(controlStore.harnessSettings, catalog.harness) : true,
  );

const pendingProviderAvailability: ProviderAvailability = {
  pickable: true,
  stateLabel: "Not checked yet",
  reason: "Readiness check pending",
};

const providerAvailability = (readiness: HarnessReadiness, state: HarnessState) =>
  HarnessState.match<ProviderAvailability>({
    Ready: () => ({ pickable: true, stateLabel: "Ready", reason: null }),
    NotInstalled: ({ diagnostic }) => ({
      pickable: false,
      stateLabel: "Not installed",
      reason: diagnostic,
    }),
    UnsupportedVersion: ({ requirement }) => ({
      pickable: false,
      stateLabel: "Version not supported",
      reason: requirement ? `Requires ${requirement}` : "Installed version is not supported",
    }),
    NotSignedIn: ({ signIn }) => ({
      pickable: false,
      stateLabel: "Not signed in",
      reason: signIn ? `Run ${signIn.command}` : "Authentication required",
    }),
    Unavailable: ({ diagnostic }) => ({
      pickable: false,
      stateLabel: "Unavailable",
      reason: diagnostic,
    }),
    Unknown: ({ diagnostic }) =>
      readiness.checkedAtMillis === 0
        ? pendingProviderAvailability
        : {
            pickable: false,
            stateLabel: "Readiness unknown",
            reason: diagnostic,
          },
  })(state);

export const providerPickerCatalogs = (
  catalogs: ReadonlyArray<AvailableHarnessCatalog>,
  readiness: HarnessReadiness | null,
) =>
  catalogs.map((catalog) => {
    const readinessItem = readiness?.harnesses.find(({ harness }) => harness === catalog.harness);
    const availability =
      readinessItem && readiness
        ? providerAvailability(readiness, readinessItem.state)
        : pendingProviderAvailability;
    return { ...catalog, availability } satisfies ProviderPickerCatalog;
  });

export const harnessIsDisabled = (controlStore: ControlStore | null, harness: string | null) => {
  if (!controlStore || !harness) return false;
  return controlStore.harnessSettings.some((setting) => setting.harness === harness && !setting.enabled);
};

export const unavailableHarnessLabel = (harness: string | null, disabled: boolean) => {
  if (!harness) return "No Harness enabled";
  if (disabled) return `${harness} · disabled`;
  return `${harness} · no longer offered`;
};

export const catalogChoiceLabel = (choices: ReadonlyArray<HarnessCatalogChoice>, value: string | null) =>
  value === null ? "Not set" : (choices.find((choice) => choice.value === value)?.label ?? value);

export const catalogChoiceMatches = (choice: HarnessCatalogChoice, query: string) => {
  const needle = query.trim().toLowerCase();
  return choice.label.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle);
};

const policyProfileLabels: Record<RunPlanPolicyProfile, string> = {
  "read-only": "Read only",
  full: "Full",
};

export const policyProfileChoices = (catalog: AvailableHarnessCatalog | null) =>
  catalog?.policyProfiles.map((value) => ({ value, label: policyProfileLabels[value] })) ?? [];

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

export type DisplayedOperationSettingName = Exclude<OperationSettingName, "bindings" | "model-options">;

export type OperationSettingChange =
  | { readonly setting: DisplayedOperationSettingName; readonly value: string | null }
  | { readonly setting: "model-options"; readonly value: ModelOptionSelections | null };

export type OperationSettingChanges = readonly [
  OperationSettingChange,
  ...ReadonlyArray<OperationSettingChange>,
];

type OperationSettingWriteName = OperationSettingChange["setting"];
type OperationSettingWriteValue = string | ModelOptionSelections;
type OperationSettingRowBase = Pick<
  Extract<OperationSettingRow, { readonly setting: "model" }>,
  "level" | "scope"
>;

const operationSettingRowProducers: Record<
  OperationSettingWriteName,
  (base: OperationSettingRowBase, value: OperationSettingWriteValue) => OperationSettingRow
> = {
  enabled: (base, value) => ({ ...base, setting: "enabled", value: value === "true" }),
  harness: (base, value) => ({
    ...base,
    setting: "harness",
    value: typeof value === "string" ? value : "",
  }),
  model: (base, value) => ({
    ...base,
    setting: "model",
    value: typeof value === "string" ? value : "",
  }),
  "model-options": (base, value) => ({
    ...base,
    setting: "model-options",
    value: typeof value === "object" ? value : {},
  }),
  "permission-profile": (base, value) => ({
    ...base,
    setting: "permission-profile",
    value: typeof value === "string" ? value : "",
  }),
};

export const harnessSelectionUpdates = (
  currentHarness: string | null,
  harness: string | null,
  model: string | null,
) => {
  const profileReset: ReadonlyArray<OperationSettingChange> =
    currentHarness === harness ? [] : [{ setting: "permission-profile", value: null }];
  const restoresInheritedSelection = harness === null && model === null;
  return [
    { setting: "harness", value: harness },
    { setting: "model", value: model },
    { setting: "model-options", value: restoresInheritedSelection ? null : {} },
    ...profileReset,
  ] satisfies OperationSettingChanges;
};

const isOverride = (row: OperationSettingRow, operation: LifecycleStage, workspace: WorkspaceId) =>
  row.level._tag === "Operation" &&
  row.level.workflow === codingWorkflow &&
  row.level.operation === operation &&
  row.scope._tag === "PrivateWorkspaceOverlay" &&
  row.scope.workspace === workspace;

const asDisplayValue = (value: ReturnType<typeof resolveOperationSetting>) => {
  if (value === null) return null;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") return null;
  return value;
};

const resolvedSettingValues = (
  controlStore: ControlStore | null,
  workspace: WorkspaceId,
  operation: LifecycleStage,
  setting: DisplayedOperationSettingName,
) => {
  const rows = controlStore?.operationSettings ?? [];
  const context = { workflow: codingWorkflow, operation, workspace };
  const inherited = asDisplayValue(
    resolveOperationSetting(
      rows.filter((row) => !isOverride(row, operation, workspace)),
      setting,
      context,
    ),
  );
  const stored = rows.find((row) => row.setting === setting && isOverride(row, operation, workspace));
  const own = stored ? asDisplayValue(stored.value) : null;
  const effective = own ?? inherited;
  return {
    own,
    inherited,
    effective,
  };
};

const permissionProfileDefault = (
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<AvailableHarnessCatalog>,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => {
  const harness = resolvedSettingValues(controlStore, workspace, operation, "harness").effective;
  const profiles = catalogFor(catalogs, harness)?.policyProfiles ?? [];
  return defaultPermissionProfile(operation, profiles);
};

interface SettingDefaultContext {
  controlStore: ControlStore | null;
  catalogs: ReadonlyArray<AvailableHarnessCatalog>;
  workspace: WorkspaceId;
  operation: LifecycleStage;
}

const nullDefault = () => null;

const settingDefaults = {
  enabled: nullDefault,
  harness: nullDefault,
  model: nullDefault,
  "permission-profile": ({ controlStore, catalogs, workspace, operation }: SettingDefaultContext) =>
    permissionProfileDefault(controlStore, catalogs, workspace, operation),
} satisfies Record<DisplayedOperationSettingName, (context: SettingDefaultContext) => string | null>;

export const settingCell = (
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<AvailableHarnessCatalog>,
  workspace: WorkspaceId,
  operation: LifecycleStage,
  setting: DisplayedOperationSettingName,
) => {
  const resolved = resolvedSettingValues(controlStore, workspace, operation, setting);
  const fallback = settingDefaults[setting]({ controlStore, catalogs, workspace, operation });
  const values = {
    own: resolved.own,
    inherited: resolved.inherited ?? fallback,
    effective: resolved.own ?? resolved.inherited ?? fallback,
  };
  return {
    ...values,
    stale: isStale(setting, values.effective, controlStore, catalogs, workspace, operation),
  };
};

const asModelOptionSelections = (value: ReturnType<typeof resolveOperationSetting>) =>
  Schema.is(ModelOptionSelections)(value) ? value : null;

export const modelOptionsCell = (
  controlStore: ControlStore | null,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => {
  const rows = controlStore?.operationSettings ?? [];
  const context = { workflow: codingWorkflow, operation, workspace };
  const inherited = asModelOptionSelections(
    resolveOperationSetting(
      rows.filter((row) => !isOverride(row, operation, workspace)),
      "model-options",
      context,
    ),
  );
  const isStoredModelOptionsOverride = (row: OperationSettingRow) =>
    row.setting === "model-options" && isOverride(row, operation, workspace);
  const stored = rows.find(isStoredModelOptionsOverride);
  const own = stored?.setting === "model-options" ? stored.value : null;
  return { own, inherited, effective: own ?? inherited ?? {} } satisfies ModelOptionsCell;
};

const modelOptionSources = [
  { source: "own", selections: (cell: ModelOptionsCell) => cell.own },
  { source: "inherited", selections: (cell: ModelOptionsCell) => cell.inherited },
] satisfies ReadonlyArray<{
  readonly source: Exclude<ModelOptionState["source"], "default" | "stale">;
  readonly selections: (cell: ModelOptionsCell) => ModelOptionSelections | null;
}>;

const modelOptionSource = (
  isStale: boolean,
  storedSource: Exclude<ModelOptionState["source"], "default" | "stale"> | undefined,
  usesStoredSelection: boolean,
) => {
  const sources = [
    { matches: isStale, value: "stale" },
    { matches: usesStoredSelection, value: storedSource ?? "default" },
    { matches: true, value: "default" },
  ] satisfies ReadonlyArray<{ readonly matches: boolean; readonly value: ModelOptionState["source"] }>;
  return sources.find(({ matches }) => matches)?.value ?? "default";
};

export const modelOptionStates = (model: HarnessCatalogChoice, cell: ModelOptionsCell) =>
  (model.options ?? []).map((descriptor) => {
    const selected = cell.effective[descriptor.id];
    const isSelected = harnessModelOptionAccepts(descriptor, selected);
    const hasEffectiveSelection = Object.hasOwn(cell.effective, descriptor.id);
    const isStale = hasEffectiveSelection && !isSelected;
    const source = modelOptionSources.find(({ selections }) => selections(cell) !== null);
    const storedSelections = source?.selections(cell);
    const hasStoredSelection = storedSelections ? Object.hasOwn(storedSelections, descriptor.id) : false;
    const usesStoredSelection = isSelected && source !== undefined && hasStoredSelection;
    return {
      descriptor,
      value: isSelected ? selected : descriptor.defaultValue,
      source: modelOptionSource(isStale, source?.source, usesStoredSelection),
      ...(isStale ? { staleValue: selected } : {}),
    } satisfies ModelOptionState;
  });

export const modelOptionLabel = (option: ModelOptionState) => {
  const current = HarnessModelOptionDescriptor.match(option.descriptor, {
    boolean: ({ label }) => (option.value === true ? label : `${label} Off`),
    select: ({ values }) => values.find(({ value }) => value === option.value)?.label ?? String(option.value),
  });
  return option.staleValue === undefined
    ? current
    : `${option.descriptor.label}: ${String(option.staleValue)}`;
};

export const modelOptionSummary = (options: ReadonlyArray<ModelOptionState>) =>
  options.map(modelOptionLabel).join(" · ");

const matchingOptionCount = (candidate: ModelOptionSelections, current: ModelOptionSelections) =>
  Object.entries(current).filter(([id, value]) => candidate[id] === value).length;

export const modelOptionChoice = (
  catalog: HarnessOptionCatalog,
  model: HarnessCatalogChoice,
  current: ModelOptionSelections,
  id: string,
  value: string | boolean,
) => {
  const requested = { ...current, [id]: value };
  if (!catalog.rawModelSelections) return requested;
  const matchesChoice = (selection: (typeof catalog.rawModelSelections)[string]) =>
    selection.model === model.value && selection.options[id] === value;
  return Object.values(catalog.rawModelSelections)
    .filter(matchesChoice)
    .toSorted(
      (left, right) =>
        matchingOptionCount(right.options, requested) - matchingOptionCount(left.options, requested),
    )[0]?.options;
};

export const modelOptionUpdates = (model: HarnessCatalogChoice, options: ModelOptionSelections) =>
  [
    { setting: "model", value: model.value },
    { setting: "model-options", value: options },
  ] satisfies OperationSettingChanges;

/** A saved choice absent from the current catalog is stale drift, never free-form input. */
interface StaleSelection {
  readonly value: string;
  controlStore: ControlStore | null;
  catalogs: ReadonlyArray<AvailableHarnessCatalog>;
  workspace: WorkspaceId;
  operation: LifecycleStage;
}

const catalogChoiceIsStale = (selection: StaleSelection) => {
  const { value, controlStore, catalogs, workspace, operation } = selection;
  const harness = resolvedSettingValues(controlStore, workspace, operation, "harness").effective;
  if (harness === null) return false;
  const options = catalogFor(catalogs, harness)?.models ?? [];
  return !options.some((option) => option.value === value);
};

const staleChecks = {
  enabled: () => false,
  harness: ({ value, catalogs }: StaleSelection) => catalogFor(catalogs, value) === null,
  model: catalogChoiceIsStale,
  "permission-profile": ({ value, controlStore, catalogs, workspace, operation }: StaleSelection) => {
    const harness = resolvedSettingValues(controlStore, workspace, operation, "harness").effective;
    return !catalogFor(catalogs, harness)?.policyProfiles.some((profile) => profile === value);
  },
} satisfies Record<DisplayedOperationSettingName, (selection: StaleSelection) => boolean>;

const isStale = (
  setting: DisplayedOperationSettingName,
  value: string | null,
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<AvailableHarnessCatalog>,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => (value === null ? false : staleChecks[setting]({ value, controlStore, catalogs, workspace, operation }));

/** A one-line summary of an operation, for a collapsed row. */
export const operationSummaryLine = (
  controlStore: ControlStore | null,
  catalogs: ReadonlyArray<AvailableHarnessCatalog>,
  workspace: WorkspaceId,
  operation: LifecycleStage,
) => {
  const harness = settingCell(controlStore, catalogs, workspace, operation, "harness").effective;
  const model = settingCell(controlStore, catalogs, workspace, operation, "model").effective;
  const harnessLabel = harness && catalogFor(catalogs, harness) ? providerLabel(harness) : harness;
  const parts = [harnessLabel, model].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length === 0 ? "Inherited" : parts.join(" · ");
};

/** The act that writes one setting, or clears it back onto the default. */
export const operationSettingUpdate = (
  workspace: WorkspaceId,
  operation: LifecycleStage,
  setting: OperationSettingChange["setting"],
  value: string | ModelOptionSelections | null,
) => {
  const level = { _tag: "Operation" as const, workflow: codingWorkflow, operation };
  const scope = { _tag: "PrivateWorkspaceOverlay" as const, workspace };
  if (value === null) return OperationSettingUpdate.cases.Clear.make({ cell: { setting, level, scope } });
  const row = operationSettingRowProducers[setting]({ level, scope }, value);
  return OperationSettingUpdate.cases.Set.make({ row });
};

export const operationSettingBatch = (
  workspace: WorkspaceId,
  operation: LifecycleStage,
  [first, ...rest]: OperationSettingChanges,
) =>
  [
    operationSettingUpdate(workspace, operation, first.setting, first.value),
    ...rest.map(({ setting, value }) => operationSettingUpdate(workspace, operation, setting, value)),
  ] satisfies OperationSettingBatch;
