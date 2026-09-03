import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString } from "./base-schemas";

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

export class HarnessItem extends Schema.Class<HarnessItem>("HarnessItem")({
  harness: HarnessName,
  /** As the Harness reported it, so a non-semver release tag survives. */
  version: Schema.NullOr(TrimmedNonEmptyString),
  state: HarnessState,
  /** The Harness option catalog's models. Empty when no catalog source answered. */
  models: Schema.Array(TrimmedNonEmptyString),
}) {}

export class HarnessOverview extends Schema.Class<HarnessOverview>("HarnessOverview")({
  harnesses: Schema.Array(HarnessItem),
  checkedAtMillis: Schema.Natural,
}) {}
