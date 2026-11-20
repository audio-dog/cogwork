# Desktop glossary: Shell

Part of the [desktop glossary](./GLOSSARY.md).

**Desktop shell**:
The Electron process tree — a `main` process that owns app lifecycle, the engine child, and the
socket; a `preload` that exposes the typed bridge; and a `renderer` that draws the UI. On a laptop
it is the primary daemon host; the CLI stays the headless host for CI/SSH.
_Avoid_: App (ambiguous with the whole product), frontend (the renderer is only one third)

**Engine supervisor**:
The `main`-side owner of the engine's lifecycle. It **starts the engine at launch**: it probes the
socket and either **adopts** a daemon already listening or **spawns** one; it pipes the child's
output to the log, restarts it a bounded number of times on unexpected exit, and stops it on Quit.
Starting the engine is not the same as starting scheduling — every daemon is born with scheduling
**paused**, so launch never silently spends budget; the person
starts scheduling with the header toggle. A restart re-spawns paused for the same reason. The child
is a real
Node process (`electron-vite` dev runs the CLI `daemon` through tsx; a packaged build runs a bundled
engine entry), never `ELECTRON_RUN_AS_NODE` or `utilityProcess`. Not needing that env var at runtime
is what lets us flip the RunAsNode fuse **off** at build time — the packaged binary sets
`runAsNode: false` (plus sibling hardening fuses) via `electronFuses` in `electron-builder.yml`, so a
packaged app ignores `ELECTRON_RUN_AS_NODE=1` entirely (ADR 0008).
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
(`window.cogwork`). It carries two kinds of traffic: typed engine-control methods
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
The seam for runtime start/stop of the engine from the renderer (`setEngineEnabled`): on drives the
supervisor's adopt-or-spawn, off stops a spawned engine. The engine starts at launch and the
supervisor keeps it running, so the header shows no engine switch or status badge — it carries only
the **scheduling** toggle. Do not confuse the two: the engine being on means the daemon runs, while
scheduling being live means it starts new runs — launch leaves the engine on but scheduling paused.
The start/stop seam and its status broadcasts stay wired: the feed and activity views use the status
to show an "engine is off" card, and the planned degraded-state "turn on engine" action (issue #7)
will call the seam. It is not surfaced as a header control today.
_Avoid_: A separate "enabled" preference that can drift from the supervisor's actual state;
re-adding an always-on engine switch or status badge to the header

**Activity session**:
The renderer's one fold over the daemon event stream: the Board, run-activity previews, the
activity log rows, and the engine/connection lifecycle, delivered through one provider
(`ActivitySessionProvider`, mounted at the root route). `useBoard` is its narrowed read for
components that need only the Board. There is exactly one live instance; a test supplies its own
by rendering the same context with a literal session.
_Avoid_: Board (the contracts view this contains), activity feed (the Activity tab renders this,
it is not this), session (the harness's conversation — unrelated)

