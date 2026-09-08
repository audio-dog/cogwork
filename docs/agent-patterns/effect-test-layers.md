# Effect test layers

Use this reference when writing or restructuring `@effect/vitest` tests: building test doubles, wiring layers, and asserting on interactions. It covers test structure and provisioning, not what to assert.

## Model

Tests provide layers the same way production code does: at the boundary, once.

- `it.effect` already supplies a `Scope`, `TestClock`, and `TestConsole`. There is no `it.scoped` in v4.
- A test double is a layer. State the test asserts on (recorded calls, posted comments) is itself a service, so the layer graph stays static and the test body stays flat.
- A test body is one `Effect.gen` that yields services and asserts. Provisioning happens outside the body: in a `layer(...)` group, an `it.layer(...)` block, or a single flat `Effect.provide` at the end of the pipe.

## Choose the provisioning shape

| Need | Prefer |
| --- | --- |
| A group of tests shares one setup | top-level `layer(TestLayer)((it) => ...)` |
| One nested group needs extra services | `it.layer(ExtraLayer)("name", (it) => ...)` |
| Each test needs isolated stateful doubles | one flat `Effect.provide(testLayer(...))` per test |
| Assert on calls made to a double | a probe service exposing a `Ref` |
| Deterministic time | `TestClock.adjust` from `effect/testing` |

`layer(...)` builds the layer once for the group and closes it in `afterAll`; state persists across tests in the block. Use it for setup that is immutable or reset per test, and fall back to per-test provisioning when every test needs a fresh ledger.

## The sandwich anti-pattern

The recurring shape to avoid: an outer `Effect.gen` that builds `Ref`s, a layer constructed from them, and an inner `Effect.gen` wrapped in `Effect.provide`.

```ts
// Avoid: two nested gens because the probe Ref lives outside the layer
it.effect("triages an item", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const layer = provide(recorder(calls), [runner(successEvents)]);
    yield* Effect.gen(function* () {
      // ... test body ...
    }).pipe(Effect.provide(layer));
  }),
);
```

The outer gen exists only because the probe's `Ref` is a closure variable. Move the `Ref` into a service and the sandwich flattens.

## Probes are services

Give the double's observable state its own service and compose it in with `Layer.provideMerge`, so the probe stays visible to the test.

```ts
class TrackerCalls extends Context.Service<TrackerCalls, Ref.Ref<ReadonlyArray<Call>>>()(
  "@cogwork/engine/test/TrackerCalls",
) {
  static readonly layer = Layer.effect(TrackerCalls, Ref.make<ReadonlyArray<Call>>([]));
}

const trackerStub = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const calls = yield* TrackerCalls;
    const record = (entry: Call) => Ref.update(calls, (xs) => [...xs, entry]);
    return IssueTracker.of({
      claim: (_workspace, itemId) => record({ method: "claim", item: itemId }),
      // ... remaining methods ...
    });
  }),
).pipe(Layer.provideMerge(TrackerCalls.layer));
```

The test flattens to one gen with one provide:

```ts
it.effect("triages an eligible item", () =>
  Effect.gen(function* () {
    const executor = yield* Executor.Executor;
    yield* executor.execute(workspace, triageItem);

    const log = yield* Ref.get(yield* TrackerCalls);
    assert.isTrue(log.some((c) => c.method === "release"));
  }).pipe(Effect.provide(testLayer(trackerStub, [runner(successEvents)]))),
);
```

When a whole describe block shares the stub, lift the provide into `layer(testLayer(...))((it) => ...)` and drop it from every test.

## Build the suite layer in one place

A per-file helper that re-derives the production wiring (`bus → runLedger → runRecorder → sessionStore → harness`) drifts from the real graph one service at a time. Keep one composed test-layer builder per package, mirroring the production composition (`engineLayer` in `packages/engine/src/daemon.ts` is the reference wiring), and let each suite pass in only the doubles it varies. Tests then state what is different about them, not how the engine is wired.

## Do not leak test needs into production interfaces

When a test wants to wait for background work, give the service a domain operation instead of exposing its internals. A `tick` that returns `ReadonlyArray<Fiber>` so tests can `Fiber.awaitAll` puts fibers in a public interface the service already supervises with a `FiberSet`; expose `awaitIdle` (delegating to `FiberSet.awaitEmpty`) and keep the fibers private.

## Deterministic time

`it.effect` installs `TestClock` by default. Drive time explicitly; never sleep for real.

```ts
import { TestClock } from "effect/testing";

it.effect("expires the cooldown", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.sleep("1 minute"));
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(fiber);
  }),
);
```

Use `it.live` only when the test genuinely needs the real clock or console.

## Cogwork conventions

- Import `assert`, `describe`, `it`, and `layer` from `@effect/vitest`; import `TestClock` from `effect/testing`.
- One flat `Effect.gen` per test. Provisioning goes in `layer(...)`, `it.layer(...)`, or one `Effect.provide` at the end of the pipe — never a nested gen.
- Probe state is a service composed with `Layer.provideMerge`, so tests read it with `yield*`.
- Assert expected failures with `Effect.flip`, the existing repo idiom.
- One test-layer builder per package; suites override only the doubles they exercise.

## Sources

- `.repos/effect/packages/vitest/src/index.ts`: `it.effect` supplies scope and test services; `layer` and `it.layer` semantics.
- `.repos/effect/packages/vitest/src/internal/internal.ts`: group layers are memoized and closed in `afterAll`.
- `.repos/effect/ai-docs/src/09_testing/20_layer-tests.ts`: the probe-as-service pattern (`TodoRepoTestRef`) and layer-group lifetime notes.
- `.agents/skills/effect-ts/references/guide-testing.md`.
- `packages/engine/src/run-ledger.test.ts` and `packages/engine/src/run-recorder.test.ts`: existing `it.layer` usage in the repo.
- `packages/engine/src/executor.test.ts` and `packages/engine/src/scheduler.test.ts`: migrated exemplars — probe services composed with `Layer.provideMerge`, flat per-test provides, and `awaitIdle`.
- `packages/engine/src/recovery.test.ts` and `packages/engine/src/event-publisher.test.ts`: migrated exemplars — flat test bodies over probe services (`RecoveryProbe`, `EventPublisherProbe`) composed with `Layer.provideMerge`; the sandwich shape they replaced is gone from the repo.
