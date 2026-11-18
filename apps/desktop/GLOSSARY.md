# Desktop (mission control shell)

The Electron app that is the primary **daemon host** on a laptop (product ADR 0008). It supervises
the engine as a bundled Node child, keeps a single window that hides instead of quitting, and gives
the renderer a typed seam to the daemon without ever handing it the socket. It speaks the shared
kernel ([contracts](../../packages/contracts/GLOSSARY.md)) over the same RPC transport the
[cli](../cli/GLOSSARY.md) uses.

Built with electron-vite + electron-builder. The renderer stack is React + TanStack Router with
Effect AtomRpc (`@effect/atom-react`) for daemon read-model state and zustand for local chrome; UI
primitives come from [ui](../../packages/ui/GLOSSARY.md) (shadcn + Tailwind v4). See product ADR 0009.

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

### Shell surfaces

The renderer's UI vocabulary, settled while charting the shell-revamp map (orchestration issue #7).
These name the *meaning* of each surface; the visual layout of several is still being prototyped.

**Side panel**:
The contextual right-hand panel of the shell — tabbed, resizable, and expandable to full window. You
assemble it yourself from a **surface catalog**: it starts empty and you add the tabs you want. A tab
is either a **Tool surface** (Attention, Activity, Terminal — one of each) or a **Subject surface**
(one per work item, keyed to it). Tabs are **user-ordered** — you drag them to rearrange — and the
panel remembers them across launches. "Tab" is the human word for a unit of the panel; the renderer's
`Surface` is the code word for what a tab shows — the `attention` / `activity` / `terminal` Tool
kinds, or an `item` Subject keyed by its (workspace, work item) pair.
_Avoid_: Right rail, sidebar (that's the left nav), inspector, fixed / permanent tabs (nothing in the
panel is permanent now).

**Surface catalog**:
The set of Tool surfaces you can add to the side panel — today Attention, Activity, and a Terminal
placeholder. An empty panel shows the catalog as a grid of cards; a panel that already has tabs shows
the same catalog behind a Plus button on the tab strip. Each surface's one module supplies both its
card and its Plus-menu entry, so they never drift.
_Avoid_: Fixed tabs, permanent tabs.

**Tool surface**:
A side-panel tab that is **not** about any single work item and has **one** instance — Attention,
Activity, Terminal. You add it from the surface catalog; adding one that is already open focuses it.
Its identity is its kind alone (`surfaceId` = the kind). "Tool" describes its identity, not its
content — Attention and Activity both stream live. Terminal is a placeholder today (a card that opens
a "coming soon" body); when it is built for real it may become a Subject surface, one per shell
session. In code, each Tool surface is one module owning its tab variant, catalog entry, and body;
the panel composes them at a single point, and the store alone owns tab membership and order.
_Avoid_: Fixed tab, static tab (the content can be live; only the identity is single).

**Subject surface**:
A side-panel tab that **is** about one thing — one instance per subject, its content following that
subject. The **item tab** is the Subject surface today, keyed by (workspace, work item). A future PR
review would be another Subject surface, keyed by a pull request. You open a Subject surface by
clicking its subject (a Feed card, an Attention row), never from the catalog. Identity is kind +
subject key (e.g. `item:<workspace>:<workItem>`).
_Avoid_: Detail tab, dynamic tab (the difference is the subject key, not that the content changes).

**Feed**:
The shell's mission-control home surface — live, queued, and recently-done work items as cards.
Clicking a card opens that item's tab in the side panel. It stays mission-control; there is no
chat-first home.
_Avoid_: Dashboard, home screen, Board / Inbox (both deleted).

**Item tab**:
The **Subject surface** for a work item — a side-panel tab opened by clicking a work item card, one
per work item, keyed to (workspace, work item), titled by its `WorkItemId` (`#50`, `AUD-1`), deduped
(a second open focuses the existing tab) and persistent (no preview state). The canonical drill-in,
and both a context and an action surface: identity, the item's Pull
request, blockers, the live run transcript, previous attempts, and metadata. The Pull-request section
is labelled plainly "Pull request" — never "PR gate".
_Avoid_: Detail tab (there is no single reusable one), preview tab, PR gate (as user-facing copy).

**Attention tab**:
A **Tool surface** you add from the surface catalog, listing the work items that need a person. It
holds two kinds — **Needs a decision** and **Ready to merge** (below) — in one list, filterable by
kind (default: all) and by workspace. Each card is a **launcher**: clicking anywhere on it opens that
item's item tab, where the human acts; a card also carries a quick provider-aware "open on the
tracker / code host" button. Cards show **deterministic** signals only (the reason, wait time, PR
status) — never AI-written prose.
_Avoid_: Inbox (deleted), notifications, needs-human queue, self-halt / merge gate (renamed below),
fixed tab.

**Needs a decision**:
An attention item where the agent stopped and waits on a human — it needs info, or it is ready for a
human to take over (read-model tag `NeedsHuman`, reasons `needs-info` / `ready-for-human`). The human
resolves it through the Workflow action on the **item tab**, not on the attention card. The
agent's triage proposal is AI prose; it lives on the item tab, clearly marked as an AI suggestion.
_Avoid_: Self-halt (jargon), needs-human (the code tag, not the human word).

**Ready to merge**:
An attention item whose read-model tag is `ReadyToMerge`: a pull request ready and waiting for a human. The card
shows its checks / review / base-divergence / wait time; the human opens it on the code host to merge
(no in-app merge).
_Avoid_: Merge gate, PR gate (old jargon; the PR section elsewhere is still labelled "Pull request").

**Activity tab**:
A **Tool surface** you add from the surface catalog, showing the raw daemon event stream, distinct
from the run transcript.
_Avoid_: Transcript (that's the folded per-run view), log, firehose, fixed tab.

**Run transcript**:
A live (or replayed) agent run rendered as **Conversation + Now** inside an item tab: a natural-prose
stream with reasoning / tool calls / diffs folded to one-line rows, over a relocatable "Now" status
line. The item tab is focal on it while a run is live.
_Avoid_: Raw activity (that's the Activity tab), firehose, chat log.

**Step**:
One unit of agent work inside a **run transcript** — a shell command, a file edit, or a recorded
thought — drawn as a single row of verb, target and outcome. Consecutive steps fold into one group so
a long tool chain never buries the notes either side of it. A step is what the agent *did*; a **note**
is what it *said* (the Operation result's summary, which this harness emits in place of prose).
_Avoid_: Tool call (only some steps are tool calls), activity (that's the daemon event stream), event.

**Provider** (settings section):
Anything cogwork can send work to. Today every Provider is a **Harness**, so the section lists
harnesses and nothing else; the word is the wider one because the set is expected to widen. That is
why the glossary's `_Avoid_: provider` on **Harness** still holds: a Harness is not *called* a
provider, it *is* one kind of Provider. The section reports **Harness state** and machine-local
enablement per Harness. Disabled Harnesses stay visible first with muted treatment, disappear from
new Operation choices, and remain visible when an existing Operation still selects one.
_Avoid_: Harnesses (as the section's name — only as what it currently lists), Models (that is one of
its tabs), Source control provider (a different noun in contracts)

**Provider picker**:
The per-Operation control that selects a Provider and its model. It offers every enabled Provider
for every Operation. Permissions is a select constrained to the chosen Provider's declared
profiles; the Operation supplies the default when the Provider declares it. An unavailable Provider
(not installed, not signed in, failed probe) stays visible with its state but cannot be newly picked;
a saved selection survives unavailability and shows the state. A Provider whose readiness is still
unknown stays pickable — the picker never waits on a probe.
_Avoid_: Harness rail (implementation detail), model dropdown, provider switcher

**Traits**:
The per-model options menu beside the model picker, rendered generically from the selected model's
option descriptors: one radio group per select axis, On/Off per boolean. It hard-codes no Harness's
axes; a model with no descriptors shows no Traits control. What it saves is the contracts term
**model options**.
_Avoid_: Effort dropdown (one axis of it, the old UI), parameters, model settings

## Cross-context edges

- **desktop → cli.** In development the supervisor spawns the CLI `daemon` command as the engine
  child; the CLI remains the one place that composes the engine's host adapters. A packaged build
  ships its own bundled engine entry (signing/distribution is human-paired and not built here).
- **desktop → contracts.** The renderer builds its AtomRpc client from `DaemonRpcs` and decodes the
  contracts read models (`DaemonStatus`, `DaemonEvent`) itself; `main` only relays the wire frames
  (see the **RPC relay** concept above). Contracts is bundled into the renderer build so its schemas
  are available without a separate build step.
