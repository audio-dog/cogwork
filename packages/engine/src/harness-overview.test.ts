import { HarnessName, HarnessOptionCatalog, HarnessState } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  fullHarnessExecution,
  HarnessError,
  type HarnessReadiness,
  type HarnessRunner,
  staticCatalogSource,
} from "./harness";
import { harnessOverview, harnessStateOf } from "./harness-overview";
import { engineTestLayer } from "./testing/engine-test-layer";
import { harnessProbeTestLayer } from "./testing/harness-probe-layer";

const harness = Schema.decodeSync(HarnessName);

const readyReadiness: HarnessReadiness = {
  operational: { status: "ready", retryable: false, diagnostic: "ready" },
  installation: { status: "installed", version: "1.2.3" },
  compatibility: { status: "compatible", requirement: ">=1" },
  authentication: { mode: "host", status: "available", diagnostic: "login available" },
  diagnostics: [],
};

const readiness = (patch: Partial<HarnessReadiness>): HarnessReadiness => ({ ...readyReadiness, ...patch });

const encodeHarnessOptionCatalog = Schema.encodeSync(HarnessOptionCatalog);
const encodeCatalog = (catalog: HarnessOptionCatalog | null) => {
  if (!catalog) return assert.fail("expected a Harness option catalog");
  return encodeHarnessOptionCatalog(catalog);
};

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

/** `HarnessRunnerEnv` names SessionStore too, which the engine's own test layer already builds. */
const probeLayer = (runners: ReadonlyArray<HarnessRunner>) =>
  Layer.mergeAll(harnessProbeTestLayer(runners), engineTestLayer());

const runner = (
  name: string,
  overrides: Partial<Pick<HarnessRunner, "readiness" | "catalogSources" | "execution" | "signIn">> = {},
): HarnessRunner => ({
  name: harness(name),
  sessionKind: "opaque-handle",
  projectedMembers: [],
  planMiddleware: [],
  execution: fullHarnessExecution,
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "runtime-host", fork: false, humanAttach: false },
    structuredOutput: "none",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: false,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "test login" },
  catalogSources: {
    fallback: staticCatalogSource(
      { models: [{ value: "model-a", label: "Model A" }] },
      { source: "cogwork-fallback", fallbackVersion: "test-1" },
    ),
  },
  readiness: () => Effect.succeed(readyReadiness),
  preflight: () => Effect.void,
  run: () => Stream.empty,
  ...overrides,
});

describe("harnessOverview", () => {
  it.effect("carries stored enablement beside readiness", () =>
    Effect.gen(function* () {
      const overview = yield* harnessOverview([{ harness: harness("codex"), enabled: false }]);

      assert.isFalse(overview.harnesses[0]?.enabled);
      assert.isTrue(overview.harnesses[1]?.enabled);
    }).pipe(Effect.provide(probeLayer([runner("codex"), runner("cursor")]))),
  );

  it.effect("publishes labeled choices, fallback provenance, and each runner's policy profiles", () =>
    Effect.gen(function* () {
      const overview = yield* harnessOverview();
      assert.deepStrictEqual(
        overview.harnesses.map((item) => item.harness),
        ["codex", "cursor"],
      );
      assert.deepStrictEqual(encodeCatalog(overview.harnesses[0]?.catalog), {
        models: [{ value: "model-a", label: "Model A" }],
        policyProfiles: ["read-only", "full"],
        provenance: { source: "cogwork-fallback", fallbackVersion: "test-1" },
      });
      assert.deepStrictEqual(overview.harnesses[0]?.models, ["model-a"]);
      assert.strictEqual(overview.harnesses[0]?.version, "1.2.3");
    }).pipe(Effect.provide(probeLayer([runner("codex"), runner("cursor")]))),
  );

  it.effect("publishes runtime and native provenance and omits unsupported effort", () =>
    Effect.gen(function* () {
      const overview = yield* harnessOverview();
      assert.deepStrictEqual(encodeCatalog(overview.harnesses[0]?.catalog), {
        models: [{ value: "runtime", label: "Runtime" }],
        efforts: [{ value: "high", label: "High" }],
        policyProfiles: ["full"],
        provenance: { source: "tanstack-runtime", packageVersion: "2.0.0" },
      });
      assert.deepStrictEqual(encodeCatalog(overview.harnesses[1]?.catalog), {
        models: [{ value: "native", label: "Native" }],
        policyProfiles: ["read-only"],
        provenance: {
          source: "native-discovery",
          runtimeHost: "host-a",
          harnessVersion: "3.0.0",
        },
      });
      assert.isUndefined(overview.harnesses[1]?.catalog?.efforts);
    }).pipe(
      Effect.provide(
        probeLayer([
          runner("codex", {
            execution: { ...fullHarnessExecution, profiles: ["full"] },
            catalogSources: {
              runtime: staticCatalogSource(
                {
                  models: [{ value: "runtime", label: "Runtime" }],
                  efforts: [{ value: "high", label: "High" }],
                },
                { source: "tanstack-runtime", packageVersion: "2.0.0" },
              ),
              fallback: staticCatalogSource(
                { models: [{ value: "fallback", label: "Fallback" }] },
                { source: "cogwork-fallback", fallbackVersion: "test-1" },
              ),
            },
          }),
          runner("provider", {
            execution: { ...fullHarnessExecution, profiles: ["read-only"] },
            catalogSources: {
              native: staticCatalogSource(
                { models: [{ value: "native", label: "Native" }] },
                {
                  source: "native-discovery",
                  runtimeHost: "host-a",
                  harnessVersion: "3.0.0",
                },
              ),
              fallback: staticCatalogSource(
                { models: [{ value: "fallback", label: "Fallback" }] },
                { source: "cogwork-fallback", fallbackVersion: "test-1" },
              ),
            },
          }),
        ]),
      ),
    ),
  );

  it.effect("keeps the other catalogs when one harness fails to answer", () =>
    Effect.gen(function* () {
      const overview = yield* harnessOverview();
      assert.strictEqual(overview.harnesses[0]?.catalog, null);
      assert.deepStrictEqual(
        overview.harnesses[1]?.catalog?.models.map(({ value, label }) => ({ value, label })),
        [{ value: "model-a", label: "Model A" }],
      );
    }).pipe(
      Effect.provide(
        probeLayer([
          runner("codex", {
            catalogSources: {
              fallback: {
                catalog: Effect.fail(
                  new HarnessError({
                    reason: "launch",
                    retryable: true,
                    message: "catalog lookup failed",
                  }),
                ),
              },
            },
          }),
          runner("cursor"),
        ]),
      ),
    ),
  );

  it.effect("stamps when the probe ran", () =>
    Effect.gen(function* () {
      const overview = yield* harnessOverview();
      assert.isAtLeast(overview.checkedAtMillis, 0);
    }).pipe(Effect.provide(probeLayer([runner("codex")]))),
  );
});
