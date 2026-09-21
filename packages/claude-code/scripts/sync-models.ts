import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const claudeBin = process.env.CLAUDE_CODE_BIN ?? "claude";
const target = fileURLToPath(new URL("../src/models.generated.ts", import.meta.url));
const check = process.argv.includes("--check");
const commandOptions = { encoding: "utf8", timeout: 5_000 } as const;
const effortValues = ["low", "medium", "high", "xhigh", "max"] as const;
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

const parseEffortValues = (help: string) =>
  help
    .match(/--effort <level>[\s\S]*?\(([^)]+)\)/)?.[1]
    ?.split(",")
    .map((value) => value.trim()) ?? [];

const render = (generatedAgainst: string) => {
  const renderedEffortValues = effortValues.map((value) => JSON.stringify(value)).join(", ");
  const renderedSpecs = modelSpecs
    .map(
      ([value, label, defaultModel, options]) =>
        `  [${JSON.stringify(value)}, ${JSON.stringify(label)}, ${defaultModel}, ${JSON.stringify(options)}],`,
    )
    .join("\n");
  return `import type {
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
export const claudeEfforts = [${renderedEffortValues}] as const;
const limitedEffort = ["low", "medium", "high", "max"] as const;
const optionsByKind = {
  full: [effortOption(claudeEfforts, "high"), contextOption],
  opus47: [effortOption(claudeEfforts, "xhigh"), contextOption],
  limited: [effortOption(limitedEffort, "high"), contextOption],
  none: undefined,
} as const;
const modelSpecs = [
${renderedSpecs}
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
  generatedAgainst: ${JSON.stringify(generatedAgainst)},
  rawModelIds: models.map(({ value }) => value),
  rawModelSelections: Object.fromEntries(
    models.map((entry) => [entry.value, { model: entry.value, options: defaultOptions(entry) }]),
  ),
} satisfies HarnessManagedCatalog;

export type ClaudeCatalogModel = (typeof claudeModelCatalog.models)[number]["value"];
`;
};

const version = execFileSync(claudeBin, ["--version"], commandOptions).trim();
const help = execFileSync(claudeBin, ["--help"], commandOptions);
const nativeEffortValues = parseEffortValues(help);
if (nativeEffortValues.join() !== effortValues.join()) {
  throw new Error(
    `Expected Claude effort levels ${effortValues.join(", ")}; received ${nativeEffortValues.join(", ")}`,
  );
}
const file = render(version);
if (!check) {
  writeFileSync(target, file);
  console.log(`Wrote ${modelSpecs.length} Claude models generated against ${version} to ${target}`);
  process.exit(0);
}
if (readFileSync(target, "utf8") === file) {
  console.log(`Claude model catalog is in sync (${modelSpecs.length} models, Claude Code ${version}).`);
  process.exit(0);
}
console.error(`Claude model catalog is stale. Run \`pnpm --filter @cogwork/claude-code models:sync\`.`);
process.exit(1);
