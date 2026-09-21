import type { HarnessManagedCatalog, HarnessModelOptionDescriptor } from "@cogwork/contracts";

type SelectOption = Extract<HarnessModelOptionDescriptor, { type: "select" }>;

const codexEffortChoices = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

export const codexEfforts = codexEffortChoices.map(({ value }) => value);

const effortOption = {
  type: "select",
  id: "effort",
  label: "Effort",
  values: codexEffortChoices,
  defaultValue: "high",
} as const satisfies SelectOption;

export const codexModels = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1",
] as const;

export const defaultCodexModel = codexModels[0];

export const codexCatalog = {
  generatedAgainst: "0.154.0",
  models: codexModels.map((value) => ({
    value,
    label: value,
    default: value === defaultCodexModel,
    options: [effortOption],
  })),
  rawModelIds: codexModels,
  rawModelSelections: Object.fromEntries(
    codexModels.map((model) => [model, { model, options: { effort: effortOption.defaultValue } }]),
  ),
} satisfies HarnessManagedCatalog;

export type CodexEffort = (typeof codexEffortChoices)[number]["value"];
export type CodexModel = (typeof codexModels)[number];
