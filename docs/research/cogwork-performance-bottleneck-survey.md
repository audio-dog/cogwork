# Where the cost lives when 6–8 agents run at once

Symptom under survey: with 6 concurrent coding agents the whole machine chugs; at 8 the app appears to crash. This survey maps where that cost most plausibly lives, with file:line citations from this repo. Anything not confirmable from the code is marked **hypothesis to measure**.

**Sources.** The engine, contracts, cli, desktop, codex-cli and cursor-acp packages read directly at the worktree for issue 102; the installed `@effect/sql-sqlite-node@4.0.0-rc.112` and `effect@4.0.0-rc.112` sources (resolved under the main checkout's `node_modules/.pnpm/`); `GLOSSARY-MAP.md` and the per-package `GLOSSARY.md` files for the vocabulary. No profiling was run — every "cost" below is a code-shape claim, and the closing section lists what to measure first.

**One-paragraph verdict.** A Run's harness events cross a single, unbatched, per-event pipeline: Effect Schema decode per stream chunk → JSON encode → **synchronous** SQLite insert on the daemon's one event loop → daemon event bus → per-event NDJSON frame → per-frame Electron IPC send → renderer Schema decode → copy-on-write Board fold → React state set. Every stage is O(agents × events), and text deltas arrive roughly per token. On top of that, the renderer **accumulates every run activity of a watched run without bound and re-folds the whole array on each new event**, and the provider runner's file-diff feed spawns a `git diff` subprocess per file event and ships full unified diffs (recomputed against the run's base SHA, so they grow monotonically) through that same pipeline. The chug is the pipeline; the crash at 8 is most plausibly the renderer's unbounded accumulation or daemon event-loop starvation — measured confirmation still needed.

---

## 1. The agent-spawn path

The scheduler picks candidates on each 5-second execute heartbeat and forks one executor fiber per candidate into a `FiberSet` (`packages/engine/src/scheduler.ts:321`, heartbeat at `packages/engine/src/daemon.ts:504`). The executor claims the item, ensures a worktree, assembles the Run Plan, dispatches a harness request, and folds the harness event stream (`packages/engine/src/executor.ts:1640–1662`, `1522–1591`).

Three harness runners are registered (`apps/cli/src/rpc.ts:82–85`):

| Runner | Process type | Notes |
| --- | --- | --- |
| `cursorRunner` | Child process per run: `agent --model <m> acp`, spawned through the run's `localProcessSandbox` (`packages/cursor-acp/src/harness.ts:434–447`) | NDJSON ACP transport over the child's stdio |
| `codexRunner` | Codex CLI child process per run via the `@tanstack/ai-codex` adapter over a `localProcessSandbox` (`packages/codex-cli/src/harness.ts:505–520`); readiness probes run `codex --version` and `codex login status` subprocesses (`packages/codex-cli/src/harness.ts:204–231`) | `fileEvents: false` (`:512`) — no diff feed |
| `providerRunner` | No agent subprocess — direct provider HTTP via TanStack `chat()` (`packages/engine/src/provider-runner.ts:188–257`) | Owned tools exec through the worktree sandbox (subprocess per `bash` call), plus a recursive worktree watcher per run (`provider-runner.ts:244`) |

The engine itself is one real Node child of the Electron main process, spawned and supervised by the engine supervisor (`apps/desktop/src/main/engine-supervisor.ts:154–175`); never `utilityProcess` (`apps/desktop/GLOSSARY.md`, "Engine supervisor"). All Runs execute inside that single engine process — its one event loop is the shared resource every finding below lands on.

**Per-Run resources.** A git worktree (`packages/engine/src/worktree.ts:221–260`) with a `git fetch` on every ensure (`worktree.ts:232`) and per-worktree setup: hard-links for `linkPaths` plus arbitrary configured `setup` commands (`worktree.ts:153–164`). A `localProcessSandbox` handle. For the provider runner: one recursive `FileSystem.watch` over the worktree (`packages/engine/src/tools/file-diff-feed.ts:131–146`) and the full prior session transcript loaded into memory at launch (`provider-runner.ts:200–206`, folding every stored session event — `packages/engine/src/session-store.ts:154–159`). One run fiber in the `RunControl` FiberMap (`packages/engine/src/run-control.ts:50`). A `runs` row, a `run_plans` row, and one `run_events` row **per harness event**. A per-run context-assembler resource directory, cleaned at settle (`executor.ts:401–408`).

## 2. Stream handling: harness stdout → engine

The external runtime and the provider runner both produce a TanStack `chat()` AsyncIterable; `bridgeChat` lifts it into an Effect Stream and runs a **full `AgUiEvent` union Schema decode on every chunk** (`packages/engine/src/provider-bridge.ts:8–11`, `34–45`). Cursor's path adds its own per-chunk decode and an accumulating usage estimator (`packages/cursor-acp/src/harness.ts:329–334`, `361–374`); the external runtime maps every event again for usage estimation (`packages/engine/src/external-harness-runtime.ts:333–345`).

The executor folds the stream sequentially with `Stream.runFoldEffect` (`executor.ts:781`), and **each event** goes through the run recorder (`packages/engine/src/run-recorder.ts:68–93`):

1. Schema encode to a JSON string (`run-recorder.ts:69`),
2. `ledger.appendEvent` — one SQLite `INSERT` (`apps/cli/src/ledger.ts:439–455`),
3. `bus.publishActivity` onto the daemon event bus (`run-recorder.ts:91`).

There is no batching or coalescing anywhere on this path: `TEXT_MESSAGE_CONTENT` and reasoning deltas arrive roughly per token, and each is one full trip. `RunActivity` carries the entire `AgUiEvent` payload (`packages/contracts/src/run.ts:94–104`), so file-diff events carry full unified diff text.

**Backpressure.** The daemon event bus is `PubSub.sliding(1024)` — a deliberate drop-oldest policy so a stuck subscriber cannot backpressure publishers (`packages/engine/src/daemon-event-bus.ts:42–43`). That protects the daemon but silently loses run activity under exactly the load being surveyed. On the renderer side the protocol's inbox is `Queue.unbounded` (`apps/desktop/src/renderer/src/daemon/protocol.ts:54`), so frames buffer without bound in the renderer when decode/fold falls behind arrival.

**No transcript string concatenation on the daemon.** The engine holds no growing transcript string (the accumulator keeps only handle/usage/structured outputs — `executor.ts:107–111`, `217–241`). The renderer's preview concatenation is capped at 160 chars (`apps/desktop/src/renderer/src/features/run-activity.ts:20`, `77`). The growth problems are elsewhere (§3, §6).

## 3. IPC and the renderer

**Every renderer receives every harness event of every Run, always.** `WatchEvents` is a stream RPC whose live tail is the raw bus subscription (`packages/engine/src/daemon.ts:221–230`; `packages/contracts/src/rpc.ts:75–78`), and `RunActivity` is a `DaemonEvent` variant (`packages/contracts/src/daemon-event.ts:47`). There is no server-side filter, sampling, or event-kind subscription. The RPC relay in `main` is a dumb pipe that forwards **each NDJSON frame as its own `webContents.send`** (`apps/desktop/src/main/ipc.ts:72–74`) — per-event IPC sends, O(agents × events) crossings of the Electron process boundary.

**Renderer fold per event.** The activity session ingests each event: `applyDaemonEvent` copies a Board map per event (`packages/contracts/src/board.ts:87–110`), `applyRunPreview` copies the preview map per event (`run-activity.ts:62–63`), then `setSession` re-renders the provider's consumers (`apps/desktop/src/renderer/src/features/activity-session.tsx:444–481`). Batching exists only to the extent the pull atom delivers chunks (`apps/desktop/src/renderer/src/daemon/atoms.ts:14–17`, with `disableAccumulation: true`).

**The item tab's transcript is the sharp edge.** `runActivityAtom` is `DaemonAtomRpc.query("WatchActivity", …)` (`atoms.ts:21–23`), which for a stream RPC builds a pull atom **without** `disableAccumulation` (`effect@4.0.0-rc.112` `dist/unstable/reactivity/AtomRpc.js:74`; accumulation is the documented default — `dist/unstable/reactivity/Atom.d.ts:614`). `useRunActivity` pumps continuously (`run-activity.ts:268–284`), so an open item tab accumulates **every RunActivity of the run, unbounded, including full diff payloads**, and `foldTranscript` re-folds the entire array on every pull (`apps/desktop/src/renderer/src/components/run-transcript.tsx:71–76`, `run-activity.ts:260–264`) — O(n²) over the run's life. Server-side, each open tab also replays the full stored history (decoding every row — `daemon.ts:150–167`, `run-recorder.ts:98–106`) and then filters the **entire** bus event stream down to one run (`daemon.ts:161–163`) — O(all agents' events) predicate work per open tab.

Minor: `useNow` re-renders feed/item-tab/transcript components every second (`apps/desktop/src/renderer/src/features/use-now.ts`; used at `components/item-tab.tsx:131`, `components/feed.tsx:292`).

## 4. The Control store and the run ledger (SQLite)

**The driver is synchronous.** `@effect/sql-sqlite-node@4.0.0-rc.112` is built on `node:sqlite`'s `DatabaseSync` — its own header says queries "block the Node.js event loop because `node:sqlite` is synchronous" (`dist/SqliteClient.js:2,11,32`). WAL is on by default (`SqliteClient.js:68–70`). The Control store and the run ledger share one `SqliteClient` layer built from the same `controlStorePath` (`packages/engine/src/daemon.ts:337`, `353–360`; `apps/cli/src/rpc.ts:301` wires `ledgerLayer`). So:

- **Write frequency: one synchronous `INSERT` per harness event per agent** (`apps/cli/src/ledger.ts:439–455`), each in its own implicit transaction (no batching), executed on the daemon's main thread. Eight agents streaming token deltas serialize through this one connection and block the event loop for every write.
- The only explicit transaction is `acceptRun` (`ledger.ts:267–277`). Everything else is autocommit.
- The Control store additionally serializes its writers through a `Semaphore(1)` write gate (`packages/engine/src/control-store.ts:428`, `559`), and **every** `executor.execute` passes through it before claiming (`executor.ts:1411` wraps `resolvePlanStage` in `withWrite`) — all agents funnel through one permit at start-up and at every availability evaluation.
- Read-back amplification: the run ledger's publishing wrapper re-reads the run **and selects + Schema-decodes every one of its events** on each run mutation, only to compute `eventCount` (`packages/engine/src/run-ledger.ts:305–312`; full-event select at `ledger.ts:540–571`). `listRuns`/`runningRuns` carry a correlated `count(*)` subquery over `run_events` per row (`ledger.ts:490–535`), and the `WatchEvents` seed calls `runningRuns` on every renderer (re)connect (`daemon.ts:180`, `188`).
- The in-memory fallback ledger (used only when the Control store is unavailable) copies the whole events map on **every** append (`run-ledger.ts:206–207`) and keeps all events forever — O(runs) allocation per event, unbounded heap.

## 5. Concurrency structure

- The scheduler is the only cap on concurrent agents: `globalLimit`, `perWorkspaceLimit`, `dailyBudget` (`scheduler.ts:112–118`), seeded from the Control store's daemon limits; the shipped defaults are **4 / 4 / 50** (`packages/contracts/src/scheduler-defaults.ts:3–5`). Running 6–8 agents means the global limit was raised via `SetDaemonLimit`. Nothing else scales down per-agent work as the count grows.
- `admit` (claim recovery) deliberately bypasses `fits()` (`scheduler.ts:345–359`), so recovered runs can exceed the global limit — a restart with many resumable claims can briefly run more agents than the cap. Worth noting when reproducing.
- Inside a run: the agent loop is bounded (`maxIterations` 12 read-only / 40 writing, run deadline 15 min / 2 h — `provider-runner.ts:74–83`, applied at `executor.ts:780–800`), and the event fold is sequential per run.
- Reconcile polls workspaces with `concurrency: 4` (`packages/engine/src/reconcile.ts:286`); the two heartbeats run unbounded beside each other (`daemon.ts:511–514`).
- The file-diff feed's `Stream.mapEffect` stages are sequential per watcher (default concurrency 1 — `file-diff-feed.ts:140–141`), which serializes the per-run `git diff` execs but lets pending file events queue.

## 6. Known heavy spots

**File watching + per-event git subprocesses (provider runner only).** Each provider-runner Run opens `fs.watch(root, { recursive: true })` over its worktree (`file-diff-feed.ts:131–146`). For **every** file event that is not under `.git`, `node_modules`, or `.repos` (`:107–109`): an existence check against the sandbox, then a `git diff <baseSha> -- <file>` subprocess, sometimes followed by `git ls-tree` and a full file read (`file-diff-feed.ts:70–105`, `116–125`). Build output directories are not ignored, so an agent running a build or install triggers a subprocess per changed file. The diff is against the run's base SHA, so a file's diff **grows monotonically** over the run, and every non-empty diff becomes a `CUSTOM sandbox.file.diff` event carrying the whole unified diff through §2's pipeline into SQLite and every renderer. The code itself flags the watcher's fragility (inotify exhaustion note at `provider-runner.ts:239–241`, FSEvents/EMFILE note at `file-diff-feed.ts:127–130`).

**Git per Run.** `worktrees.ensure` runs `git fetch` on every run start (`worktree.ts:232`), plus `git worktree add` (a full working-tree write) and the configured setup commands for a new worktree (`worktree.ts:243–253`, `153–164`). Eight simultaneous starts on one repo = eight fetches racing plus checkout IO. Whether a workspace's `setup` runs a dependency install per worktree is user config — **hypothesis to measure** on the affected machine.

**Polling loops.** Reconcile heartbeat per `pollIntervalMillis`: issue-tracker list + source-control PR resolution per workspace, classify, availability refresh (which loads the plugin overview and prepares every plugin MCP server — `executor.ts:1425–1442`, `1314–1353`), event-publisher diffing (signature-based, so only changes publish — `packages/engine/src/event-publisher.ts:129–164`), and worktree maintenance (`daemon.ts:431–460`). This is O(workspaces), not O(agents), and is likely background-level cost.

**Log piping.** The engine supervisor pipes all engine stdout/stderr through decode → line-split → logger per line (`engine-supervisor.ts:139–152`) in the Electron main process. Cost scales with engine log volume, which scales with agent count.

## 7. Crash candidates at 8 agents

Ordered by plausibility from code shape; none is confirmed — the first measurement below discriminates them.

1. **Renderer V8 heap exhaustion.** An open item tab accumulates every RunActivity of its run without bound (§3), each carrying full event payloads including growing unified diffs (§6), while `foldTranscript` re-folds the whole array per event and the unbounded protocol inbox (`protocol.ts:54`) buffers whatever the fold can't keep up with. A renderer OOM presents exactly as "the app crashed". Electron renderers have a default V8 heap around 4 GB — **hypothesis to measure** (renderer process memory + which process actually dies).
2. **Daemon event-loop starvation.** Synchronous SQLite inserts per event (§4) plus per-event schema encode/decode and per-subscriber NDJSON encoding all run on the engine's one thread. Under 8 agents' token streams the heartbeats, RPC responses, and socket writes starve; the renderer's connection gate times out and the UI reads as dead even though the process lives. Not a process crash, but indistinguishable from one in the shell — **hypothesis to measure** (event-loop lag in the engine).
3. **File-descriptor / process pressure.** Per agent: a harness CLI child (plus its own children), a recursive watcher, serial `git diff` spawns per file event, `git fetch` at start, owned-tool `bash` children. The repo already documents watcher EMFILE death modes (`file-diff-feed.ts:127–130`; memory note "Codex seatbelt denies FSEvents"). At 8 agents a burst (install/build in several worktrees at once) could exhaust default `ulimit -n` — **hypothesis to measure** (fd and child-process counts at 6 vs 8).
4. **Engine heap growth** is *not* the default suspect: the SQLite ledger keeps events on disk and the daemon accumulates no transcripts (§2). The exception is the in-memory fallback ledger when the Control store is unavailable (`run-ledger.ts:206–207`) — check the store-unavailable banner before blaming the engine's heap.

## Ranked findings

1. **Per-event, per-subscriber pipeline with no batching** — every token-ish delta of every agent costs a schema decode, a JSON encode, a synchronous SQLite insert on the daemon's event loop, a pubsub publish, an NDJSON frame, an Electron IPC send, a renderer schema decode, and two map copies plus a React state set (§2, §3, §4). This is the machine-wide chug: it is O(agents × events) with a large constant, and half of it blocks the daemon's single thread.
2. **Unbounded renderer accumulation of WatchActivity + O(n²) transcript re-fold** (`atoms.ts:21–23`, `run-transcript.tsx:76`) — the leading crash candidate at 8 agents, amplified by full-diff payloads.
3. **File-diff feed subprocess storm and growing diff payloads** per provider-runner agent (`file-diff-feed.ts:70–146`) — O(agents × file events) `git diff` spawns, and the largest single event payloads in the system.
4. **Synchronous shared SQLite connection + Control-store write gate** serializing all agents through one thread and one semaphore (`SqliteClient.js:11`, `control-store.ts:428`, `executor.ts:1411`), with read-back amplification on every run mutation (`run-ledger.ts:305–312`).
5. **Run-start IO spike**: `git fetch` + worktree add + setup commands per Run (`worktree.ts:232–258`), times the number of simultaneously scheduled candidates in one tick (`scheduler.ts:321`).
6. **Sliding pubsub drop under load** (`daemon-event-bus.ts:43`) — not a cost but a correctness symptom that will surface exactly when 1–3 bite.

**Measure first, in order.** (a) Which process dies at 8 — renderer, engine child, or main (Activity Monitor / crash logs); (b) renderer heap over a long run with an item tab open; (c) engine event-loop delay and SQLite insert latency at 6–8 agents; (d) fd + child-process counts per agent; (e) events/second per agent and the share that is `sandbox.file.diff`.
