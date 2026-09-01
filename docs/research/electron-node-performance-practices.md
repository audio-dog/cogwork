# Electron + Node performance: measurement and improvement practices

**Question:** cogwork gets slow and crashes when it orchestrates 6–8 concurrent coding-agent
subprocesses. What are the standard, officially documented practices for profiling, measuring, and
improving performance in an Electron + Node desktop app — and which tools apply to which of
cogwork's processes?

All claims below cite the owning primary source (electronjs.org docs, nodejs.org docs, or vendor
source repos), fetched 2026-09-01. Versions are targeted to what the repo pins: Electron `^43.3.0`
(`apps/desktop/package.json`), which bundles **Node.js 24.17.0, Chromium 150, V8 15.0**
([Electron 43 release](https://releases.electronjs.org/release/v43.0.0),
[blog](https://www.electronjs.org/blog/electron-43-0)).

**TL;DR:** Electron's own guidance is "profile first, optimize the hot spot"
([performance checklist](https://www.electronjs.org/docs/latest/tutorial/performance)). cogwork's
process map matters more than any single tool: the engine daemon is a **plain Node process**
(spawned from `apps/desktop/src/main/index.ts` via `child_process.spawn`, entry resolved in
`apps/desktop/src/main/engine-command.ts`), so the full Node diagnostics toolbox (`--cpu-prof`,
`--heap-prof`, diagnostic reports, `monitorEventLoopDelay`, ELU) applies to it directly. The
Electron main process is more restricted — Node CLI profiling flags are not Electron switches and
`NODE_OPTIONS` is disallowed in packaged apps — so profile it with `--inspect` + Chrome DevTools or
the in-process `node:inspector` API. The likeliest mechanical causes of "slow under 6–8 harnesses"
are (a) event-loop blocking in the daemon or main process — detect with
`perf_hooks.monitorEventLoopDelay` / `eventLoopUtilization`, (b) unmanaged subprocess stdout
volume (pipe backpressure and per-chunk processing), and (c) per-process V8 heap pressure — each
Node child is a full V8 instance, and Node's docs explicitly warn against spawning many of them.
Crash forensics: `child-process-gone` / `render-process-gone` cover only Chromium-managed
processes, **not** `child_process.spawn` children — the daemon and harness children need Node-side
forensics (`close`/`exit` codes and signals, `--report-on-fatalerror`,
`--heapsnapshot-near-heap-limit`).

---

## 1. cogwork's process map, and which tools apply where

From the repo (this worktree):

- **Electron main process** — `apps/desktop/src/main/index.ts`. Window/tray/IPC only; it spawns
  the engine daemon with `spawn(engine.command, ..., { stdio: ["ignore", "pipe", "pipe"] })` and
  supervises it (`engine-supervisor.ts`), talking over a unix socket.
- **Engine daemon** — a plain Node process (`node <engine>/index.js` packaged, `tsx` in dev; see
  `apps/desktop/src/main/engine-command.ts`). This is where orchestration and the 6–8 harness
  subprocesses live (`packages/engine/src/external-harness-runtime.ts`, `daemon.ts`).
- **Harness children** — Claude Code and similar CLIs, spawned by the daemon. Each is itself a
  Node process with its own V8 heap.
- **Renderer process(es)** — the React UI.

| Diagnostic | Electron main | Engine daemon (plain Node) | Harness children | Renderer |
|---|---|---|---|---|
| `--cpu-prof` / `--heap-prof` CLI flags | ✗ not an Electron switch (§3.2) | ✓ | ✓ (if you control argv) | ✗ |
| `--inspect` + Chrome DevTools | ✓ (`chrome://inspect`) | ✓ | ✓ | ✓ (built-in DevTools) |
| `node:inspector` in-process Session | ✓ | ✓ | — | ✗ |
| `perf_hooks` ELU / `monitorEventLoopDelay` | ✓ | ✓ | — | ✗ (web perf APIs instead) |
| `v8.getHeapStatistics` / `writeHeapSnapshot` | ✓ | ✓ | — | via DevTools Memory tab |
| Node diagnostic report | ✓ (main runs Node) | ✓ | ✓ | ✗ |
| `app.getAppMetrics()` / `process.getProcessMemoryInfo()` | ✓ (Electron-only APIs) | ✗ | ✗ | partial |
| `contentTracing` | ✓ (records all Chromium processes) | ✗ | ✗ | ✓ |
| `child-process-gone` / `render-process-gone` | observer | **not covered** | **not covered** | covered |
| `crashReporter` (Crashpad) | ✓ | ✗ (not a Chromium child) | ✗ | ✓ |

The daemon being a plain Node process is the practical headline: everything in §4 works on it
without Electron caveats, and it is the process most likely to be the bottleneck under harness
load.

---

## 2. Electron's official performance guidance

The [performance checklist](https://www.electronjs.org/docs/latest/tutorial/performance) opens
with measure-first: "The most successful strategy for building a performant Electron app is to
profile the running code, find the most resource-hungry piece of it, and to optimize it." It names
Chrome DevTools (Performance and Memory tabs) and the multi-process Chrome tracing tool as the
instruments. Checklist items most relevant here:

1. **Carelessly including modules** — measure `require()` cost with
   `node --cpu-prof --heap-prof -e "require('module')"`; "a seemingly excellent module written
   primarily for Node.js servers running Linux might be bad news for your app's performance."
2. **Loading and running code too soon** — defer expensive setup; lazy-`require` on first use.
3. **Blocking the main process** — "Under no circumstances should you block this process and the
   UI thread with long-running operations." Named remedies: worker threads, moving work to another
   process, avoiding synchronous IPC, preferring async Node APIs.
4. **Blocking the renderer** — Web Workers and `requestIdleCallback()` for renderer-side work.

The [process model doc](https://www.electronjs.org/docs/latest/tutorial/process-model) explains
why main-process blocking makes the whole app "chug": the main process owns every window and the
app lifecycle, and the utility process exists precisely for "untrusted services, CPU intensive
tasks or crash prone components."

Electron 43 itself shipped startup-performance work (embedded Node startup snapshot, bytecode-cached
preloads) — worth knowing so a startup regression is not misattributed
([Electron 43 blog](https://www.electronjs.org/blog/electron-43-0)).

---

## 3. Measuring the Electron main process

### 3.1 CPU profile / heap snapshot of a live main process

- **`--inspect[=port]` / `--inspect-brk[=port]`** — "Electron will listen for V8 inspector
  protocol messages on the specified port"; default 9229. Connect Chrome via `chrome://inspect`
  and use the Performance (CPU profile) and Memory (heap snapshot) tabs
  ([debugging the main process](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)).
  In dev: `electron-vite dev -- --inspect` style pass-through; the switch must reach Electron's argv.
- **In-process, no restart:** the `node:inspector` module works inside the main process. A
  `Session` can run `Profiler.enable/start/stop` and write a `.cpuprofile`, or stream
  `HeapProfiler.takeHeapSnapshot` chunks to a `.heapsnapshot` file — both loadable in Chrome
  DevTools ([node:inspector docs](https://nodejs.org/docs/latest-v24.x/api/inspector.html), which
  include both examples verbatim). `inspector.open(port)` activates the inspector at runtime
  without launch flags. This is the standard way to add a "capture profile now" debug command to a
  running app.
- **`v8.writeHeapSnapshot(file)`** also works, with two documented costs: "requires memory about
  twice the size of the heap" (OOM risk) and "a synchronous operation which blocks the event loop"
  ([v8 docs](https://nodejs.org/docs/latest-v24.x/api/v8.html)). Prefer it for the daemon over the
  main process; in the main process it freezes the UI while it runs.

### 3.2 Flag caveats specific to Electron

- Electron's [command-line switches](https://www.electronjs.org/docs/latest/api/command-line-switches)
  support only a subset of Node flags (`--inspect*`, `--diagnostic-dir`, deprecation/warning
  traces, `--js-flags`). **`--cpu-prof` and `--heap-prof` are not listed** — they are not usable
  on the main process as switches. `--js-flags` (V8 flags, e.g. `--max-old-space-size`) "must be
  passed on startup" to affect the main process.
- `NODE_OPTIONS` is supported as a subset in dev, but "explicitly disallowed in packaged apps"
  except two http options, and ignored entirely if the `nodeOptions` fuse is disabled
  ([environment variables](https://www.electronjs.org/docs/latest/api/environment-variables)).
  Do not build a profiling workflow on `NODE_OPTIONS` for the main process.

### 3.3 Whole-app tracing and metrics

- **`contentTracing`** — "Collect tracing data from Chromium to find performance bottlenecks and
  slow operations" across **all** processes; `startRecording`/`stopRecording([file])`, view in the
  `chrome://tracing` viewer (the doc notes Perfetto has trouble with memory-infra dumps). Usable
  only after `app` `ready` ([contentTracing docs](https://www.electronjs.org/docs/latest/api/content-tracing)).
  This is the tool for "which process is busy and when," not line-level attribution.
- **`app.getAppMetrics()`** — array of `ProcessMetric` (per-process CPU and memory) for every
  process associated with the app ([app docs](https://www.electronjs.org/docs/latest/api/app)).
  Note: this sees Chromium-managed processes, not the daemon's harness children — poll those with
  `pidusage`-style OS sampling or from the daemon itself.
- **`process.getProcessMemoryInfo()`** — Electron extension; resolves `{ residentSet, private,
  shared }` in kilobytes. macOS caveat: `residentSet` is unavailable because "macOS performs
  in-memory compression of pages," so use `private` there
  ([process docs](https://www.electronjs.org/docs/latest/api/process)). Same page:
  `process.getCPUUsage()`, `process.getSystemMemoryInfo()`, `process.getHeapStatistics()`.

---

## 4. Measuring the engine daemon (plain Node 24)

All first-party, all stable on Node 24 unless noted
([cli docs](https://nodejs.org/docs/latest-v24.x/api/cli.html)):

- **`--cpu-prof`** — "Starts the V8 CPU profiler on start up, and writes the CPU profile to disk
  before exit" (`*.cpuprofile`, open in Chrome DevTools Performance tab). Tune with
  `--cpu-prof-dir`, `--cpu-prof-interval` (default 1000µs), `--cpu-prof-name`. Stable since
  v22.4.0.
- **`--heap-prof`** — sampling heap profiler over the process lifetime (`*.heapprofile`).
- **`--heapsnapshot-signal=SIGUSR2`** — write a heap snapshot on demand from a live process with
  `kill -USR2 <pid>`.
- **`--heapsnapshot-near-heap-limit=N`** — "Writes a V8 heap snapshot to disk when the V8 heap
  usage is approaching the heap limit" — the standard OOM-crash forensics flag.
- **`--inspect` / SIGUSR1** — Node activates the inspector on `SIGUSR1` at the `--inspect-port`
  address, so a live daemon can be attached to after the fact.
- **Diagnostic report** — "a JSON-formatted diagnostic summary … intended for development, test,
  and production use, to capture and preserve information for problem determination." Trigger with
  `--report-on-fatalerror`, `--report-on-signal`, `--report-uncaught-exception`, or
  `process.report.writeReport()`. Contains `javascriptHeap`, `resourceUsage`, and the full list of
  active **libuv handles** — the fastest way to see "what is this stuck daemon waiting on"
  ([report docs](https://nodejs.org/docs/latest-v24.x/api/report.html)).

Because `resolveEngineCommand` builds the daemon's argv in
`apps/desktop/src/main/engine-command.ts`, a debug env var can inject these flags without touching
Electron at all.

### 4.1 Detecting event-loop blocking (the usual "chugging" cause)

Two first-party signals, both cheap enough to run always-on
([perf_hooks docs](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html)):

- **`perf_hooks.monitorEventLoopDelay({ resolution })`** — "samples and reports the event loop
  delay over time. The delays will be reported in nanoseconds." Gives an `ELDHistogram`
  (`mean`, `max`, `percentile(99)`). A p99 delay in the tens of milliseconds means something is
  running long synchronous work on the loop.
- **`performance.eventLoopUtilization()`** — ELU "represents the percentage of time the event
  loop has spent outside the event loop's event provider (e.g. `epoll_wait`)"; diff two readings
  with `eventLoopUtilization(prev)` to get utilization over an interval. Sustained ELU near 1.0
  means the loop is CPU-bound (or blocked).
- **`PerformanceObserver` with `entryTypes: ['gc']`** attributes pauses to garbage collection —
  the tell for heap pressure as opposed to application code.

Both work in the Electron main process too (it runs Node). Wiring a periodic log of
`{ eluDelta, loopDelayP99, v8.getHeapStatistics().used_heap_size }` per process is the standard
minimal instrumentation before any optimization. `v8.getHeapStatistics().heap_size_limit` reports
the ceiling: "either the default limit, determined by system resources, or the value passed to the
`--max_old_space_size` option" ([v8 docs](https://nodejs.org/docs/latest-v24.x/api/v8.html)).

---

## 5. Multi-process resource behavior under 6–8 harnesses

All from the Node 24 [child_process docs](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
unless noted:

- **Process count itself:** "Because of the additional resource allocations required, spawning a
  large number of child Node.js processes is not recommended." Each harness child is a full Node +
  V8 instance; 6–8 CLI harnesses (each of which may spawn its own tool subprocesses) multiplies
  baseline RSS and CPU before any work happens.
- **Pipe backpressure — both directions matter.**
  - Pipes "have limited (and platform-specific) capacity. If the subprocess writes to stdout in
    excess of that limit without the output being captured, the subprocess **blocks**, waiting for
    the pipe buffer to accept more data. … Use the `{ stdio: 'ignore' }` option if the output will
    not be consumed." A harness whose stderr is piped but never read will eventually stall.
  - The inverse problem: a chatty harness whose stdout **is** consumed turns every output burst
    into parent-side event-loop work. With streaming JSON output from 6–8 agents, per-chunk
    parsing/logging/IPC-forwarding in the daemon is a prime CPU suspect — batch or debounce
    downstream fan-out rather than forwarding every `data` event.
- **`exec`/`execFile` buffer in memory** up to `maxBuffer` (default 1 MiB; the child is killed and
  output truncated past it); `spawn` streams and is the right shape for long-lived harnesses.
- **`'exit'` vs `'close'`:** "When the `'exit'` event is triggered, child process stdio streams
  might still be open"; `'close'` fires only after stdio has drained. Cleanup and "harness
  finished" accounting should key off `'close'` to avoid losing tail output.
- **node-pty** (not currently used in cogwork — no dependency found): adds pseudoterminal
  allocation per child (ConPTY on Windows), ships XON/XOFF `handleFlowControl` for backpressure,
  and "is not thread safe so running it across multiple worker threads in node.js could cause
  issues" ([microsoft/node-pty README](https://github.com/microsoft/node-pty)). Plain pipes are
  cheaper; only adopt a pty if a harness misbehaves without one.
- **Renderer memory:** long-lived renderers accumulate V8 + Blink memory; inspect with the
  DevTools Memory tab, `process.getHeapStatistics()`, and `process.getBlinkMemoryInfo()`
  ([Electron process docs](https://www.electronjs.org/docs/latest/api/process)). Chromium can kill
  a renderer under memory pressure — surfaced as `render-process-gone` with reason `oom` or
  `memory-eviction` (§6).

---

## 6. Crash forensics

- **`app.on('child-process-gone')`** — fires when a Chromium-managed child (types: `Utility`,
  `GPU`, `Zygote`, `Sandbox helper`, …) dies; `details.reason` is one of `clean-exit`,
  `abnormal-exit`, `killed`, `crashed`, `oom`, `launch-failed`, `integrity-failure`,
  `memory-eviction`, plus `exitCode` ([app docs](https://www.electronjs.org/docs/latest/api/app)).
  **Scope caveat:** this covers Chromium's own children and `utilityProcess` — it does **not** see
  the engine daemon or harness children spawned with `child_process.spawn`. For those, log
  `'close'`/`'exit'` codes and signals yourself (the supervisor in
  `apps/desktop/src/main/engine-supervisor.ts` is the right seam), and give the daemon
  `--report-on-fatalerror` + `--heapsnapshot-near-heap-limit` so a V8 OOM leaves evidence.
- **`app.on('render-process-gone')` / `webContents` equivalent** — same shape for renderers,
  including `oom`.
- **`crashReporter.start()`** — Crashpad-based native crash capture; "should be called as early as
  possible in app startup, preferably before `app.on('ready')`", "collects crashes from all
  subsequently created processes", and "cannot be disabled once started". With
  `uploadToServer: false` and no server, "crash reports will be collected and stored in the
  crashes directory, but not uploaded" (`app.getPath('crashDumps')`) — a zero-infrastructure way
  to keep local minidumps ([crashReporter docs](https://www.electronjs.org/docs/latest/api/crash-reporter)).
  It captures native crashes of Electron processes, not JS-level failures and not the daemon.

---

## 7. Architectural remedies, with their official backing

1. **Keep work off the main process.** Electron: "Under no circumstances should you block this
   process" ([performance checklist](https://www.electronjs.org/docs/latest/tutorial/performance)).
   cogwork already has the big win: orchestration lives in the daemon, and the main process is a
   thin supervisor. The residual main-process risks are IPC fan-out volume (daemon → main →
   renderer forwarding) and synchronous work in IPC handlers.
2. **`utilityProcess` for main-process offload.** "Provides the equivalent of `child_process.fork`
   … but instead uses Services API from Chromium"; recommended for "untrusted services, CPU
   intensive tasks or crash prone components", with `MessagePortMain` transfer so a utility process
   can talk **directly to the renderer** without bouncing through main
   ([utilityProcess docs](https://www.electronjs.org/docs/latest/api/utility-process),
   [process model](https://www.electronjs.org/docs/latest/tutorial/process-model)). It also gets
   `child-process-gone` crash reporting for free. Relevant if any per-harness stream processing
   ever moves into the app: utilityProcess → MessagePort → renderer bypasses the main process
   entirely.
3. **`worker_threads` only for CPU-bound JS.** Node: "Workers (threads) are useful for performing
   CPU-intensive JavaScript operations. They do not help much with I/O-intensive work. The Node.js
   built-in asynchronous I/O operations are more efficient than Workers can be"
   ([worker_threads docs](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)). Harness
   supervision is I/O-bound — workers would not help; heavy parsing/diffing would qualify. Workers
   accept `resourceLimits` (e.g. `maxOldGenerationSizeMb`) to cap heap.
4. **Throttle subprocess concurrency.** Node's fork warning (§5) is the primary-source basis for a
   concurrency cap; the measurement in §4 tells you the right number. In the repo, scheduling has
   per-workspace limits (`packages/engine/src/scheduler.ts`), but at least one daemon stream runs
   `concurrency: "unbounded"` (`packages/engine/src/daemon.ts:513`) — worth auditing each
   unbounded site once measurements exist.
5. **Avoid synchronous IPC; batch the async IPC.** `ipcRenderer.sendSync` "will block the whole
   renderer process until the reply is received, so use this method only as a last resort"; use
   `invoke()` ([ipcRenderer docs](https://www.electronjs.org/docs/latest/api/ipc-renderer),
   [IPC tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc)). All IPC payloads are
   copied via the Structured Clone Algorithm — high-frequency small messages (per-token or
   per-line agent output) should be coalesced before crossing process boundaries; the same logic
   applies to the daemon→main socket traffic.
6. **Cap and monitor per-process heaps.** `heap_size_limit` via `v8.getHeapStatistics()`;
   `--max-old-space-size` (daemon argv) or `--js-flags=--max-old-space-size=N` at Electron startup
   for the main process ([Node cli docs](https://nodejs.org/docs/latest-v24.x/api/cli.html),
   [Electron switches](https://www.electronjs.org/docs/latest/api/command-line-switches)). Better
   to bound the daemon and let it die loudly (with a near-heap-limit snapshot) than to let the
   whole machine swap.

---

## 8. Version caveats

| Fact | Value | Source |
|---|---|---|
| Pinned Electron | `^43.3.0` | `apps/desktop/package.json` |
| Bundled Node / Chromium / V8 | 24.17.0 / 150.0.7871.46 / 15.0 | [releases.electronjs.org/release/v43.0.0](https://releases.electronjs.org/release/v43.0.0) |
| `--cpu-prof` / `--heap-prof` stability | Stable since Node v22.4.0 (was experimental) | [Node 24 cli docs](https://nodejs.org/docs/latest-v24.x/api/cli.html) |
| `--heapsnapshot-near-heap-limit` | Stable as of v24.13.1 (previously experimental) | same |
| `NODE_OPTIONS` in packaged Electron | Disallowed (two http exceptions); gated by `nodeOptions` fuse — note the repo uses `@electron/fuses` | [environment variables](https://www.electronjs.org/docs/latest/api/environment-variables) |
| `contentTracing` | Only after `app` `ready`; use `chrome://tracing` viewer for memory-infra traces | [contentTracing docs](https://www.electronjs.org/docs/latest/api/content-tracing) |
| `process.getProcessMemoryInfo().residentSet` | Not available on macOS; use `private` | [Electron process docs](https://www.electronjs.org/docs/latest/api/process) |

## 9. Suggested measurement order for cogwork's symptom

Applying the above to "slow / crashes with 6–8 harnesses" — measurement only, no fixes:

1. Add always-on loop-lag + ELU + heap logging to the daemon and main process (§4.1) — one
   afternoon, answers "which process, loop-blocked or memory-bound."
2. Reproduce load with the daemon started as `node --cpu-prof --heap-prof
   --heapsnapshot-near-heap-limit=3 --report-on-fatalerror` (injectable via
   `engine-command.ts`), open the `.cpuprofile` in Chrome DevTools.
3. If the UI stutters while the daemon looks healthy: `--inspect` the main process, record a
   DevTools Performance trace, and check IPC/socket-forwarding volume; `contentTracing` if the
   guilty process is still unclear.
4. For crashes: capture daemon `'close'` codes/signals in the supervisor, keep local Crashpad
   dumps (`uploadToServer: false`), and read the diagnostic report's libuv handle list for hangs.
