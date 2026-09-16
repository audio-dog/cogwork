import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString } from "./base-schemas";
import { RunPlanPolicyProfile } from "./settings";

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

/** Reserved: an Operation's own `effort` setting binds to this option, never `model-options`. */
export const effortOptionId = "effort";

export class HarnessCatalogChoice extends Schema.Class<HarnessCatalogChoice>("HarnessCatalogChoice")({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
}) {}

export class HarnessModelOption extends Schema.Class<HarnessModelOption>("HarnessModelOption")({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  choices: Schema.Array(HarnessCatalogChoice),
  fallback: Schema.NullOr(TrimmedNonEmptyString),
}) {}

export class HarnessCatalogModel extends Schema.Class<HarnessCatalogModel>("HarnessCatalogModel")({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  options: Schema.optionalKey(Schema.Array(HarnessModelOption)),
}) {}

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

export class HarnessOptionCatalog extends Schema.Class<HarnessOptionCatalog>("HarnessOptionCatalog")({
  models: Schema.Array(HarnessCatalogModel),
  efforts: Schema.optionalKey(Schema.Array(HarnessCatalogChoice)),
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
