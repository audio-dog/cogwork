import { HarnessItem, HarnessName, HarnessSignIn, HarnessState } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { harnessSummary, installedVersion, versionLabel } from "./harnesses-view";

const item = (state: HarnessState, version: string | null, models: ReadonlyArray<string> = []) =>
  HarnessItem.make({
    harness: Schema.decodeSync(HarnessName)("codex"),
    version,
    state,
    models,
    catalog: null,
  });

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
    const summary = harnessSummary(HarnessState.cases.Ready.make({}));
    expect(summary).toEqual({ headline: "Ready", detail: null, attention: "none", signIn: null });
  });

  it("treats a missing install as fatal and everything else as a warning", () => {
    expect(
      harnessSummary(HarnessState.cases.NotInstalled.make({ diagnostic: "not on PATH" })).attention,
    ).toBe("fatal");
    expect(harnessSummary(HarnessState.cases.Unavailable.make({ diagnostic: "broke" })).attention).toBe(
      "warning",
    );
  });

  it("surfaces the sign-in command the harness declared", () => {
    const summary = harnessSummary(
      HarnessState.cases.NotSignedIn.make({ signIn: HarnessSignIn.make({ command: "codex login" }) }),
    );
    expect(summary.headline).toBe("Not signed in");
    expect(summary.signIn).toBe("codex login");
  });

  it("says nothing about signing in when the harness declared no command", () => {
    expect(harnessSummary(HarnessState.cases.NotSignedIn.make({ signIn: null })).signIn).toBeNull();
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
