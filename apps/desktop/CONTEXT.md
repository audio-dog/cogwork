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
The `main`-side owner of the engine's lifecycle. It **starts the engine at launch**: it probes the
socket and either **adopts** a daemon already listening or **spawns** one; it pipes the child's
output to the log, restarts it a bounded number of times on unexpected exit, and stops it on Quit.
Starting the engine is not the same as starting scheduling — a daemon this app spawns is born with
scheduling **paused** (the `--start-paused` flag), so launch never silently spends budget; the person
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
Runtime start/stop of the engine from the renderer, through the seam (`setEngineEnabled`) and shown
as a switch in the header. On drives the supervisor's adopt-or-spawn; off stops a spawned engine.
The engine starts at launch, so the toggle is normally already on; it is the way to stop and restart
the engine, not the way to boot it. Do not confuse it with the header **scheduling** toggle: the
engine being on means the daemon runs, while scheduling being live means it starts new runs — launch
leaves the engine on but scheduling paused. The switch reflects real engine status, not a local
guess — it follows the same status broadcasts as the rest of the UI.
_Avoid_: A separate "enabled" preference that can drift from the supervisor's actual state

### Shell surfaces

The renderer's UI vocabulary, settled while charting the shell-revamp map (orchestration issue #7).
These name the *meaning* of each surface; the visual layout of several is still being prototyped.

**Side panel**:
The contextual right-hand panel of the shell — tabbed, resizable, and expandable to full window. It
holds a couple of fixed tabs (Attention, Activity) alongside per-work-item tabs. "Tab" is the human
word for a unit of the panel; the renderer's `Surface` is the code word for what a tab shows — the
fixed `attention` / `activity` kinds, or an `item` keyed by its (workspace, work item) pair.
_Avoid_: Right rail (the old fixed form), sidebar (that's the left nav), inspector.

**Feed**:
The shell's mission-control home surface — live, queued, and recently-done work items as cards.
Clicking a card opens that item's tab in the side panel. It stays mission-control; there is no
chat-first home.
_Avoid_: Dashboard, home screen, Board / Inbox (both deleted).

**Item tab**:
A side-panel tab opened by clicking a work item card — one per work item, titled by its `WorkItemId`
(`#50`, `AUD-1`), deduped (a second open focuses the existing tab) and persistent (no preview state).
The canonical drill-in, and both a context and an action surface: identity, triage
approve/reclassify, the item's Pull request, blockers, the live run transcript, previous attempts,
and metadata. The Pull-request section is labelled plainly "Pull request" — never "PR gate".
_Avoid_: Detail tab (there is no single reusable one), preview tab, PR gate (as user-facing copy).

**Attention tab**:
The fixed side-panel tab listing the work items that need a person. It holds two kinds — **Needs a
decision** and **Ready to merge** (below) — in one list, filterable by kind (default: all) and by
workspace. Each card is a **launcher**: clicking anywhere on it opens that item's item tab, where the
human acts; a card also carries a quick provider-aware "open on the tracker / code host" button.
Cards show **deterministic** signals only (the reason, wait time, PR status) — never AI-written prose.
_Avoid_: Inbox (deleted), notifications, needs-human queue, self-halt / merge gate (renamed below).

**Needs a decision**:
An attention item where the agent stopped and waits on a human — it needs info, or it is ready for a
human to take over (read-model tag `NeedsHuman`, reasons `needs-info` / `ready-for-human`). The human
resolves it with triage approve/reclassify on the **item tab**, not on the attention card. The
agent's triage proposal is AI prose; it lives on the item tab, clearly marked as an AI suggestion.
_Avoid_: Self-halt (jargon), needs-human (the code tag, not the human word).

**Ready to merge**:
An attention item that is a pull request ready and waiting for a human (PR review `ready`). The card
shows its checks / review / base-divergence / wait time; the human opens it on the code host to merge
(no in-app merge).
_Avoid_: Merge gate, PR gate (old jargon; the PR section elsewhere is still labelled "Pull request").

**Activity tab**:
The fixed side-panel tab showing the raw daemon event stream, distinct from the run transcript.
_Avoid_: Transcript (that's the folded per-run view), log, firehose.

**Run transcript**:
A live (or replayed) agent run rendered as **Conversation + Now** inside an item tab: a natural-prose
stream with reasoning / tool calls / diffs folded to one-line rows, over a relocatable "Now" status
line. The item tab is focal on it while a run is live.
_Avoid_: Raw activity (that's the Activity tab), firehose, chat log.

## Cross-context edges

- **desktop → cli.** In development the supervisor spawns the CLI `daemon` command as the engine
  child; the CLI remains the one place that composes the engine's host adapters. A packaged build
  ships its own bundled engine entry (signing/distribution is human-paired and not built here).
- **desktop → contracts.** The renderer builds its AtomRpc client from `DaemonRpcs` and decodes the
  contracts read models (`DaemonStatus`, `DaemonEvent`) itself; `main` only relays the wire frames
  (see the **RPC relay** concept above). Contracts is bundled into the renderer build so its schemas
  are available without a separate build step.
