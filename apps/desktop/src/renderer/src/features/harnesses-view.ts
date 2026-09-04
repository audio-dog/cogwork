import { type HarnessItem, HarnessState } from "@cogwork/contracts";
export const versionLabel = (version: string | null) => {
  if (!version) return null;
  return /^\d/.test(version) ? `v${version}` : version;
};

export interface HarnessSummary {
  readonly headline: string;
  readonly detail: string | null;
  readonly attention: "none" | "muted" | "warning" | "fatal";
  readonly signIn: string | null;
}

export const harnessSummary = (item: HarnessItem): HarnessSummary => {
  if (!item.enabled) {
    return { headline: "Disabled", detail: null, attention: "muted", signIn: null };
  }
  return HarnessState.match<HarnessSummary>(item.state, {
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
};

export const orderHarnesses = (items: ReadonlyArray<HarnessItem>) =>
  items.toSorted((left, right) => Number(left.enabled) - Number(right.enabled));

export const installedVersion = (item: HarnessItem) => {
  const reported = versionLabel(item.version);
  return HarnessState.match<{
    readonly value: string;
    readonly requirement: string | null;
    readonly faulty: boolean;
  }>(item.state, {
    Ready: () => ({ value: reported ?? "installed", requirement: null, faulty: false }),
    NotInstalled: () => ({ value: "not found", requirement: null, faulty: true }),
    UnsupportedVersion: ({ requirement }) => ({
      value: reported ?? "installed",
      requirement,
      faulty: true,
    }),
    // Installed either way: what is missing is the login, not the binary.
    NotSignedIn: () => ({ value: reported ?? "installed", requirement: null, faulty: false }),
    Unavailable: () => ({ value: reported ?? "installed", requirement: null, faulty: false }),
    // The probe reached no conclusion, so this cannot claim the binary is there.
    Unknown: () => ({ value: reported ?? "not checked", requirement: null, faulty: true }),
  });
};
