import {
  defaultControlStore,
  HarnessCatalog,
  HarnessName,
  HarnessReadiness,
  HarnessReadinessItem,
  HarnessSignIn,
  HarnessState,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  applyHarnessEnablement,
  type HarnessItem,
  harnessEnablementView,
  harnessItems,
  harnessSummary,
  installedVersion,
  versionLabel,
} from "./harnesses-view";

const readinessItem = (state: HarnessState, version: string | null, enabled = true) =>
  HarnessReadinessItem.make({
    harness: Schema.decodeSync(HarnessName)("codex"),
    enabled,
    version,
    state,
    diagnostics: [],
  });

const item = (state: HarnessState, version: string | null, enabled = true) =>
  ({
    ...readinessItem(state, version, enabled),
    catalog: { models: [], policyProfiles: [], provenance: { source: "managed" } },
  }) satisfies HarnessItem;

describe("versionLabel", () => {
  it("prefixes a bare version so it reads as one", () => {
    expect(versionLabel("0.153.0")).toBe("v0.153.0");
  });

  it("leaves a release tag as the harness reported it", () => {
    expect(versionLabel("ai-anthropic@0.18.3")).toBe("ai-anthropic@0.18.3");
  });

  it("has nothing to say about a harness that reported no version", () => {
    expect(versionLabel(null)).toBeNull();
  });
});

describe("harnessSummary", () => {
  it("keeps a ready harness quiet", () => {
    const summary = harnessSummary(item(HarnessState.cases.Ready.make({}), null));
    expect(summary).toEqual({ headline: "Ready", detail: null, attention: "none", signIn: null });
  });

  it("treats a missing install as fatal and everything else as a warning", () => {
    expect(
      harnessSummary(item(HarnessState.cases.NotInstalled.make({ diagnostic: "not on PATH" }), null))
        .attention,
    ).toBe("fatal");
    expect(
      harnessSummary(item(HarnessState.cases.Unavailable.make({ diagnostic: "broke" }), null)).attention,
    ).toBe("warning");
  });

  it("surfaces the sign-in command the harness declared", () => {
    const summary = harnessSummary(
      item(
        HarnessState.cases.NotSignedIn.make({ signIn: HarnessSignIn.make({ command: "codex login" }) }),
        null,
      ),
    );
    expect(summary.headline).toBe("Not signed in");
    expect(summary.signIn).toBe("codex login");
  });

  it("says nothing about signing in when the harness declared no command", () => {
    expect(
      harnessSummary(item(HarnessState.cases.NotSignedIn.make({ signIn: null }), null)).signIn,
    ).toBeNull();
  });

  it("puts disabled ahead of readiness", () => {
    const summary = harnessSummary(item(HarnessState.cases.Ready.make({}), null, false));
    expect(summary).toEqual({ headline: "Disabled", detail: null, attention: "muted", signIn: null });
  });
});

describe("applyHarnessEnablement", () => {
  it("applies live Control store changes to an older probe result", () => {
    const codex = item(HarnessState.cases.Ready.make({}), null);
    const controlStore = {
      ...defaultControlStore,
      harnessSettings: [{ harness: codex.harness, enabled: false }],
    };

    expect(applyHarnessEnablement([codex], controlStore)[0]?.enabled).toBe(false);
  });
});

describe("harnessItems", () => {
  it("joins live readiness to the separately loaded catalog", () => {
    const observed = readinessItem(HarnessState.cases.Ready.make({}), "0.154.0");
    const readiness = HarnessReadiness.make({ harnesses: [observed], checkedAtMillis: 12 });
    const catalog = HarnessCatalog.make({
      harness: observed.harness,
      catalog: { models: [], policyProfiles: [], provenance: { source: "managed" } },
    });

    expect(harnessItems(readiness, [catalog])).toEqual([{ ...observed, catalog: catalog.catalog }]);
  });

  it("shows catalog entries while readiness is still loading", () => {
    const catalog = HarnessCatalog.make({
      harness: Schema.decodeSync(HarnessName)("codex"),
      catalog: { models: [], policyProfiles: [], provenance: { source: "managed" } },
    });

    expect(harnessItems(null, [catalog])).toEqual([
      {
        harness: catalog.harness,
        enabled: true,
        version: null,
        state: HarnessState.cases.Unknown.make({ diagnostic: "Readiness check pending" }),
        diagnostics: [],
        catalog: catalog.catalog,
      },
    ]);
  });
});

describe("harnessEnablementView", () => {
  it("uses the mutation result until the Board publishes a new Control store", () => {
    const board = defaultControlStore;
    const harness = Schema.decodeSync(HarnessName)("codex");
    const updated = {
      ...board,
      harnessSettings: [{ harness, enabled: false }],
    };

    expect(harnessEnablementView(board, { base: board, updated })).toEqual({
      controlStore: updated,
      settled: false,
    });
  });

  it("keeps the mutation result while the Board is unavailable", () => {
    const base = defaultControlStore;
    const harness = Schema.decodeSync(HarnessName)("codex");
    const updated = {
      ...base,
      harnessSettings: [{ harness, enabled: false }],
    };

    expect(harnessEnablementView(null, { base, updated })).toEqual({
      controlStore: updated,
      settled: false,
    });
  });

  it("accepts the next Control store when another client overwrote the setting", () => {
    const base = defaultControlStore;
    const board = { ...base };
    const harness = Schema.decodeSync(HarnessName)("codex");
    const updated = {
      ...base,
      harnessSettings: [{ harness, enabled: false }],
    };

    expect(harnessEnablementView(board, { base, updated })).toEqual({
      controlStore: board,
      settled: true,
    });
  });

  it("uses the Board after it publishes the submitted enablement", () => {
    const base = defaultControlStore;
    const harness = Schema.decodeSync(HarnessName)("codex");
    const updated = { ...base, harnessSettings: [{ harness, enabled: false }] };
    const board = { ...updated };

    expect(harnessEnablementView(board, { base, updated })).toEqual({
      controlStore: board,
      settled: true,
    });
  });
});

describe("installedVersion", () => {
  it("reads a supported install as its version alone", () => {
    expect(installedVersion(item(HarnessState.cases.Ready.make({}), "0.153.0"))).toEqual({
      value: "v0.153.0",
      requirement: null,
      faulty: false,
    });
  });

  it("carries the requirement on the version that fails it", () => {
    expect(
      installedVersion(
        item(HarnessState.cases.UnsupportedVersion.make({ requirement: ">=2.1.0" }), "2.0.41"),
      ),
    ).toEqual({ value: "v2.0.41", requirement: ">=2.1.0", faulty: true });
  });

  it("does not claim an install for a probe that reached no conclusion", () => {
    const state = HarnessState.cases.Unknown.make({ diagnostic: "the probe overran 10 seconds" });

    expect(installedVersion(item(state, null))).toEqual({
      value: "not checked",
      requirement: null,
      faulty: true,
    });
  });

  it("keeps a missing login off the installed row, which is not the fault", () => {
    const state = HarnessState.cases.NotSignedIn.make({ signIn: null });

    expect(installedVersion(item(state, "2026.08.11"))).toEqual({
      value: "v2026.08.11",
      requirement: null,
      faulty: false,
    });
  });

  it("says not found rather than showing a version it does not have", () => {
    expect(
      installedVersion(item(HarnessState.cases.NotInstalled.make({ diagnostic: "gone" }), null)).value,
    ).toBe("not found");
  });
});
