import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString } from "./base-schemas";

/**
 * The one command that establishes a Harness's own login, declared by the Harness that owns it.
 * Cogwork never runs it: the credential is harness-owned, so a person runs this themselves.
 */
export class HarnessSignIn extends Schema.Class<HarnessSignIn>("HarnessSignIn")({
  command: TrimmedNonEmptyString,
}) {}

/**
 * What one Harness's readiness means for a person, folded from the four axes the engine observes.
 * The fold happens once, in the engine, so every client reads the same conclusion instead of
 * re-deriving it from installation, compatibility, authentication and operational status.
 */
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
  /** When the probe that produced this ran, so a client can say how stale it is. */
  checkedAtMillis: Schema.Natural,
}) {}
