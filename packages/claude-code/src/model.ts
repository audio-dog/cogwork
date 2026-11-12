import {
  type HarnessManagedCatalog,
  type HarnessManagedCatalogModel,
  HarnessModelOptionDescriptor,
} from "@cogwork/contracts";
import * as Data from "effect/Data";

type ClaudeModelOptions = Readonly<Record<string, string | boolean>>;

interface ClaudeNativeSelection {
  readonly model: string;
  readonly effort?: string;
}

export type ClaudeNativeSelectionResult = Data.TaggedEnum<{
  Success: ClaudeNativeSelection;
  Failure: { readonly error: string };
}>;
export const ClaudeNativeSelectionResult = Data.taggedEnum<ClaudeNativeSelectionResult>();

const firstMatchingResult = <Result>(
  rules: ReadonlyArray<{ readonly when: boolean; readonly result: Result }>,
) => {
  const match = rules.find(({ when }) => when);
  if (!match) throw new Error("Expected a matching result rule");
  return match.result;
};

const resolvedOptions = (model: HarnessManagedCatalogModel, selections: ClaudeModelOptions) =>
  Object.fromEntries(
    (model.options ?? []).map((descriptor) => [
      descriptor.id,
      selections[descriptor.id] ?? descriptor.defaultValue,
    ]),
  );

const selectionError = (model: HarnessManagedCatalogModel, selections: ClaudeModelOptions) =>
  Object.entries(selections)
    .flatMap(([id, value]) => {
      const descriptor = model.options?.find((option) => option.id === id);
      if (!descriptor) return [`Claude model ${model.value} does not declare option ${id}`];
      const valid = HarnessModelOptionDescriptor.match(descriptor, {
        boolean: () => typeof value === "boolean",
        select: ({ values }) => {
          const isDeclaredValue =
            typeof value === "string" && values.some((choice) => choice.value === value);
          return isDeclaredValue;
        },
      });
      return valid
        ? []
        : [`Claude model ${model.value} option ${id} does not allow ${JSON.stringify(value)}`];
    })
    .at(0);

export const claudeNativeSelection = (
  catalog: HarnessManagedCatalog,
  modelId: string | null,
  selections: ClaudeModelOptions,
) => {
  const selectedModelId = modelId ?? catalog.models.find(({ default: isDefault }) => isDefault)?.value;
  const model = catalog.models.find(({ value }) => value === selectedModelId);
  const invalid = model ? selectionError(model, selections) : undefined;
  const options = model ? resolvedOptions(model, selections) : {};
  const nativeModelValue = model?.value ?? selectedModelId ?? "default";
  const nativeModel = options.context === true ? `${nativeModelValue}[1m]` : nativeModelValue;
  const effort = options.effort;
  const rules = [
    {
      when: model === undefined,
      result: ClaudeNativeSelectionResult.Failure({
        error: `Claude catalog has no model ${selectedModelId ?? "default"}`,
      }),
    },
    {
      when: invalid !== undefined,
      result: ClaudeNativeSelectionResult.Failure({ error: invalid ?? "Invalid Claude model selection" }),
    },
    {
      when: true,
      result: ClaudeNativeSelectionResult.Success({
        model: nativeModel,
        ...(typeof effort === "string" ? { effort } : {}),
      }),
    },
  ];
  return firstMatchingResult<ClaudeNativeSelectionResult>(rules);
};
