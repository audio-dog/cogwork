import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString } from "./base-schemas";
import { ModelOptionSelections, RunPlanPolicyProfile } from "./settings";

export class HarnessEnablement extends Schema.Class<HarnessEnablement>("HarnessEnablement")({
  harness: HarnessName,
  enabled: Schema.Boolean,
}) {}

export const harnessEnabled = (settings: ReadonlyArray<HarnessEnablement>, harness: HarnessName) =>
  settings.find((setting) => setting.harness === harness)?.enabled ?? true;

export class HarnessNotRegistered extends Schema.TaggedError<HarnessNotRegistered>()("HarnessNotRegistered", {
  harness: HarnessName,
}) {}

/** Cogwork never runs this: the credential is harness-owned, so a person runs it themselves. */
export class HarnessSignIn extends Schema.Class<HarnessSignIn>("HarnessSignIn")({
  command: TrimmedNonEmptyString,
}) {}

/** Folded in the engine, so no client re-derives it from the four axes readiness observes. */
export const HarnessState = Schema.TaggedUnion({
  Ready: {},
  NotInstalled: { diagnostic: TrimmedNonEmptyString },
  UnsupportedVersion: { requirement: Schema.NullOr(TrimmedNonEmptyString) },
  NotSignedIn: { signIn: Schema.NullOr(HarnessSignIn) },
  /** Installed, supported and signed in, and still cannot run. */
  Unavailable: { diagnostic: TrimmedNonEmptyString },
  /** The probe could not reach a conclusion. */
  Unknown: { diagnostic: TrimmedNonEmptyString },
});
export type HarnessState = typeof HarnessState.Type;

export const HarnessCatalogProvenance = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("tanstack-runtime"),
    packageVersion: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    source: Schema.Literal("native-discovery"),
    runtimeHost: TrimmedNonEmptyString,
    harnessVersion: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    source: Schema.Literal("cogwork-fallback"),
    fallbackVersion: TrimmedNonEmptyString,
  }),
]).pipe(Schema.toTaggedUnion("source"));
export type HarnessCatalogProvenance = typeof HarnessCatalogProvenance.Type;

const HarnessModelOptionValue = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});

interface SelectOptionShape {
  readonly values: ReadonlyArray<{ readonly value: string }>;
  readonly defaultValue: string;
}

const validSelectOption = Schema.makeFilter((descriptor: SelectOptionShape) => {
  const values = descriptor.values.map(({ value }) => value);
  const hasValidValues =
    values.length > 0 && new Set(values).size === values.length && values.includes(descriptor.defaultValue);
  return hasValidValues ? undefined : "Expected unique values containing the default value";
});

export const HarnessModelOptionDescriptor = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("select"),
    id: TrimmedNonEmptyString,
    label: TrimmedNonEmptyString,
    values: Schema.Array(HarnessModelOptionValue),
    defaultValue: TrimmedNonEmptyString,
  }).check(validSelectOption),
  Schema.Struct({
    type: Schema.Literal("boolean"),
    id: TrimmedNonEmptyString,
    label: TrimmedNonEmptyString,
    defaultValue: Schema.Boolean,
  }),
]).pipe(Schema.toTaggedUnion("type"));
export type HarnessModelOptionDescriptor = typeof HarnessModelOptionDescriptor.Type;

export const harnessModelOptionAccepts = (
  descriptor: HarnessModelOptionDescriptor,
  value: string | boolean | undefined,
) =>
  HarnessModelOptionDescriptor.match(descriptor, {
    boolean: () => typeof value === "boolean",
    select: ({ values }) => {
      const isAllowedSelectValue =
        typeof value === "string" && values.some((choice) => choice.value === value);
      return isAllowedSelectValue;
    },
  });

const HarnessCatalogModelFields = {
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  options: Schema.optionalKey(Schema.Array(HarnessModelOptionDescriptor)),
};

const HarnessRawModelSelection = Schema.Struct({
  model: TrimmedNonEmptyString,
  options: ModelOptionSelections,
});

export class HarnessCatalogChoice extends Schema.Class<HarnessCatalogChoice>("HarnessCatalogChoice")({
  ...HarnessCatalogModelFields,
  default: Schema.optionalKey(Schema.Boolean),
}) {}

export const selectedHarnessCatalogModel = (
  models: ReadonlyArray<HarnessCatalogChoice>,
  selected: string | null,
) =>
  selected
    ? models.find(({ value }) => value === selected)
    : (models.find(({ default: isDefault }) => isDefault) ?? models[0]);

export const unsupportedHarnessModelOption = (
  model: HarnessCatalogChoice | undefined,
  options: ModelOptionSelections,
) =>
  Object.entries(options).find(([id, value]) => {
    const descriptor = model?.options?.find((candidate) => candidate.id === id);
    const isUnsupported = descriptor === undefined || !harnessModelOptionAccepts(descriptor, value);
    return isUnsupported;
  });

export class HarnessManagedCatalogModel extends Schema.Class<HarnessManagedCatalogModel>(
  "HarnessManagedCatalogModel",
)({
  ...HarnessCatalogModelFields,
  default: Schema.Boolean,
}) {}

interface ManagedCatalogShape {
  readonly models: ReadonlyArray<{
    readonly value: string;
    readonly default: boolean;
    readonly options?: ReadonlyArray<HarnessModelOptionDescriptor>;
  }>;
  readonly rawModelIds: ReadonlyArray<string>;
  readonly rawModelSelections: Readonly<
    Record<string, { readonly model: string; readonly options: Readonly<Record<string, string | boolean>> }>
  >;
}

const validManagedCatalog = Schema.makeFilter((catalog: ManagedCatalogShape) => {
  const modelIds = catalog.models.map(({ value }) => value);
  const modelsById = new Map(catalog.models.map((model) => [model.value, model]));
  const hasUniqueModels = new Set(modelIds).size === modelIds.length;
  const hasOneDefault = catalog.models.filter(({ default: isDefault }) => isDefault).length === 1;
  const hasUniqueOptionIds = catalog.models.every(({ options = [] }) => {
    const optionIds = options.map(({ id }) => id);
    return new Set(optionIds).size === optionIds.length;
  });
  const hasUniqueRawIds = new Set(catalog.rawModelIds).size === catalog.rawModelIds.length;
  const optionOracleIds = Object.keys(catalog.rawModelSelections);
  const hasCompleteOptionOracle =
    optionOracleIds.length === catalog.rawModelIds.length &&
    optionOracleIds.every((id) => catalog.rawModelIds.includes(id));
  const hasValidSelections = Object.values(catalog.rawModelSelections).every((selection) => {
    const model = modelsById.get(selection.model);
    if (!model) return false;
    const descriptors = model.options ?? [];
    const optionIds = Object.keys(selection.options);
    const hasExactOptions =
      optionIds.length === descriptors.length &&
      descriptors.every(({ id }) => Object.hasOwn(selection.options, id));
    const hasValidValues = descriptors.every((descriptor) =>
      harnessModelOptionAccepts(descriptor, selection.options[descriptor.id]),
    );
    const isValidSelection = hasExactOptions && hasValidValues;
    return isValidSelection;
  });
  const selectionFingerprints = Object.values(catalog.rawModelSelections).map((selection) => {
    const descriptors = modelsById.get(selection.model)?.options ?? [];
    const values = descriptors.map(({ id }) => selection.options[id]);
    return JSON.stringify([selection.model, values]);
  });
  const hasUniqueSelections = new Set(selectionFingerprints).size === selectionFingerprints.length;
  const isValid =
    hasUniqueModels &&
    hasOneDefault &&
    hasUniqueOptionIds &&
    hasUniqueRawIds &&
    hasCompleteOptionOracle &&
    hasValidSelections &&
    hasUniqueSelections;
  return isValid
    ? undefined
    : "Expected unique ids, valid raw model selections, and exactly one default model";
});

export class HarnessManagedCatalog extends Schema.Class<HarnessManagedCatalog>("HarnessManagedCatalog")(
  Schema.Struct({
    models: Schema.Array(HarnessManagedCatalogModel),
    generatedAgainst: TrimmedNonEmptyString,
    rawModelIds: Schema.Array(TrimmedNonEmptyString),
    rawModelSelections: Schema.Record(TrimmedNonEmptyString, HarnessRawModelSelection),
  }).check(validManagedCatalog),
) {}

export class HarnessOptionCatalog extends Schema.Class<HarnessOptionCatalog>("HarnessOptionCatalog")({
  models: Schema.Array(HarnessCatalogChoice),
  generatedAgainst: Schema.optionalKey(TrimmedNonEmptyString),
  rawModelIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  policyProfiles: Schema.Array(RunPlanPolicyProfile),
  provenance: HarnessCatalogProvenance,
}) {}

export class HarnessItem extends Schema.Class<HarnessItem>("HarnessItem")({
  harness: HarnessName,
  enabled: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  /** As the Harness reported it, so a non-semver release tag survives. */
  version: Schema.NullOr(TrimmedNonEmptyString),
  state: HarnessState,
  diagnostics: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  models: Schema.Array(TrimmedNonEmptyString),
  catalog: Schema.NullOr(HarnessOptionCatalog).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

export class HarnessOverview extends Schema.Class<HarnessOverview>("HarnessOverview")({
  harnesses: Schema.Array(HarnessItem),
  checkedAtMillis: Schema.Natural,
}) {}
