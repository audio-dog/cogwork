import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString } from "./base-schemas";
import { RunPlanPolicyProfile } from "./run-plan";

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

export class HarnessCatalogChoice extends Schema.Class<HarnessCatalogChoice>("HarnessCatalogChoice")({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
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
  models: Schema.Array(HarnessCatalogChoice),
  efforts: Schema.optionalKey(Schema.Array(HarnessCatalogChoice)),
  policyProfiles: Schema.Array(RunPlanPolicyProfile),
  provenance: HarnessCatalogProvenance,
}) {}

export class HarnessItem extends Schema.Class<HarnessItem>("HarnessItem")({
  harness: HarnessName,
  /** As the Harness reported it, so a non-semver release tag survives. */
  version: Schema.NullOr(TrimmedNonEmptyString),
  state: HarnessState,
  models: Schema.Array(TrimmedNonEmptyString),
  catalog: Schema.NullOr(HarnessOptionCatalog),
}) {}

export class HarnessOverview extends Schema.Class<HarnessOverview>("HarnessOverview")({
  harnesses: Schema.Array(HarnessItem),
  checkedAtMillis: Schema.Natural,
}) {}
