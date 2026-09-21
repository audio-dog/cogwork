import type {
  HarnessManagedCatalog,
  HarnessManagedCatalogModel,
  HarnessModelOptionDescriptor,
} from "@cogwork/contracts";

type SelectOption = Extract<HarnessModelOptionDescriptor, { type: "select" }>;
const effortLabels = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} as const;
const effortOption = (values: ReadonlyArray<keyof typeof effortLabels>, defaultValue: string) =>
  ({
    type: "select" as const,
    id: "effort",
    label: "Effort",
    values: values.map((value) => ({ value, label: effortLabels[value] })),
    defaultValue,
  }) satisfies SelectOption;
const contextOption = {
  type: "boolean",
  id: "context",
  label: "1M Context",
  defaultValue: false,
} as const;
export const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
const limitedEffort = ["low", "medium", "high", "max"] as const;
const optionsByKind = {
  full: [effortOption(claudeEfforts, "high"), contextOption],
  opus47: [effortOption(claudeEfforts, "xhigh"), contextOption],
  limited: [effortOption(limitedEffort, "high"), contextOption],
  none: undefined,
} as const;
const modelSpecs = [
  ["sonnet", "Sonnet", true, "full"],
  ["opus", "Opus", false, "full"],
  ["haiku", "Haiku", false, "none"],
  ["fable", "Fable", false, "full"],
  ["best", "Best", false, "full"],
  ["claude-fable-5-1", "Claude Fable 5.1", false, "full"],
  ["claude-fable-5", "Claude Fable 5", false, "full"],
  ["claude-opus-5", "Claude Opus 5", false, "full"],
  ["claude-opus-4-8", "Claude Opus 4.8", false, "full"],
  ["claude-opus-4-7", "Claude Opus 4.7", false, "opus47"],
  ["claude-opus-4-6", "Claude Opus 4.6", false, "limited"],
  ["claude-sonnet-5", "Claude Sonnet 5", false, "full"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", false, "limited"],
  ["claude-haiku-4-5", "Claude Haiku 4.5", false, "none"],
] as const;
const models = modelSpecs.map(([value, label, defaultModel, options]) => ({
  value,
  label,
  default: defaultModel,
  ...(optionsByKind[options] ? { options: optionsByKind[options] } : {}),
})) satisfies ReadonlyArray<HarnessManagedCatalogModel>;
const defaultOptions = (entry: HarnessManagedCatalogModel) =>
  Object.fromEntries((entry.options ?? []).map(({ id, defaultValue }) => [id, defaultValue]));

export const claudeModelCatalog = {
  models,
  generatedAgainst: "2.1.273 (Claude Code)",
  rawModelIds: models.map(({ value }) => value),
  rawModelSelections: Object.fromEntries(
    models.map((entry) => [entry.value, { model: entry.value, options: defaultOptions(entry) }]),
  ),
} satisfies HarnessManagedCatalog;

export type ClaudeCatalogModel = (typeof claudeModelCatalog.models)[number]["value"];
