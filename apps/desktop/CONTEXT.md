# Desktop (mission control shell)

The Electron app that is the primary **daemon host** on a laptop (product ADR 0008). It supervises
the engine as a bundled Node child, keeps a single window that hides instead of quitting, and gives
the renderer a typed seam to the daemon without ever handing it the socket. It speaks the shared
kernel ([contracts](../../packages/contracts/CONTEXT.md)) over the same RPC transport the
[cli](../cli/CONTEXT.md) uses.

Built with electron-vite + electron-builder. The renderer stack is React + TanStack Router with
Effect AtomRpc (`@effect/atom-react`) for daemon read-model state and zustand for local chrome; UI
primitives come from [ui](../../packages/ui/CONTEXT.md) (shadcn + Tailwind v4). See product ADR 0009.

## Language

**Desktop shell**:
The Electron process tree — a `main` process that owns app lifecycle, the engine child, and the
socket; a `preload` that exposes the typed bridge; and a `renderer` that draws the UI. On a laptop
it is the primary daemon host; the CLI stays the headless host for CI/SSH.
_Avoid_: App (ambiguous with the whole product), frontend (the renderer is only one third)

**Engine supervisor**:
The `main`-side owner of the engine's lifecycle. It stays idle at launch by default (set
`CLANKER_FORGE_ENGINE_AUTOSTART=1` to start on boot); once started it probes the socket and either
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
The single `main`↔`renderer` boundary, exposed through the preload `contextBridge`
(`window.clankerForge`). It carries two kinds of traffic: typed engine-control methods
(`getEngineStatus` / `setEngineEnabled` / `onEngineStatus`), and the daemon **RPC relay**. The
renderer never opens the socket — the seam is the only way it reaches the daemon.
_Avoid_: Direct socket access from the renderer, ad-hoc `ipcRenderer` channels outside the bridge

**RPC relay**:
How the renderer's Effect RPC / AtomRpc client reaches the daemon without touching the socket (product
ADR 0009). The renderer runs a custom `RpcClient.Protocol` that speaks the ndjson wire and hands each
frame to `main` (`rpc:send`); `main` holds one Unix-socket connection per renderer and relays frames
back (`rpc:data` / `rpc:closed`). `main` is a dumb pipe — it never decodes the RPC; all client logic
(request routing, stream pulls, reconnect, retry) lives in the renderer protocol. A per-attempt
connection gate makes the first request wait for the first connect, fail fast if it fails, and park
later requests until a reconnect lands.
_Avoid_: Decoding or interpreting RPC in `main`, a second transport for read-model state (use AtomRpc)

**Engine toggle**:
Runtime start/stop of the engine from the renderer, through the seam (`setEngineEnabled`) and shown
as a switch in the header. On drives the supervisor's adopt-or-spawn; off stops a spawned engine.
Because the engine is idle at launch (unless `CLANKER_FORGE_ENGINE_AUTOSTART=1`), debugging the app
never accidentally starts a daemon. The switch reflects real engine status, not a local guess — it
follows the same status broadcasts as the rest of the UI.
_Avoid_: A separate "enabled" preference that can drift from the supervisor's actual state

## Cross-context edges

- **desktop → cli.** In development the supervisor spawns the CLI `daemon` command as the engine
  child; the CLI remains the one place that composes the engine's host adapters. A packaged build
  ships its own bundled engine entry (signing/distribution is human-paired and not built here).
- **desktop → contracts.** The renderer builds its AtomRpc client from `DaemonRpcs` and decodes the
  contracts read models (`DaemonStatus`, `DaemonEvent`) itself; `main` only relays the wire frames
  (see the **RPC relay** concept above). Contracts is bundled into the renderer build so its schemas
  are available without a separate build step.
