import { HarnessState } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";

import type { HarnessReadiness } from "./harness";
import { harnessStateOf } from "./harness-overview";

const readyReadiness: HarnessReadiness = {
  operational: { status: "ready", retryable: false, diagnostic: "ready" },
  installation: { status: "installed", version: "1.2.3" },
  compatibility: { status: "compatible", requirement: ">=1" },
  authentication: { mode: "host", status: "available", diagnostic: "login available" },
  diagnostics: [],
};

const readiness = (patch: Partial<HarnessReadiness>): HarnessReadiness => ({ ...readyReadiness, ...patch });

describe("harnessStateOf", () => {
  it("reads Ready when every axis is positive", () => {
    assert.isTrue(HarnessState.guards.Ready(harnessStateOf(readyReadiness, "codex login")));
  });

  it("reports a missing install ahead of every other axis", () => {
    const state = harnessStateOf(
      readiness({
        installation: { status: "missing", version: null },
        compatibility: { status: "incompatible", requirement: ">=2" },
        authentication: { mode: "host", status: "unavailable", diagnostic: "no login" },
        operational: { status: "unavailable", retryable: false, diagnostic: "not on PATH" },
      }),
      "codex login",
    );
    assert.isTrue(HarnessState.guards.NotInstalled(state));
    if (HarnessState.guards.NotInstalled(state)) assert.strictEqual(state.diagnostic, "not on PATH");
  });

  it("reports an unsupported version ahead of a missing login", () => {
    const state = harnessStateOf(
      readiness({
        compatibility: { status: "incompatible", requirement: ">=2.1.0" },
        authentication: { mode: "host", status: "unavailable", diagnostic: "no login" },
        operational: { status: "unavailable", retryable: false, diagnostic: "too old" },
      }),
      "codex login",
    );
    assert.isTrue(HarnessState.guards.UnsupportedVersion(state));
    if (HarnessState.guards.UnsupportedVersion(state)) assert.strictEqual(state.requirement, ">=2.1.0");
  });

  it("carries the harness's own sign-in command when the login is missing", () => {
    const state = harnessStateOf(
      readiness({
        authentication: { mode: "host", status: "unavailable", diagnostic: "no login" },
        operational: { status: "unavailable", retryable: false, diagnostic: "not signed in" },
      }),
      "codex login",
    );
    assert.isTrue(HarnessState.guards.NotSignedIn(state));
    if (HarnessState.guards.NotSignedIn(state)) {
      assert.strictEqual(state.signIn?.command, "codex login");
    }
  });

  it("leaves the sign-in null for a harness that declares no command", () => {
    const state = harnessStateOf(
      readiness({
        authentication: { mode: "host", status: "unavailable", diagnostic: "no login" },
        operational: { status: "unavailable", retryable: false, diagnostic: "not signed in" },
      }),
      null,
    );
    if (HarnessState.guards.NotSignedIn(state)) assert.strictEqual(state.signIn, null);
    else assert.fail("expected NotSignedIn");
  });

  it("separates a probe that could not tell from one that found a fault", () => {
    const unknown = harnessStateOf(
      readiness({ operational: { status: "unknown", retryable: false, diagnostic: "no answer" } }),
      null,
    );
    const unavailable = harnessStateOf(
      readiness({ operational: { status: "unavailable", retryable: true, diagnostic: "broke" } }),
      null,
    );
    assert.isTrue(HarnessState.guards.Unknown(unknown));
    assert.isTrue(HarnessState.guards.Unavailable(unavailable));
  });

  it("substitutes a reason when the harness gave a blank one", () => {
    const state = harnessStateOf(
      readiness({
        installation: { status: "missing", version: null },
        operational: { status: "unavailable", retryable: false, diagnostic: "   " },
      }),
      null,
    );
    if (HarnessState.guards.NotInstalled(state)) {
      assert.strictEqual(state.diagnostic, "the harness gave no reason");
    } else assert.fail("expected NotInstalled");
  });
});
