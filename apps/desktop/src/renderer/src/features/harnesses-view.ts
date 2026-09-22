import {
  type ControlStore,
  type HarnessCatalog,
  type HarnessOptionCatalog,
  type HarnessReadiness,
  HarnessReadinessItem,
  HarnessState,
  harnessEnabled,
} from "@cogwork/contracts";

export type HarnessItem = HarnessReadinessItem & { readonly catalog: HarnessOptionCatalog };

const pendingReadiness = (harness: HarnessReadinessItem["harness"]) =>
  HarnessReadinessItem.make({
    harness,
    version: null,
    state: HarnessState.cases.Unknown.make({ diagnostic: "Readiness check pending" }),
  });

export const harnessItems = (
  readiness: HarnessReadiness | null,
  catalogs: ReadonlyArray<HarnessCatalog> | null,
) =>
  catalogs?.map(({ harness, catalog }) => ({
    ...(readiness?.harnesses.find((item) => item.harness === harness) ?? pendingReadiness(harness)),
    catalog,
  })) ?? [];

export const applyHarnessEnablement = (
  items: ReadonlyArray<HarnessItem>,
  controlStore: ControlStore | null,
) => {
  if (!controlStore) return items;
  return items.map((item) => ({
    ...item,
    enabled: harnessEnabled(controlStore.harnessSettings, item.harness),
  }));
};

export interface HarnessEnablementOverlay {
  readonly base: ControlStore | null;
  readonly updated: ControlStore;
}

export const harnessEnablementView = (
  controlStore: ControlStore | null,
  overlay: HarnessEnablementOverlay | null,
) => {
  if (overlay === null) return { controlStore, settled: false };
  if (controlStore === null) return { controlStore: overlay.updated, settled: false };
  if (controlStore !== overlay.base) return { controlStore, settled: true };
  return { controlStore: overlay.updated, settled: false };
};

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
