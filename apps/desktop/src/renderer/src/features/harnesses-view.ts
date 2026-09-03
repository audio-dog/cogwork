import { type HarnessItem, HarnessState } from "@cogwork/contracts";
/** A bare version gets a `v`; anything else is shown as the Harness reported it. */
export const versionLabel = (version: string | null) => {
  if (!version) return null;
  return /^\d/.test(version) ? `v${version}` : version;
};

export interface HarnessSummary {
  readonly headline: string;
  readonly detail: string | null;
  /** Trouble earns a status dot; a fatal one earns a red dot. */
  readonly attention: "none" | "warning" | "fatal";
  readonly signIn: string | null;
}

/**
 * The generated fold, so a new `HarnessState` variant fails to compile here instead of falling
 * through to a default.
 */
export const harnessSummary = (state: HarnessState): HarnessSummary =>
  HarnessState.match<HarnessSummary>(state, {
    Ready: () => ({ headline: "Ready", detail: null, attention: "none", signIn: null }),
    NotInstalled: ({ diagnostic }) => ({
      headline: "Not found",
      detail: diagnostic,
      attention: "fatal",
      signIn: null,
    }),
    UnsupportedVersion: ({ requirement }) => ({
      headline: "Version not supported",
      detail: requirement ? `Needs ${requirement}` : null,
      attention: "warning",
      signIn: null,
    }),
    NotSignedIn: ({ signIn }) => ({
      headline: "Not signed in",
      detail: null,
      attention: "warning",
      signIn: signIn?.command ?? null,
    }),
    Unavailable: ({ diagnostic }) => ({
      headline: "Needs attention",
      detail: diagnostic,
      attention: "warning",
      signIn: null,
    }),
    Unknown: ({ diagnostic }) => ({
      headline: "Not checked yet",
      detail: diagnostic,
      attention: "warning",
      signIn: null,
    }),
  });

/** The version a person reads, and whether it is the reason the Harness cannot run. */
export const installedVersion = (item: HarnessItem) => {
  const label = versionLabel(item.version);
  if (HarnessState.guards.NotInstalled(item.state)) return { value: "not found", requirement: null };
  if (HarnessState.guards.UnsupportedVersion(item.state)) {
    return { value: label ?? "installed", requirement: item.state.requirement };
  }
  return { value: label ?? "installed", requirement: null };
};
