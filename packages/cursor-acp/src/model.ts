import {
  HarnessManagedCatalog,
  type HarnessManagedCatalogModel,
  HarnessModelOptionDescriptor,
} from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

export const cursorEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type CursorEffort = (typeof cursorEfforts)[number];

type CursorModelOptions = Readonly<Record<string, string | boolean>>;

interface CursorModelEntry {
  readonly id: string;
  readonly label: string;
  readonly default: boolean;
}

const effortSpecs = [
  { value: "minimal", label: "Minimal" },
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "extra-high", label: "Extra High" },
  { value: "max", label: "Max" },
] as const;

const effortOrder = effortSpecs.map(({ value }) => value);
const effortSuffixSpecs = effortSpecs.toSorted((left, right) => right.value.length - left.value.length);
const decodeManagedCatalog = Schema.decodeUnknownSync(HarnessManagedCatalog);

export type CursorNativeModelIdResult = Data.TaggedEnum<{
  Success: { readonly value: string };
  Failure: { readonly error: string };
}>;
export const CursorNativeModelIdResult = Data.taggedEnum<CursorNativeModelIdResult>();

interface CursorModelSelection {
  readonly model: string;
  readonly options: CursorModelOptions;
}

export type CursorModelSelectionResult = Data.TaggedEnum<{
  Success: { readonly value: CursorModelSelection };
  Failure: { readonly error: string };
}>;
export const CursorModelSelectionResult = Data.taggedEnum<CursorModelSelectionResult>();

const firstMatchingResult = <Result>(
  rules: ReadonlyArray<{ readonly when: boolean; readonly result: Result }>,
) => {
  const match = rules.find(({ when }) => when);
  if (!match) throw new Error("Expected a matching result rule");
  return match.result;
};

const parseCursorModelEntries = (output: string) =>
  output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\S+) - (.+)$/);
    const id = match?.[1];
    const label = match?.[2];
    const hasModelEntry = id !== undefined && label !== undefined;
    if (!hasModelEntry) return [];
    const isDefault = label.endsWith(" (default)");
    return [
      {
        id,
        label: isDefault ? label.slice(0, -" (default)".length) : label,
        default: isDefault,
      },
    ];
  });

export const parseCursorModelList = (output: string) => parseCursorModelEntries(output).map(({ id }) => id);

const decomposeCursorModelId = (id: string) => {
  const speed = id.endsWith("-fast");
  const withoutSpeed = speed ? id.slice(0, -"-fast".length) : id;
  const parts = withoutSpeed.split("-");
  const thinking = parts.includes("thinking");
  const withoutThinking = parts.filter((part) => part !== "thinking").join("-");
  const effort = effortSuffixSpecs.find(({ value }) => withoutThinking.endsWith(`-${value}`))?.value;
  const base = effort ? withoutThinking.slice(0, -`-${effort}`.length) : withoutThinking;
  return { base, effort, speed, thinking };
};

type DecomposedCursorModelEntry = CursorModelEntry &
  ReturnType<typeof decomposeCursorModelId> & { readonly context: boolean };

const labelContainsEffort = (label: string, effort: string) =>
  effortSpecs.some(({ value, label: effortLabel }) => {
    const isMatchingEffort = value === effort && label.includes(effortLabel);
    return isMatchingEffort;
  });

const modelLabel = (label: string) =>
  label
    .replace(/\s+(?:1M|Extra High|Minimal|None|Low|Medium|High|Max|Thinking|Fast)(?=\s|$|\()/g, "")
    .replace(/\s+/g, " ")
    .trim();

interface DefaultEffortContext {
  readonly implicit: string | undefined;
  readonly hasBareVariant: boolean;
  readonly values: ReadonlyArray<string>;
}

const defaultEffortRules = [
  {
    when: ({ implicit }: DefaultEffortContext) => implicit !== undefined,
    select: ({ implicit }: DefaultEffortContext) => implicit,
  },
  {
    when: ({ hasBareVariant, values }: DefaultEffortContext) => {
      const hasImplicitMedium = hasBareVariant && values.length > 0;
      return hasImplicitMedium;
    },
    select: () => "medium",
  },
] satisfies ReadonlyArray<{
  readonly when: (context: DefaultEffortContext) => boolean;
  readonly select: (context: DefaultEffortContext) => string | undefined;
}>;

const defaultEffortOf = (
  entries: ReadonlyArray<DecomposedCursorModelEntry>,
  values: ReadonlyArray<string>,
) => {
  const defaultEntry = entries.find(({ default: isDefault }) => isDefault);
  const markedDefault = defaultEntry?.effort ?? (defaultEntry ? "medium" : undefined);
  const implicit = entries.find(({ effort, label }) => {
    const hasUnlabelledEffort = effort !== undefined && !labelContainsEffort(label, effort);
    return hasUnlabelledEffort;
  })?.effort;
  const hasBareVariant = entries.some(({ effort }) => effort === undefined);
  const context = { implicit: markedDefault ?? implicit, hasBareVariant, values };
  return defaultEffortRules.find(({ when }) => when(context))?.select(context) ?? values[0];
};

const optionDescriptors = (entries: ReadonlyArray<DecomposedCursorModelEntry>) => {
  const explicitEfforts = effortOrder.filter((effort) => entries.some((entry) => entry.effort === effort));
  const hasBareVariant = entries.some(({ effort }) => effort === undefined);
  const needsImplicitMedium =
    explicitEfforts.length > 0 && hasBareVariant && !explicitEfforts.includes("medium");
  const effortValues = needsImplicitMedium
    ? effortOrder.filter((effort) => {
        const isAvailableEffort = effort === "medium" || explicitEfforts.includes(effort);
        return isAvailableEffort;
      })
    : explicitEfforts;
  const defaultEffort = defaultEffortOf(entries, effortValues);
  const defaultEntry =
    entries.find(({ default: isDefault }) => isDefault) ??
    entries.find(({ effort, speed, thinking }) => {
      const isDefaultVariant = effort === defaultEffort && !speed && !thinking;
      return isDefaultVariant;
    }) ??
    entries[0];
  const hasEffortOption = effortValues.length > 0 && defaultEffort !== undefined;
  const descriptors = [
    hasEffortOption
      ? {
          type: "select" as const,
          id: "effort",
          label: "Effort",
          values: effortValues.map((value) => ({
            value,
            label: effortSpecs.find((spec) => spec.value === value)?.label ?? value,
          })),
          defaultValue: defaultEffort,
        }
      : null,
    entries.some(({ speed }) => speed)
      ? {
          type: "boolean" as const,
          id: "speed",
          label: "Speed",
          defaultValue: defaultEntry?.speed ?? false,
        }
      : null,
    entries.some(({ context }) => context)
      ? {
          type: "boolean" as const,
          id: "context",
          label: "1M Context",
          defaultValue: defaultEntry?.context ?? false,
        }
      : null,
    entries.some(({ thinking }) => thinking)
      ? {
          type: "boolean" as const,
          id: "thinking",
          label: "Thinking",
          defaultValue: defaultEntry?.thinking ?? false,
        }
      : null,
  ].filter((descriptor) => descriptor !== null);
  return descriptors;
};

const catalogModel = (base: string, entries: ReadonlyArray<DecomposedCursorModelEntry>) => {
  const options = optionDescriptors(entries);
  const defaultEffort = options.find(({ id }) => id === "effort")?.defaultValue;
  const labelEntry =
    entries.find(({ effort, speed, thinking }) => {
      const isDefaultVariant = effort === defaultEffort && !speed && !thinking;
      return isDefaultVariant;
    }) ?? entries[0];
  return {
    value: base,
    label: modelLabel(labelEntry?.label ?? base),
    default: entries.some((entry) => entry.default),
    ...(options.length > 0 ? { options } : {}),
  } satisfies HarnessManagedCatalogModel;
};

export const createCursorModelCatalog = (output: string, generatedAgainst: string) => {
  const entries = parseCursorModelEntries(output).map((entry) => ({
    ...entry,
    ...decomposeCursorModelId(entry.id),
    context: /\b1M\b/.test(entry.label),
  }));
  const groups = Map.groupBy(entries, ({ base }) => base);
  const models = Array.from(groups, ([base, variants]) => {
    const isRecognizedGroup = variants.length > 1 || variants[0]?.id === base;
    if (isRecognizedGroup) return catalogModel(base, variants);
    const opaque = variants.map((entry) => ({
      ...entry,
      base: entry.id,
      effort: undefined,
      speed: false,
      thinking: false,
      context: false,
    }));
    return catalogModel(opaque[0]?.id ?? base, opaque);
  });
  const opaqueModelIds = models.filter(({ options }) => !options).map(({ value }) => value);
  const modelsByValue = new Map(models.map((model) => [model.value, model]));
  const rawModelSelections = Object.fromEntries(
    entries.map((entry) => {
      const model = modelsByValue.get(entry.base) ?? modelsByValue.get(entry.id);
      return [
        entry.id,
        {
          model: model?.value ?? entry.id,
          options: model?.options ? nativeOptions(model, entry) : {},
        },
      ];
    }),
  );
  const catalog = decodeManagedCatalog({
    models,
    generatedAgainst,
    rawModelIds: entries.map(({ id }) => id),
    rawModelSelections,
  } satisfies HarnessManagedCatalog);
  return { catalog, opaqueModelIds };
};

const resolvedOptions = (model: HarnessManagedCatalogModel, selections: CursorModelOptions) =>
  Object.fromEntries(
    (model.options ?? []).map((descriptor) => [
      descriptor.id,
      selections[descriptor.id] ?? descriptor.defaultValue,
    ]),
  );

const invalidSelection = (model: HarnessManagedCatalogModel, selections: CursorModelOptions) =>
  Object.entries(selections).find(([id, value]) => {
    const descriptor = model.options?.find((option) => option.id === id);
    if (!descriptor) return true;
    return HarnessModelOptionDescriptor.match(descriptor, {
      boolean: () => typeof value !== "boolean",
      select: ({ values }) => {
        const isUnknownValue = typeof value !== "string" || !values.some((choice) => choice.value === value);
        return isUnknownValue;
      },
    });
  });

const nativeOptions = (
  model: HarnessManagedCatalogModel,
  decomposed: ReturnType<typeof decomposeCursorModelId> & { readonly context?: boolean },
) => {
  const defaults = resolvedOptions(model, {});
  const optionIds = new Set(model.options?.map(({ id }) => id));
  const effort = optionIds.has("effort") ? (decomposed.effort ?? "medium") : undefined;
  return {
    ...defaults,
    ...(effort ? { effort } : {}),
    ...(optionIds.has("speed") ? { speed: decomposed.speed } : {}),
    ...(optionIds.has("context") ? { context: decomposed.context ?? false } : {}),
    ...(optionIds.has("thinking") ? { thinking: decomposed.thinking } : {}),
  };
};

const sameOptions = (left: CursorModelOptions, right: CursorModelOptions) => {
  const leftEntries = Object.entries(left);
  const hasSameEntries =
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([id, value]) => right[id] === value);
  return hasSameEntries;
};

export const cursorNativeModelId = (
  catalog: HarnessManagedCatalog,
  modelId: string,
  selections: CursorModelOptions,
) => {
  const model = catalog.models.find(({ value }) => value === modelId);
  const invalid = model ? invalidSelection(model, selections) : undefined;
  const options = model ? resolvedOptions(model, selections) : {};
  const nativeId = model
    ? catalog.rawModelIds.find((candidate) => {
        const candidateSelection = catalog.rawModelSelections[candidate];
        const isSelectedVariant =
          candidateSelection?.model === modelId && sameOptions(candidateSelection.options, options);
        return isSelectedVariant;
      })
    : undefined;
  const rules = [
    {
      when: model === undefined,
      result: CursorNativeModelIdResult.Failure({ error: `Cursor catalog has no model ${modelId}` }),
    },
    {
      when: invalid !== undefined,
      result: CursorNativeModelIdResult.Failure({
        error: `Cursor model ${modelId} does not declare option ${invalid?.[0] ?? "unknown"}`,
      }),
    },
    {
      when: nativeId === undefined,
      result: CursorNativeModelIdResult.Failure({
        error: `Cursor has no native model id for ${modelId} with the selected options`,
      }),
    },
    {
      when: true,
      result: CursorNativeModelIdResult.Success({ value: nativeId ?? modelId }),
    },
  ];
  return firstMatchingResult<CursorNativeModelIdResult>(rules);
};

export const cursorModelSelectionFromNativeId = (catalog: HarnessManagedCatalog, nativeId: string) => {
  const selection = catalog.rawModelSelections[nativeId];
  const model = catalog.models.find(({ value }) => value === selection?.model);
  const rules = [
    {
      when: !catalog.rawModelIds.includes(nativeId),
      result: CursorModelSelectionResult.Failure({
        error: `Cursor catalog does not contain native model id ${nativeId}`,
      }),
    },
    {
      when: model === undefined,
      result: CursorModelSelectionResult.Failure({
        error: `Cursor catalog cannot decompose native model id ${nativeId}`,
      }),
    },
    {
      when: true,
      result: CursorModelSelectionResult.Success({
        value: {
          model: model?.value ?? nativeId,
          options: selection?.options ?? {},
        },
      }),
    },
  ];
  return firstMatchingResult<CursorModelSelectionResult>(rules);
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const applyCursorEffort = (model: string, effort: string | null | undefined) => {
  if (!effort) return model;
  const match = model.match(/^([^[\]]+)\[(.*)\]$/);
  const base = match?.[1];
  const inner = match?.[2];
  if (!base || inner === undefined) return `${model}[effort=${effort}]`;
  const params = inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("effort="));
  return `${base}[${[...params, `effort=${effort}`].join(",")}]`;
};

export const cursorModelFlag = (model: string, effort: string | null | undefined) =>
  shellQuote(applyCursorEffort(model, effort));
