import { type HarnessItem, HarnessState } from "@cogwork/contracts";
export const versionLabel = (version: string | null) => {
  if (!version) return null;
  return /^\d/.test(version) ? `v${version}` : version;
};

export interface HarnessSummary {
  readonly headline: string;
  readonly detail: string | null;
  readonly attention: "none" | "warning" | "fatal";
  readonly signIn: string | null;
}

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

export const installedVersion = (item: HarnessItem) =>
  HarnessState.matchOrElse(
    item.state,
    {
      NotInstalled: () => ({ value: "not found", requirement: null, faulty: true }),
      UnsupportedVersion: ({ requirement }) => ({
        value: versionLabel(item.version) ?? "installed",
        requirement,
        faulty: true,
      }),
    },
    () => ({ value: versionLabel(item.version) ?? "installed", requirement: null, faulty: false }),
  );
