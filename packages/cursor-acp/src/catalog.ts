import * as Schema from "effect/Schema";

// Cursor answers `cursor/list_available_models` with parameterized base ids only for a client
// that declares this: https://cursor.com/docs/cli/acp#cursor-extension-methods
export const parameterizedModelPickerCapability = { parameterizedModelPicker: true } as const;

export const listAvailableModelsMethod = "cursor/list_available_models";

const CursorSelectChoice = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
});

const CursorSelectEntry = Schema.Union([
  CursorSelectChoice,
  Schema.Struct({ options: Schema.Array(CursorSelectChoice) }),
]);

const CursorConfigOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  category: Schema.optional(Schema.String),
  type: Schema.String,
  currentValue: Schema.optional(Schema.Union([Schema.String, Schema.Boolean])),
  options: Schema.optional(Schema.Array(CursorSelectEntry)),
});

type CursorConfigOption = typeof CursorConfigOption.Type;

const CursorAvailableModel = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  configOptions: Schema.optional(Schema.Array(CursorConfigOption)),
});

export const CursorAvailableModels = Schema.Struct({
  models: Schema.Array(CursorAvailableModel),
});

export type CursorAvailableModels = typeof CursorAvailableModels.Type;

export const decodeAvailableModels = Schema.decodeUnknownEffect(CursorAvailableModels);

// Cursor pads some choice names with zero-width spaces ("Fast\u200b\u200b"), which survive `trim`
// and reach the picker as invisible width.
const displayName = (value: string) => value.replace(/[\u200b-\u200d\ufeff]/g, "").trim();

const flattenChoices = (entries: ReadonlyArray<typeof CursorSelectEntry.Type>) =>
  entries.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), label: displayName(entry.name) }]
      : entry.options.map((option) => ({ value: option.value.trim(), label: displayName(option.name) })),
  );

const modelOption = (option: CursorConfigOption) => {
  const choices = flattenChoices(option.options ?? []).filter(
    (choice) => choice.value.length > 0 && choice.label.length > 0,
  );
  if (choices.length === 0) return [];
  return [
    {
      id: option.id.trim(),
      label: displayName(option.name) || option.id.trim(),
      choices,
      fallback: option.currentValue === undefined ? null : String(option.currentValue),
    },
  ];
};

export const catalogModels = (response: CursorAvailableModels) =>
  response.models
    .map((model) => ({
      value: model.value.trim(),
      label: displayName(model.name),
      options: (model.configOptions ?? []).flatMap(modelOption),
    }))
    .filter(
      (model, index, all) =>
        model.value !== "" &&
        model.label !== "" &&
        all.findIndex((candidate) => candidate.value === model.value) === index,
    );
