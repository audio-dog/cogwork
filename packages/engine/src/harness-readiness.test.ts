import { DaemonEvent, defaultControlStore, HarnessName, HarnessState } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ControlStore } from "./control-store";
import * as DaemonEventBus from "./daemon-event-bus";
import {
  fullHarnessExecution,
  Harness,
  HarnessError,
  type HarnessReadiness,
  type HarnessRunner,
  make as makeHarness,
  staticCatalogSource,
} from "./harness";
import { HarnessReadinessCache, layer as harnessReadinessLayer } from "./harness-readiness";
import { engineTestLayer } from "./testing/engine-test-layer";
import { harnessProbeTestLayer } from "./testing/harness-probe-layer";

const harness = Schema.decodeSync(HarnessName)("codex");

const readyReadiness: HarnessReadiness = {
  operational: { status: "ready", retryable: false, diagnostic: "ready" },
  installation: { status: "installed", version: "1.2.3" },
  compatibility: { status: "compatible", requirement: ">=1" },
  authentication: { mode: "host", status: "available", diagnostic: "login available" },
  diagnostics: ["Codex 1.2.3 differs from the version this catalog was generated against (1.2.2).", "   "],
};

interface ReadinessProbeService {
  readonly calls: Ref.Ref<number>;
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

class ReadinessProbe extends Context.Service<ReadinessProbe, ReadinessProbeService>()(
  "@cogwork/engine/harness-readiness.test/ReadinessProbe",
) {}

const readinessProbeLayer = Layer.effect(
  ReadinessProbe,
  Effect.gen(function* () {
    return {
      calls: yield* Ref.make(0),
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
  }),
);

const runner = (probe: ReadinessProbeService): HarnessRunner => ({
  name: harness,
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
    readinessDiagnostics: true,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "test login" },
  catalogSources: {
    fallback: staticCatalogSource(
      { models: [{ value: "model-a", label: "Model A" }], generatedAgainst: "1.2.3" },
      { source: "cogwork-fallback", fallbackVersion: "1.2.3" },
    ),
  },
  readiness: () =>
    Deferred.succeed(probe.started, undefined).pipe(
      Effect.andThen(Ref.update(probe.calls, (count) => count + 1)),
      Effect.andThen(Deferred.await(probe.release)),
      Effect.map(() => readyReadiness),
    ),
  preflight: () => Effect.void,
  run: () => Stream.empty,
});

const controlStoreLayer = Layer.mock(ControlStore, {
  health: "available" as const,
  seed: defaultControlStore,
  picture: Effect.succeed(defaultControlStore),
  withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
});

describe("HarnessReadinessCache", () => {
  it.effect("serves an immediate unknown snapshot while the boot probe runs, then publishes it", () =>
    Effect.gen(function* () {
      const probe = yield* ReadinessProbe;
      const cache = yield* HarnessReadinessCache;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const initial = yield* cache.overview([]);
      assert.isTrue(HarnessState.guards.Unknown(initial.harnesses[0]?.state));
      assert.strictEqual(initial.checkedAtMillis, 0);
      yield* cache.requestAll();
      yield* Deferred.await(probe.started);
      yield* Deferred.succeed(probe.release, undefined);
      const event = yield* PubSub.take(subscription);
      assert.isTrue(DaemonEvent.guards.HarnessesChanged(event));
      if (!DaemonEvent.guards.HarnessesChanged(event)) return;
      assert.strictEqual(event.overview.harnesses[0]?.version, "1.2.3");
      assert.deepStrictEqual(event.overview.harnesses[0]?.diagnostics, [
        "Codex 1.2.3 differs from the version this catalog was generated against (1.2.2).",
      ]);
      assert.strictEqual(yield* Ref.get(probe.calls), 1);
      yield* cache.requestOne(
        harness,
        new HarnessError({ reason: "credential", retryable: true, message: "sign in expired" }),
      );
      const credentialEvent = yield* PubSub.take(subscription);
      assert.isTrue(DaemonEvent.guards.HarnessesChanged(credentialEvent));
      if (!DaemonEvent.guards.HarnessesChanged(credentialEvent)) return;
      assert.isTrue(HarnessState.guards.NotSignedIn(credentialEvent.overview.harnesses[0]?.state));
      assert.deepStrictEqual(credentialEvent.overview.harnesses[0]?.diagnostics, [
        "Codex 1.2.3 differs from the version this catalog was generated against (1.2.2).",
        "sign in expired",
      ]);
      assert.strictEqual(credentialEvent.overview.checkedAtMillis, event.overview.checkedAtMillis);
      assert.strictEqual(yield* Ref.get(probe.calls), 2);
    }).pipe(
      Effect.provide(
        harnessReadinessLayer.pipe(
          Layer.provide(
            Layer.effect(
              Harness,
              Effect.map(ReadinessProbe, (service) => makeHarness([runner(service)])),
            ),
          ),
          Layer.provide(Layer.mergeAll(harnessProbeTestLayer(), engineTestLayer(), controlStoreLayer)),
          Layer.provideMerge(readinessProbeLayer),
          Layer.provideMerge(DaemonEventBus.layer),
        ),
      ),
    ),
  );
});
