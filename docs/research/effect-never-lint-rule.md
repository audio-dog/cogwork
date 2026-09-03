# Is the blanket ban on `Effect.never` good practice?

Date: 2026-09-01. Primary sources: the vendored Effect v4 repository at `.repos/effect`
(read on disk), the official Effect documentation at effect.website, and the
`@effect/eslint-plugin` repository.

**Question:** The lint rule `configs/lint/no-effect-never.grit` flags every use of
`Effect.never` as an error. Its message says: "it hides lifecycle and leaks resources."
Is this ban a common or good practice? What are the legitimate uses of `Effect.never`?
Do the Effect maintainers recommend that users avoid it?

**TL;DR:** No. The ban is not a known practice anywhere in the Effect ecosystem, and the
rule's rationale is wrong on both counts. `Effect.never` is interruptible and holds no
resources, so it cannot leak by itself. The Effect maintainers use it 189 times in their
own repository. `Layer.launch` — the sanctioned entry point for long-running apps — is
implemented with it. The official docs, the agent-facing `ai-docs`, and the v3→v4
migration guide all present it as the idiomatic tool. Verdict: drop the rule; move the
real concern (an unowned fiber) into the pattern doc that already owns it.

---

## 1. What `Effect.never` is

Definition (`.repos/effect/packages/effect/src/Effect.ts:1238-1254`):

> "Returns an effect that will never produce anything. The moral equivalent of
> `while(true) {}`, only without the wasted CPU cycles."

Implementation (`.repos/effect/packages/effect/src/internal/effect.ts:1172`):

```ts
export const never: Effect.Effect<never> = callback<never>(constVoid)
```

It is a `callback` effect that never resumes. Two properties follow from this:

- **It is interruptible.** A `callback` effect suspends the fiber. Interruption ends it
  like any other suspended effect. Finalizers and `Scope` teardown run normally. The
  docstring example at `Effect.ts:1247` shows `Effect.timeoutOption(Effect.never, 0)`
  resolving to `Option.none()` — the timeout interrupts it.
- **It holds no resources.** It acquires nothing. It burns no CPU. A resource leak needs
  a fiber that no scope owns. That is a property of *how a fiber is forked*, not of the
  effect the fiber runs.

## 2. How the Effect maintainers use it (strongest evidence)

Grep of `Effect.never` across `.repos/effect/packages` (`*.ts`): **189 uses**.

| Category | Count | What it shows |
| --- | --- | --- |
| Test code | 129 | The canonical fixture for "a task that does not complete": interruption tests, timeout tests, race tests, `FiberMap`/`FiberSet`/`FiberHandle` tests. |
| Docstring examples | 43 | Public, teaching-grade examples. `forkIn` and `forkScoped` (`Effect.ts:8551`, `Effect.ts:8594`) show `Effect.never` as the model background task that a closing scope interrupts. `Fiber.ts:433-435, 480-481` and the `FiberMap`/`FiberSet`/`FiberHandle` docs do the same. |
| Implementation code | 17 | Real library machinery, listed below. |

Implementation uses in Effect's own source:

- **`Layer.launch`** (`packages/effect/src/Layer.ts:2207-2208`):

  ```ts
  export const launch = <RIn, E, ROut>(self: Layer<ROut, E, RIn>): Effect<never, E, RIn> =>
    internalEffect.scoped(internalEffect.andThen(build(self), internalEffect.never))
  ```

  The sanctioned "run my app until interrupted" pattern is literally `build the layer,
  then Effect.never, inside a scope`. The scope releases every resource on interruption.
- **Combinator primitives built on it**: `Channel.never` (`Channel.ts:940`),
  `Sink.never` (`Sink.ts:695`), `RequestResolver.never` (`RequestResolver.ts:733`).
- **Keep-open / park patterns**: `Stream.ts:8502`, `Channel.ts:6197`,
  `NodeHttpClient.ts:460`, `denoSocketServer.ts:34`, `rpc/Utils.ts:51,111`,
  `cluster/Sharding.ts:1537`, `workflow/DurableQueue.ts:333`.
- **Park an interrupted waiter**: `PartitionedSemaphore.ts:185` resumes a cancelled
  waiter with `Effect.never` so it waits for the interruption to land.
- **Disposed-registry guard**: `AtomRegistry.ts:883,887,920,930`.

## 3. What the docs and migration guide say

- Official docs, "Managing Layers" (<https://effect.website/docs/requirements-management/layers/>):
  "You can convert that layer to an effect with `Layer.launch`. It constructs the layer
  and keeps it alive until interrupted."
- Effect's agent-facing docs
  (`.repos/effect/ai-docs/src/01_effect/06_running/20_layer-launch.ts:22`):
  "`Layer.launch` converts the layer into a long-running `Effect<never>`." The file
  presents this as the entry-point pattern for an app made of layers. These `ai-docs`
  exist to steer coding agents — the same goal as our grit rules — and they teach the
  pattern the rule bans.
- The v3→v4 migration guide (`.repos/effect/migration/v3-to-v4.md:10411`) tells users to
  **write** `Effect.runFork(Effect.never)` as the replacement for the removed
  `Fiber.never`. The maintainers point people *toward* `Effect.never`, not away from it.

## 4. Does anyone in the ecosystem ban it?

No source found.

- `@effect/eslint-plugin` (<https://github.com/Effect-TS/eslint-plugin>) is the official
  lint plugin. Its rules cover formatting (dprint), barrel imports, and curried arrows.
  It has no rule about `Effect.never` or about banning any constructor.
- Web searches for "`Effect.never` anti-pattern / avoid" return no maintainer post, no
  GitHub discussion, and no community write-up that advises against it. Community
  material (for example the typeonce.dev Node server course,
  <https://www.typeonce.dev/course/paddle-payments-full-stack-typescript-app/server-implementation/executing-a-node-server-with-effect>)
  teaches `Layer.launch(HttpLive).pipe(NodeRuntime.runMain)` — the `Effect.never`
  pattern under a different name.

## 5. The rule's claims, tested

- **"It hides lifecycle."** False in the idiomatic uses. `Effect.never` inside a scope
  makes the lifecycle explicit: the fiber lives exactly as long as the scope. That is
  the structured-concurrency contract the rest of this repo relies on
  (`docs/agent-patterns/effect-fiber-lifecycle.md`).
- **"It leaks resources."** False as stated. The effect owns nothing, so it can leak
  nothing. A leak needs an unowned fiber. This repo already guards that edge with
  the `Runtime.runFork` rule in `configs/lint/member-calls.grit` and with the fiber-lifecycle pattern doc's rule
  "Never use `Effect.forkDetach` in the engine"
  (`docs/agent-patterns/effect-fiber-lifecycle.md`, "Cogwork conventions").
- **"Fix: use Stream or acquire/release."** The fix does not match the uses. A test that
  needs "a task that never completes" cannot use a `Stream`. `Layer.launch` *is* the
  acquire/release lifecycle — with `Effect.never` in the middle.

When is `Effect.never` a genuine smell? Only as a lazy park outside any scope: a
hand-written `main` that ends in a bare `yield* Effect.never` instead of
`Layer.launch`, or a wait that should be a `Deferred`. Both are shape problems around
the constructor. A GritQL text match cannot see the difference, so the rule cannot be
narrowed to the smell — it can only ban the idiom whole.

## 6. Effect of the ban on agents in this repo

- The workspace has zero real uses today. The only match was the rule's own test fixture
  (`configs/lint/tests/fixtures/no-effect-never/invalid-example.ts`, deleted with the rule).
- The rule severity is `error`, so an agent that needs the idiom must work around it.
  The likely workarounds are strictly worse: `Effect.forever(Effect.sleep("1 hour"))`,
  a `new Promise(() => {})` bridge, or a hand-rolled loop. Each one re-implements
  `Effect.never` with more code and the same or worse lifecycle story.
- The ban also blocks tests. Effect's own suite uses `Effect.never` 129 times as the
  fixture for interruption and timeout behavior. Our engine tests for cancellation
  (`FiberMap.remove`, deadlines from `docs/agent-patterns/effect-time-bounds.md`) need
  the same fixture.
- AGENTS.md tells agents to treat `.repos/effect` as the reference. The rule then flags
  the exact code the reference teaches. That conflict trains agents to distrust one of
  the two sources.

Provenance: the rule arrived in commit `3634dafb` ("Vendor curated Effect lint rules
into configs/lint", 2026-07-30) as part of a vendored batch, not from a repo-specific
incident. A later commit (`7d5988aa`, "Drop misfiring Effect lint rules") shows the
batch has already shed rules that did not hold up.

## 7. Verdict

**Drop the blanket ban.** Delete `configs/lint/no-effect-never.grit` and its fixtures.

Reasoning:

1. The rule's rationale is factually wrong. `Effect.never` is interruptible and holds no
   resources. Source: `internal/effect.ts:1172` and the `Scope` teardown in
   `Layer.ts:2207-2208`.
2. The maintainers treat it as idiomatic. 189 uses in their repo, docstrings that teach
   it, `ai-docs` that teach it to agents, and a migration guide that prescribes it.
3. No ecosystem precedent for the ban exists. The official eslint plugin has no such rule.
4. The genuine smell (an unowned, park-forever fiber) is a fork-shape problem. It is
   already owned by `no-runtime-runfork.grit` and
   `docs/agent-patterns/effect-fiber-lifecycle.md`. A text-level ban on the constructor
   cannot separate the smell from the idiom.

Replacement, so the steering intent survives: add one short section to
`docs/agent-patterns/effect-fiber-lifecycle.md` that names the sanctioned uses
(`Layer.launch`, a scoped background fiber, a never-completing test fixture) and the one
smell (a bare `Effect.never` outside any scope — reach for `Layer.launch` or a
`Deferred` instead). That puts the guidance where an agent reads it at fork time, with
the nuance a grep-shaped rule cannot carry.
