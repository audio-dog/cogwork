# Desktop (mission control shell)

The Electron app that is the primary **daemon host** on a laptop (product ADR 0008). It supervises
the engine as a bundled Node child, keeps a single window that hides instead of quitting, and gives
the renderer a typed seam to the daemon without ever handing it the socket. It speaks the shared
kernel ([contracts](../../packages/contracts/CONTEXT.md)) over the same RPC transport the
[cli](../cli/CONTEXT.md) uses.

Built with electron-vite + electron-builder. The renderer stack (React, TanStack Router, AtomRpc,
zustand, shadcn) lands in a later slice (product ADR 0009); this slice is the shell only.

## Language

**Desktop shell**:
The Electron process tree — a `main` process that owns app lifecycle, the engine child, and the
socket; a `preload` that exposes the typed bridge; and a `renderer` that draws the UI. On a laptop
it is the primary daemon host; the CLI stays the headless host for CI/SSH.
_Avoid_: App (ambiguous with the whole product), frontend (the renderer is only one third)

**Engine supervisor**:
The `main`-side owner of the engine's lifecycle. On launch it probes the socket and either
**adopts** a daemon already listening or **spawns** one; it pipes the child's output to the log,
restarts it a bounded number of times on unexpected exit, and stops it on Quit. The child is a real
Node process (`electron-vite` dev runs the CLI `daemon` through tsx; a packaged build runs a bundled
engine entry), never `ELECTRON_RUN_AS_NODE` or `utilityProcess`, so the RunAsNode fuse stays off
(ADR 0008).
_Avoid_: Engine (that's the thing being supervised), worker/utility process (the rejected Electron
primitives)

**Adopt**:
Reusing an engine already listening on the socket instead of spawning a second one — what makes a
second app launch, or an app launched beside a headless daemon, converge on one engine. An adopted
engine is left running on Quit; only an engine this app spawned is stopped.
_Avoid_: Attach, connect (the RPC client connects; adoption is the supervisor's spawn-or-not
decision)

**Close-to-hide**:
Closing the window hides it and leaves the engine running; the app stays in the dock and tray. Quit
(from the tray, or the platform quit) is the only path that stops a spawned engine — it drains
in-flight runs via `SIGTERM`, then exits.
_Avoid_: Minimize to tray (hiding is not minimizing), background mode

**Typed IPC seam**:
The single `main`↔`renderer` boundary. The renderer calls typed methods exposed through the preload
`contextBridge` (`window.clankerForge`); `main` answers them by driving the Effect RPC client over
the Unix socket. The renderer never opens the socket and never imports Effect RPC — the seam is the
only way it reaches the daemon.
_Avoid_: Direct socket access from the renderer, ad-hoc `ipcRenderer` channels outside the bridge

## Cross-context edges

- **desktop → cli.** In development the supervisor spawns the CLI `daemon` command as the engine
  child; the CLI remains the one place that composes the engine's host adapters. A packaged build
  ships its own bundled engine entry (signing/distribution is human-paired and not built here).
- **desktop → contracts.** `main` builds the RPC client from `DaemonRpcs` and returns
  contracts read models (`DaemonStatus`) across the IPC seam. Contracts is bundled into the `main`
  build so its schemas are available without a separate build step.
