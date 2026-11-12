# Effect services and layers

Use this reference when defining a service, constructing its layer, or composing layers into an
application graph. It covers the service module shape, tags, factories, and layer wiring — not test
layers (`effect-test-layers.md`) or fiber supervision (`effect-fiber-lifecycle.md`).

## Model

A service is one module exporting three parts: a shape, a tag class, and a layer.

- `Context.Service<Self, Shape>()(tagString)` is the tag mechanism for ordinary services.
  `Context.Reference` is the mechanism for a key with a default value — the repo's two sites are
  `ConnectionStore` (`packages/engine/src/connection.ts`) and `ControlStore`
  (`packages/engine/src/control-store.ts`). `Effect.Service`, `Context.Tag`, and
  `Context.GenericTag` do not exist at `effect@4.0.0-rc.112`; the repo has zero uses of them.
- `Layer.effect` is the effectful layer constructor and it covers scoped construction: its result is
  `Layer<I, E, Exclude<R, Scope.Scope>>`, so an acquire/release effect fits directly. `Layer.scoped`
  does not exist on the rc line.
- Consumers reach a service through the package's namespace re-export (`export * as Executor from
  "./executor"` in `index.ts`), so call sites read `Executor.layer`, `Executor.make`.

## The service module shape

```ts
export interface ContextAssemblerService {
  readonly assemble: (
    request: AssembleRequest,
  ) => Effect.Effect<AssembledContext, ContextFsError | ContextAssemblerError>;
  readonly cleanup: (runId: RunId) => Effect.Effect<void, ContextFsError>;
}

export class ContextAssembler extends Context.Service<ContextAssembler, ContextAssemblerService>()(
  "@cogwork/engine/context-assembler/ContextAssembler",
) {}

export const make = (config: ContextAssemblerConfig, fs: ContextFsService): ContextAssemblerService => {
  // ...
};

export const layer = (config: ContextAssemblerConfig) =>
  Layer.effect(
    ContextAssembler,
    Effect.map(ContextFs, (fs) => make(config, fs)),
  );
```

Naming rules:

- The tag string is `"@cogwork/<package>/<module-path>/<ClassName>"`. The short form
  `"@cogwork/engine/scheduler"` (module path only) is accepted only when the module defines exactly
  one service.
- The shape is either an explicit `XService` interface or inferred with
  `Effect.Success<typeof make>` when `make` is the top-level effect.
- `make` and `layer` are module-level exports, not `static` members on the class. The vendored
  `ai-docs` examples attach `static readonly layer` to the class — that is Effect's docs style, not
  this repo's. Do not copy it. Test doubles keep their own class-member shape
  (`effect-test-layers.md`). Call sites read the same either way, so a migration is local to the
  defining module.

## Choose the make shape

| Construction | Prefer |
| --- | --- |
| Pure, from already-resolved dependencies | Plain function `make(config, dep)`; the layer resolves deps and calls it |
| Effectful, pulls many services from context | `Effect.gen` as the top-level `make` effect |
| Effectful, takes arguments, wants a named span | `Effect.fn("X.make")` |

The `Effect.gen` variant pulls every dependency with `yield*` and infers the shape:

```ts
export const make = Effect.gen(function* () {
  const issueTracker = yield* IssueTracker;
  const harness = yield* Harness;
  const ledger = yield* RunLedger;
  // ...
});

export class Executor extends Context.Service<Executor, Effect.Success<typeof make>>()(
  "@cogwork/engine/executor",
) {}

export const layer = Layer.effect(Executor, make).pipe(Layer.provide(Availability.layer));
```

The `Effect.fn` variant names the construction span and keeps arguments:

```ts
export const makeService = Effect.fn("ModelCatalog.make")(function* (
  source: CatalogSource,
  ttl: Duration.Input = defaultTtl,
) {
  const stale = yield* Ref.make<CatalogApi | null>(null);
  // ...
  return { models } satisfies ModelCatalogService;
});
```

All three variants are current in the repo. Pick by how effectful the construction is, not by habit.

## Layer wiring

| The service needs | Prefer |
| --- | --- |
| No config, effectful construction | `export const layer = Layer.effect(X, make)` |
| Config resolved by the caller | `export const layer = (config) => Layer.effect(X, make(config))` |
| Nothing effectful at all | `Layer.succeed(X, make(runners))` |
| A local dependency satisfied at definition | `Layer.effect(X, make).pipe(Layer.provide(dep))` |

`Layer.succeed` is not test-only: `packages/engine/src/harness.ts` uses it for the primary layer,
because constructing the runner registry is pure. Alternate implementations (`layerEnv` in
`credential-store.ts`, `acceptingLayer` in `connection-verify.ts`) use the same constructor with a
suffixed name.

## Compose the graph

| Need | Prefer |
| --- | --- |
| Independent siblings side by side | `Layer.mergeAll(a, b, ...)` |
| Feed dependencies into a target and hide them | `Layer.provide` |
| Feed dependencies and keep them visible downstream | `Layer.provideMerge` |
| Pick a layer at runtime from context | `Layer.unwrap` |

`engineLayer` in `packages/engine/src/daemon.ts` is the reference graph. A representative slice:

```ts
const issueTracker = Layer.mergeAll(issueTrackerRoutedLayer, GitHub.providerLayer).pipe(
  Layer.provide(githubClient),
  Layer.provide(Linear.clientLayer),
  Layer.provide(credentials),
);

const runLedger = runLedgerPublishingLayer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.map(ControlStore, (store) =>
        store.health === "available" ? adapters.runLedger : memoryRunLedgerLayer,
      ),
    ).pipe(Layer.provide(controlStore)),
  ),
  Layer.provide(daemonEventBusLayer),
);

const services = Layer.mergeAll(
  Layer.effect(ReconcileWorker, makeReconcile).pipe(Layer.provide(executor)),
  executor,
).pipe(Layer.provide(availability), Layer.provideMerge(Layer.mergeAll(base, adapters.worktrees)));
```

`Layer.provide` makes the dependency vanish from the produced context; `Layer.provideMerge` keeps it
available to later composition. `Layer.unwrap` runs an effect that reads context and returns the
layer to build — the shape for runtime-conditional wiring such as store-health fallbacks.

## Provide at the edge

Dependency assembly happens in layer definitions and at exported boundaries — never inline inside a
helper. The vendored lint rule `no-inline-runtime-provide` documents the avoid-shape (it is not yet
wired into `biome.json`):

```ts
// Avoid: hides dependency assembly inside a local helper
const value = yield* SomeRuntime.pipe(Effect.provide(SomeRuntimeLive));
```

Declare the live dependency on the owning service's layer, or provide once at the exported boundary,
then `yield*` the service directly.

## Cogwork conventions

- One service module exports the shape, the tag class, `make`, and `layer` — in that order.
- A port module may export only the shape and the tag; its `make`/`layer` live in the host adapter
  that implements it (`git.ts` with `apps/cli/src/platform.ts`'s `gitLayer`, `issue-tracker.ts` with
  the routed tracker layers). The four-part shape applies to modules that own their implementation.
- Tag strings follow `@cogwork/<package>/<module-path>/<ClassName>`; test doubles add a `.test`
  segment.
- `layer` is a module-level const (or config-taking function), not a `static` class member.
- Composition graphs live in one place per host (`engineLayer`, `serverLayer`); feature modules do
  not compose the world.
- Provide services at application edges; do not hide local provisioning inside business logic.

## Sources

- `.repos/effect/packages/effect/src/Context.ts`: the `Context.Service` overloads (explicit shape,
  inferred from `make`) and `Context.Reference` for keys with defaults. `Context.Tag` and
  `Context.GenericTag` are absent on the rc line.
- `.repos/effect/packages/effect/src/Layer.ts`: `effect`, `succeed`, `mergeAll`, `provide`,
  `provideMerge`, `unwrap`. `Layer.scoped` is absent; `Layer.effect` discharges `Scope`.
- `.agents/skills/effect-ts/references/guide-layers.md`: definition styles and the composition cheat
  sheet; notes that `Layer.effect` replaces the old `Layer.scoped`.
- `.repos/effect/ai-docs/src/01_effect/03_services/20_layer-unwrap.ts` and
  `20_layer-composition.ts`: `Layer.unwrap` selection and narrow-vs-wide layer exposure. Version
  drift: ai-docs examples use `static readonly layer` on the class; this repo does not.
- `.repos/biome-effect-linting-rules/rules/no-inline-runtime-provide.grit`: the provide-at-edges
  rule (vendored; not wired into this repo's `biome.json`).
- `packages/engine/src/context-assembler.ts`, `packages/engine/src/workflow-run.ts`,
  `packages/engine/src/model-catalog.ts`: the three `make` variants.
- `packages/engine/src/daemon.ts`: the `engineLayer`/`serverLayer` composition graph.
- `packages/engine/src/harness.ts`: `Layer.succeed` as a primary production layer.
- opencode pins `effect@4.0.0-beta.83` and t3code `4.0.0-beta.103` — use them for style comparison
  only, never as signature authority.
