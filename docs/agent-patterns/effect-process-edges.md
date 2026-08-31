# Effect process edges

Use this reference when a process starts, when a non-Effect host must call into Effect, or when a socket, subprocess, or event emitter enters Effect code. It covers where the runtime begins and how handles get owned, not fiber supervision (see the fiber-lifecycle pattern) or deadlines (see the time-bounds pattern).

## Model

Every process has exactly one Effect runtime, and every external handle inside it belongs to a scope.

- A process that is the layer graph enters through `NodeRuntime.runMain`. A process owned by a non-Effect host (Electron main, a framework's handlers) builds one `ManagedRuntime` at startup and disposes it at shutdown.
- Callback sources are converted to Effect once, at the edge, by an adapter that also owns the cleanup. Nothing outside the adapter touches the raw handle.
- A handle held in a mutable field with a hand-written `dispose()` is a scope written by hand, minus the guarantees. `state.socket !== socket` stale-callback guards are the tell.
- Observable process state is a `SubscriptionRef`, not an `onStatus` callback. Restart budgets and poll intervals are `Schedule`s, not counters and recursion.

The in-repo contrast is the desktop app: the renderer's daemon protocol solves connect–reconnect–fan-out with `Queue`, `Deferred`, `Effect.addFinalizer`, `Schedule.spaced`, and `forkScoped`, while the main process solves the same socket problem next door with mutable cells, `removeAllListeners`, and no retry. The runtime currently stops at the IPC boundary; this pattern is how the other half gets one.

## Choose the smallest operator

| Need | Prefer |
| --- | --- |
| The process is the layer graph (CLI, daemon) | `NodeRuntime.runMain`, with `Layer.launch` when the app is all layers |
| A non-Effect host calls in | one `ManagedRuntime.make` per process, `dispose()` at shutdown |
| Runtimes that must share service instances | a shared `Layer.MemoMap` (`Layer.makeMemoMapUnsafe`) passed to each `make` |
| One-shot callback API as an effect | `Effect.callback` |
| Event emitter as a stream | `Stream.callback` with `Effect.acquireRelease` inside |
| Node `Readable` (child stdout, socket data) as a stream | `NodeStream.fromReadable` (+ `Stream.decodeText`, `Stream.splitLines`) |
| Unix or TCP socket | `NodeSocket.makeNet` / `NodeSocket.layerNet` |
| Spawn and own a subprocess | `ChildProcess.make` run through `ChildProcessSpawner` |
| Status other code watches | a `SubscriptionRef` on the service interface |
| Bounded restarts, spaced polls | `Schedule.recurs`, `Effect.repeat(Schedule.spaced(...))` |

## Two entrypoint shapes

The CLI is the first shape: the process is Effect from `main` down, and `runMain` owns SIGINT/SIGTERM and interrupts fibers for graceful shutdown.

```ts
NodeRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
);
```

`Layer.launch` turns an all-layers app into the `Effect<never>` that `runMain` runs. It never returns, so it is wrong for a host that must keep its own event loop.

That host — Electron main is ours — is the second shape: build one `ManagedRuntime` where the host starts (`app.whenReady`), call `runtime.runPromise(...)` from its handlers, and `runtime.dispose()` where it stops (`will-quit`). `dispose()` closes the runtime's root scope, so every finalizer registered along the way runs; the idempotence that `control.engineStopped` and `event.preventDefault()` hand-roll today comes for free.

```ts
export const appMemoMap = Layer.makeMemoMapUnsafe();
export const runtime = ManagedRuntime.make(mainLayer, { memoMap: appMemoMap });

ipcMain.handle("engine:status", () => runtime.runPromise(supervisor.status));
app.on("will-quit", () => void runtime.dispose());
```

Two `ManagedRuntime.make` calls without a shared `memoMap` build separate instances of every shared layer. The engine already documents an invariant that depends on memoization — the credential store's refresh gate coordinates only within one instance — so any second runtime in a process passes the shared map or breaks it silently.

This shape is for processes with no runtime yet. Inside an already-running Effect app, a Promise-shaped callback captures a runner with `FiberSet.makeRuntimePromise` instead — see the fiber-lifecycle pattern.

## Convert callbacks once, at the edge

`Effect.callback` is the one-shot form (v4 renamed `Effect.async`; `resume` takes an Effect, and the register function may return a cleanup effect that runs if the fiber is interrupted):

```ts
const isDaemonListening = (socketPath: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = net.connect({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeout("500 millis"), Effect.orElseSucceed(() => false));
```

Each resume path closes its own socket; the returned cleanup covers only interruption — here, the path where `Effect.timeout` wins, which `socket-probe.ts` hand-threads through `socket.setTimeout`. The recursive poll around it (`wait-for-socket.ts`, `signal.aborted` checks and a self-call) becomes a schedule:

```ts
const waitForDaemonListening = (socketPath: string) =>
  isDaemonListening(socketPath).pipe(
    Effect.repeat({ until: (listening) => listening, schedule: Schedule.spaced("50 millis") }),
  );
```

with the caller's deadline as an ordinary `Effect.timeout` instead of a threaded `AbortSignal`.

An event emitter becomes a stream through `Stream.callback`, which hands the adapter a `Queue` and runs the registration effect with a `Scope` in context; subscribe/unsubscribe live in one `acquireRelease`:

```ts
Stream.callback<EngineStatus>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const handler = (status: EngineStatus) => Queue.offerUnsafe(queue, status);
      emitter.on("status", handler);
      return handler;
    }),
    (handler) => Effect.sync(() => emitter.off("status", handler)),
  ),
);
```

A Node `Readable` does not need even that: `NodeStream.fromReadable({ evaluate: () => child.stdout })` piped through `Stream.decodeText()` and `Stream.splitLines` replaces `.on("data", chunk => log(chunk.toString()))` — which also fixes the line split across two chunks that the current supervisor logs as two lines.

## Handles belong to scopes

`daemon-bridge.ts` is the shape to retire: a mutable `{ socket }` cell, `removeAllListeners()` in a manual `detach`, stale-callback identity guards, and a `dispose` the caller must remember. The first-party replacement is `NodeSocket.makeNet({ path: socketPath, openTimeout: "10 seconds" })`, which returns a `Socket` whose teardown is a scope finalizer — the connect promise, the probe timeout, and the disposal bookkeeping all disappear into the option and the scope.

The caller-side bookkeeping is the same finding: the IPC layer keeps a `Map<number, DaemonBridgePort>` keyed by renderer id and tears entries down on a `destroyed` event. That is a scope per renderer written by hand; open a child `Scope` per renderer, run the socket in it, close the scope on `destroyed`.

This does not move any protocol logic. The CONTEXT.md rule that `main` is a dumb pipe — never decoding RPC, all client logic in the renderer — constrains what main understands, not how it owns its socket. A scope-owned `Socket` relaying opaque frames is still a dumb pipe.

## A subprocess is acquired, and its release is a kill ladder

The supervised engine child is owned by class fields today, and `stop()` awaits an exit that may never come — a child that ignores SIGTERM hangs quit forever. The idiomatic shape acquires the process and gives the release a bounded escalation:

```ts
const child = yield* Effect.acquireRelease(spawnEngine(command), (proc) => {
  const attempt = sendSignal(proc, "SIGTERM").pipe(Effect.andThen(Deferred.await(proc.exit)));
  return Effect.timeoutOrElse(attempt, {
    duration: "5 seconds",
    orElse: () => sendSignal(proc, "SIGKILL").pipe(Effect.andThen(Deferred.await(proc.exit))),
  }).pipe(Effect.ignore);
});
```

The exit event becomes awaitable by completing a `Deferred` from `child.once("exit", ...)` at spawn time. Release never fails and never hangs; closing the owning scope (the `ManagedRuntime`'s, on `will-quit`) is the whole shutdown story.

Prefer not building this by hand at all: `ChildProcess.make` + `ChildProcessSpawner` (`effect/unstable/process` — v4's rename of `Command`; `effect/unstable/cli/Command` is argument parsing, a different thing) carries the ladder as `forceKillAfter`, and streams stdout/stderr. The CLI already runs its subprocesses through `ChildProcessSpawner`; the desktop supervisor is the only shipping raw `spawn` in the repo.

## Status is a SubscriptionRef, restarts are a Schedule

The supervisor's `#status` field, equality dedupe, and `onStatus` callback are `SubscriptionRef` written by hand. Put the ref on the service interface — the shape t3code uses for `networkStatus` — and consumers subscribe to `.changes` as a stream; the IPC broadcast becomes one `Stream.runForEach` fork instead of a callback threaded through options.

```ts
readonly status: SubscriptionRef.SubscriptionRef<EngineStatus>;
```

The `#restarts` counter and `#maxRestarts` cap are `Schedule.recurs(3)` on the supervise loop; `#shuttingDown` is the interruption distinction the fiber-lifecycle pattern already names (`Cause.hasInterruptsOnly`), not a boolean.

The same edge discipline applies inside harness adapters: cursor-acp's manual `reader.read()` loop with `try/finally { releaseLock() }` is `Stream.fromReadableStream`, and its `outbound.tail` promise chain is a one-permit `Semaphore` — the repo's own lint suppressions (`asyncFunction:off`) mark exactly these seams.

## Cogwork conventions

- One Effect runtime per process. The CLI and daemon enter through `NodeRuntime.runMain`; a non-Effect host builds one `ManagedRuntime` at startup and disposes it at shutdown — never a runtime per call or per handler.
- Runtimes that must share service instances pass one shared `Layer.MemoMap`.
- Raw `spawn`, `net.createConnection`, `.on("data")`, and `new Promise` around events live only inside an edge adapter that immediately produces an Effect, Stream, or Socket with scope-owned cleanup. Stale-handle identity guards and `removeAllListeners` are the smell that the adapter is missing.
- Subprocesses go through `ChildProcessSpawner`; a hand-rolled spawn carries an `acquireRelease` whose release is a bounded SIGTERM-then-SIGKILL ladder.
- Status other code watches is a `SubscriptionRef` on the service; restart budgets and probe intervals are `Schedule`s.
- Host loggers forward into Effect's logger, not around it (see the observability pattern).
- v4 names: `Effect.callback` (not `Effect.async`), `ChildProcess`/`ChildProcessSpawner` (not `Command`), and `runMain` exists only on `@effect/platform-node`'s `NodeRuntime`.

## Sources

- `.repos/effect/packages/effect/src/ManagedRuntime.ts`: `make` (optional shared `memoMap`), `dispose` closes the root scope and poisons further use.
- `.repos/effect/packages/effect/src/Effect.ts`: `callback` — `resume` takes an Effect, and the register may return a cleanup effect that runs on interruption.
- `.repos/effect/packages/effect/src/Stream.ts`: `callback` hands the adapter a `Queue` and scopes its registration effect; `fromReadableStream`, `fromAsyncIterable`.
- `.repos/effect/packages/platform/node-shared/src/NodeStream.ts` and `NodeSocket.ts` (import from `@effect/platform-node`): `fromReadable`; `makeNet` with `openTimeout` and a scope-finalized teardown.
- `.repos/effect/packages/effect/src/unstable/process/ChildProcess.ts` and `ChildProcessSpawner.ts`: the v4 subprocess API.
- `.repos/effect/ai-docs/src/01_effect/06_running/10_run-main.ts` and `20_layer-launch.ts`: the two entrypoint shapes.
- `.repos/effect/ai-docs/src/04_integration/10_managed-runtime.ts`: shared `MemoMap`, one runtime for a non-Effect host, dispose on shutdown signal.
- `apps/cli/src/main.ts`: the in-repo `runMain` entrypoint.
- `apps/desktop/src/renderer/src/daemon/protocol.ts`: the in-repo exemplar — scope-owned subscriptions, `Deferred` connection gate, `Schedule.spaced` reconnect.
- `apps/desktop/src/main/engine-supervisor.ts`, `daemon-bridge.ts`, `socket-probe.ts`, `wait-for-socket.ts`, `ipc.ts`: the hand-rolled shapes this pattern replaces.
- `apps/desktop/CONTEXT.md` ("Engine supervisor", "RPC relay"): the behavioral spec, including the dumb-pipe rule this pattern preserves.
- `packages/engine/src/daemon.ts`: the shared-credential-store comment — the memoization invariant a second runtime must not break.
- `.repos/opencode/packages/core/src/cross-spawn-spawner.ts`: the production SIGTERM→SIGKILL release ladder and `NodeStream.fromReadable` stdout.
- `.repos/opencode/packages/core/src/effect/runtime.ts` and `memo-map.ts`: one module-level `MemoMap` shared by every runtime.
- `.repos/t3code/packages/client-runtime/src/connection/registry.ts`: `SubscriptionRef` status on a service interface.
- `.repos/t3code/apps/web/src/connection/platform.ts`: `Stream.callback` + `acquireRelease` over a non-Effect emitter.
