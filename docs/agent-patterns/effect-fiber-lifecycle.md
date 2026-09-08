# Effect fiber lifecycle

Use this reference when work runs on a fiber other than the caller's: background loops, registries of running work, and Promise-shaped callbacks that need to run effects. It covers forking, supervision, and runtime re-entry, not control flow or deadlines.

## Model

Every fiber has an owner, and its failure must land somewhere.

- Effect v4 removed plain `Effect.fork`. `Effect.forkChild` ties the fiber to the parent; `Effect.forkScoped` and `Effect.forkIn` tie it to a scope; `Effect.forkDetach` deliberately detaches it.
- A forked fiber's failure is observed by a joining caller, a completed `Deferred`, or a supervisor that logs the cause. A defect nobody observes is a silent outage.
- Interruption is a normal exit path. Cleanup must run on it, and supervisors must not report it as a crash.
- The runtime is entered once per process boundary, not once per callback.

## Choose the smallest operator

| Need | Prefer |
| --- | --- |
| Background work tied to the current workflow | `Effect.forkChild` |
| Background work tied to a service's lifetime | `Effect.forkScoped` inside the owning layer |
| A registry of running fibers keyed by domain id | `FiberMap` |
| A dynamic set of fibers with await and clear | `FiberSet` |
| Hand a result to a waiting caller across fibers | `Deferred`, completed on every exit path |
| Run effects from a Promise-shaped callback | `FiberSet.makeRuntimePromise` |

## Supervise the worker loop

A `Queue.take → Effect.forever → forkScoped` loop is the right shape for a request/response worker, but the loop body needs a supervisor. Without one, a defect in the body kills the fiber silently and every later `Deferred.await` blocks forever.

```ts
const drain = Queue.take(queue).pipe(
  Effect.flatMap((job) =>
    reconcile(job).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("reconcile crashed", { cause }).pipe(
          Effect.andThen(Deferred.failCause(job.receipt, cause)),
        ),
      ),
    ),
  ),
  Effect.forever,
);
yield* Effect.forkScoped(drain);
```

`Deferred.failCause` type-checks here because the loop body's typed errors are already handled, so the handler receives a `Cause<never>`. When the body keeps a typed error channel, make the receipt a `Deferred<A, E>` so failures fit.

Two rules make the seam safe:

- The loop settles the job's `Deferred` on every exit path, so a caller always gets an answer.
- The caller bounds its wait: `Deferred.await(receipt).pipe(Effect.timeout("30 seconds"))`. A worker that stops draining becomes a visible failure instead of a wedged daemon.

## A keyed fiber registry is FiberMap

A `Ref<Map<Id, Fiber>>` with `register`, `unregister`, and `cancel` reimplements `FiberMap` with two bugs: the read-then-interrupt in `cancel` is not atomic, and every caller must remember `Effect.ensuring(unregister)` or leak an entry.

```ts
const fibers = yield* FiberMap.make<RunId>();

// registration: run the work through the map, keyed by run id
const fiber = yield* FiberMap.run(fibers, runId, claimedRun);

// cancellation: interrupts the fiber if present, no-op otherwise
const cancel = (runId: RunId) => FiberMap.remove(fibers, runId);
```

`FiberMap.make` requires a `Scope`, so create it in the owning layer's `Effect.gen` body: closing the layer interrupts everything still running. Completed fibers remove themselves, which deletes the manual `unregister` and its `ensuring` at every call site. `FiberMap.run` with the same key replaces the previous fiber, which is the correct semantics for "one active run per id".

## Interruption is not a crash

Supervisors and finalizers must distinguish drain from failure.

- Test the cause before reporting: `Cause.hasInterruptsOnly(cause)` means the fiber was drained, everything else is a crash. The scheduler's `Effect.catchCauseIf((cause) => !Cause.hasInterruptsOnly(cause), ...)` is the house pattern.
- Cleanup that must run on interruption goes in `Effect.ensuring` or `Effect.onExit`. `Effect.tapError` never sees interruption: a `git rebase` aborted only via `tapError` leaves the worktree stuck in rebase-in-progress when the daemon drains mid-run.

```ts
runGit(worktreePath, ["rebase", `${remote}/${branch}`, branch]).pipe(
  Effect.onExit((exit) =>
    Exit.isSuccess(exit) ? Effect.void : Effect.ignore(runGit(worktreePath, ["rebase", "--abort"])),
  ),
);
```

## Re-enter the runtime once, not per call

A Promise-shaped callback contract (tool handlers, persistence hooks, middleware) must not call `Effect.runPromise` inside an already-running effect. Each call forks a fresh root fiber: services, spans, log annotations, and interruption are all severed from the run that triggered it, and any `Effect.provide` inside the callback rebuilds its layer on every call.

Acquire a runner once, in the scope where the callback set is constructed, and close over it:

```ts
// in the scoped constructor that builds the tool set
const runPromise = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>();

// each Promise-shaped handler becomes a thin adapter
(args: unknown): Promise<Result> =>
  runPromise(decode(args).pipe(Effect.flatMap((decoded) => handler(sandbox, decoded))));
```

What this buys:

- Cancelling the run interrupts in-flight tool work, because the forked fibers are children of the capturing scope.
- `Effect.fn` spans inside handlers nest under the run's span instead of becoming detached roots.
- Services come from the captured context, so per-call `Effect.provide(FetchHttpClient.layer)` disappears and layer memoization works.

`Effect.runPromise` remains correct at true process entrypoints, where no runtime exists yet.

## Effect.never holds a place, not a resource

`Effect.never` is a suspended effect that only interruption can end. It holds no resources and installs no work. It cannot leak by itself; a leak needs an unowned fiber, and the fork rules above already govern fiber ownership.

Sanctioned uses:

- Keep a built layer alive until interruption. `Layer.launch` is exactly this: it builds the layer inside a scope and then runs `Effect.never`, so closing the scope runs every finalizer.
- Stand in for "a task that never completes" in interruption and timeout tests. This is the canonical fixture in Effect's own test suite.
- Park a daemon fiber that exists only for its finalizers, forked with `Effect.forkScoped` so the owning scope ends it.

The one smell: a bare `Effect.never` outside any scope, used as a lazy "keep the process alive". Nothing owns it, so nothing can end it cleanly. Use `Layer.launch` for an app entrypoint, or a `Deferred` when a specific event should end the wait.

## Cogwork conventions

- Fork long-lived work with `Effect.forkScoped` inside the owning layer. Never use `Effect.forkDetach` in the engine.
- Every `Deferred.await` at a service seam carries a timeout; see the time-bounds pattern.
- Registries of running work are `FiberMap` or `FiberSet`, not `Ref<Map<_, Fiber>>`.
- `Effect.runPromise` appears only in process entrypoints; inside the daemon, capture a runner with `FiberSet.makeRuntimePromise`.
- Check `Cause.hasInterruptsOnly` before logging or ledgering a crash.

## Sources

- `.repos/effect/packages/effect/src/FiberMap.ts`: `make` is scoped, `run` replaces by key, `remove` interrupts, completed fibers self-remove.
- `.repos/effect/packages/effect/src/FiberSet.ts`: `makeRuntimePromise` returns a context-preserving `(effect) => Promise`.
- `.repos/effect/packages/effect/src/Effect.ts`: `forkChild`, `forkScoped`, `forkIn`, `forkDetach`; plain `fork` no longer exists in v4.
- `.repos/effect/packages/effect/src/internal/effect.ts:1172`: `Effect.never` is `callback<never>(constVoid)` — suspended, interruptible, resource-free.
- `.repos/effect/packages/effect/src/Layer.ts:2207`: `Layer.launch` is `scoped(andThen(build(self), never))`.
- `packages/engine/src/scheduler.ts`: `FiberSet` with `awaitEmpty`, `clear`, and interrupt-aware crash reporting — the in-repo exemplar.
- `packages/engine/src/reconcile.ts`: the supervised worker loop with a bounded receipt await — the in-repo exemplar of this pattern's supervision section.
- `packages/engine/src/run-control.ts`: the in-repo `FiberMap` registry keyed by run id (`cancel` must still read-and-interrupt in one atomic step, not `has` then `remove`).
- `packages/engine/src/tools/owned-tools.ts`: the Promise-shaped tool boundary.
- `apps/cli/src/platform.ts`: the `git rebase --abort` cleanup wired through `Effect.onExit` — the source of this doc's example.
- `.repos/opencode/packages/opencode/src/control-plane/workspace.ts`: `FiberMap` keyed by workspace id for sync loops.
- `.repos/opencode/packages/opencode/src/effect/runner.ts`: converting interrupt-only causes into a typed `Cancelled` failure.
