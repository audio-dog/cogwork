# Repeatable before/after performance numbers for the event pipeline

Date: 2026-09-01.

**Question.** We must measure the performance cost of specific defects and the gain from fixing
them — before/after numbers, repeatably. Real 6–8 agent runs are noisy, slow, and cost LLM
tokens. What is the standard approach for an event-driven desktop app like this one, and why?
Three candidates: (a) record-and-replay load — record real harness-event streams once (they
already persist in the run ledger) and replay them through the whole real pipeline at recorded
or multiplied speed; (b) component-level microbenchmarks of isolated stages; (c) in-situ
measurement during normal daily use, accepting the noise.

**Sources.** Primary methodology docs read directly: the Chromium Telemetry README and the
Web Page Replay (WprGo) README in the catapult repo, V8's "Retiring Octane" post, the Node.js
core benchmarking guide, the hyperfine README, tinybench's README, the vitest bench API docs,
grafana k6's "create tests from recordings" guide, the React `<Profiler>` reference on
react.dev, and MDN's `performance.measure()` page (URLs cited inline). The five vendored repos
under `.repos/` (effect, codex, opencode, t3code, biome-effect-linting-rules), surveyed for
benchmark suites, replay harnesses, and perf CI (file paths cited inline). The cogwork engine
read at this worktree's HEAD (file:line cites). Companion docs:
`docs/research/cogwork-performance-bottleneck-survey.md` (where the cost lives) and
`docs/research/effect-observability-for-performance.md` (how to instrument what the replay
exercises).

**TL;DR.** The standard is a *combination*, not one option. Industry practice (Chromium
Telemetry over Web Page Replay, k6's recorded sessions, codex's replay test culture, t3code's
replay provider adapter) is: **record real traffic once, replay it deterministically through the
real system** — replay removes the two things that make live runs unusable as a lab (the LLM's
nondeterminism and its cost) while keeping the workload representative, which is exactly the
property V8 says synthetic benchmarks lose. Microbenchmarks stay useful *after* the macro replay
has named a guilty stage — every vendored repo that benches (effect with tinybench, codex with
divan) uses them that way, and none gates CI on their timings. In-situ measurement is the
validation layer, not the measurement layer: no primary source treats uncontrolled daily use as
a way to attribute a delta to a fix. The statistical hygiene is uniform across sources: warm up,
run many times (Node core defaults to 30 samples; hyperfine to ≥10 runs), compare distributions
with a significance test (Node: Welch's t-test — "if there are no stars, then don't make any
conclusions"), and never conclude from one run. Cogwork is unusually well-positioned for option
(a): the ledger already records every run's full event stream with per-event timestamps
(`run_events`: seq, type, data, at — `packages/engine/src/control-store-schema.ts:134-144`),
`RunRecorder.replay` already proves the decode-and-refeed seam works
(`packages/engine/src/run-recorder.ts:98-106`), and a replay `HarnessRunner` is the same shape
as the fake runners the executor tests already build from `Stream.fromArray(events)`
(`packages/engine/src/executor.test.ts:574,614-624`).

---

## 1. What established practice says, and why

### Chromium: lab benchmarking over recorded-and-replayed real content

Chromium's performance framework, Telemetry, structures every benchmark as real application
scenarios ("stories" — scrolling, clicking, executing JavaScript) replayed against **recorded**
web content, and states the rationale in one line: "Use Web Page Replay to get repeatable test
results" (Telemetry README,
<https://chromium.googlesource.com/catapult/+/HEAD/telemetry/README.md>). Web Page Replay
(WprGo) is "a performance testing tool written in Golang for recording and replaying web pages
… currently used in Telemetry for Chrome benchmarking purposes"
(<https://github.com/catapult-project/catapult/blob/main/web_page_replay_go/README.md>); the
same directory ships a `deterministic.js` injected at replay time to pin the remaining sources
of nondeterminism. The shape is exactly candidate (a): record real traffic once, then replay it
through the full real system in a controlled lab, so successive runs differ only by the code
under test.

### V8: why not synthetic benchmarks

V8 retired its own Octane suite because synthetic workloads stop being representative and start
being optimization targets. The retirement post's key statements: benchmarks like Octane
"are insufficient methods of measuring real-world speed and create incentives … to
over-optimize narrow use cases and under-optimize generic cases", Octane "doesn't match the
idioms and patterns employed by most modern frameworks", and Octane-derived heuristics "led to
performance degradations in modern frameworks such as Ember"
(<https://v8.dev/blog/retiring-octane>). What replaced it is measurement against real web pages
and real workloads. Applied here: a hand-written synthetic event generator (uniform event sizes,
uniform pacing) is the Octane trap; replaying *recorded* streams keeps the workload shaped like
the defect actually encountered — token-sized text deltas, monotonically growing diffs, bursts.

### k6: recorded sessions as the source of realistic load

Grafana k6's authoring guide recommends recordings precisely where flows are too complex to
script faithfully: "Testers commonly use recordings to avoid writing complex tests from scratch
… such as end-to-end (E2E) tests with dozens or hundreds of requests", and its realism guidance
is to capture natural behavior, not synthetic sweeps ("Browse as a user would… Focus on the most
common use cases")
(<https://grafana.com/docs/k6/latest/using-k6/test-authoring/create-tests-from-recordings/>).
It also names the cost: recorded tests "are difficult to maintain" as the system changes — a
real con for option (a), mitigated in cogwork's case because the recording is already produced
as a side effect of every run and re-recording is free.

### The consensus against option (c) as the measurement layer

None of the sources above measures in production traffic to attribute a delta to a change; all
of them move the workload into a controlled, repeatable lab first. Real-user measurement exists
in the industry (RUM, field data) but as *detection and validation* — finding regressions and
confirming that lab wins reached users — not as the before/after instrument, because the
workload is different on every sample and the environment is uncontrolled. For cogwork the
noise floor is worse than a web page's: each live run's event stream depends on an LLM's output,
so before and after are never the same workload at all, and each sample costs tokens.

## 2. Statistical hygiene: what the methodology docs actually prescribe

The prescriptions are consistent across every runner and guide read:

- **Node.js core benchmarking guide**
  (<https://github.com/nodejs/node/blob/main/doc/contributing/writing-and-running-benchmarks.md>):
  before/after comparisons run each benchmark on *both* builds many times (`compare.js`,
  default 30 samples) and apply an unpaired two-group **Welch's t-test** with the null
  hypothesis that the two builds perform identically. Significance is starred (one star:
  p < 0.05; two: p < 0.01; three: p < 0.001) and the guide is blunt: "if there are no stars,
  then don't make any conclusions based on the improvement." It also warns about multiple
  comparisons — run 20 benchmarks and one will look significant by chance — and recommends
  treating two stars as the minimum when many benchmarks are compared.
- **hyperfine** (<https://github.com/sharkdp/hyperfine>): warmup runs before measurement, "at
  least 10 benchmarking runs and measure for at least 3 seconds" by default, "statistical
  outlier detection to detect interference from other programs and caching effects", and an
  explicit warning that disk-I/O-heavy programs are "heavily influenced by disk caches" (warm
  vs cold cache is a benchmark design decision, not noise).
- **tinybench** (<https://github.com/tinylibs/tinybench>): "statistically analyzed latency and
  throughput values: standard deviation, margin of error, variance, percentiles" — a time-budget
  runner (default 100 ms per task) with warmup built in.
- **vitest bench** (<https://vitest.dev/api/#bench>): wraps tinybench (defaults: 500 ms `time`,
  minimum 10 `iterations`, 100 ms `warmupTime`, 5 `warmupIterations`) and carries the caveat
  "benchmarking is experimental and does not follow SemVer."
- **Effect's own `runtimeperf` harness** (see §3) is the most rigorous of the vendored
  examples: independent OS processes are the statistical observations, base and head are built
  from git worktrees and alternated per round, and the comparison is a **seeded bootstrap of
  paired median log-ratios** classified `improvement | regression | inconclusive` against
  explicit bands (2% improvement / 5% regression) — i.e., even the gate itself refuses to call
  a delta inside the noise band.

Distilled into rules for cogwork's before/after runs: warm up first (JIT, SQLite page cache);
fix the workload (same recorded stream, same multiplier); run each side ≥10 times (30 when the
expected delta is small); compare distributions (median + spread, a t-test or bootstrap), never
single numbers; report "inconclusive" when significance is absent; and treat cold-vs-warm cache
as an explicit axis, not noise.

## 3. What the vendored repos do (and what to steal)

### effect — tinybench micros, plus a real regression harness kept out of CI

- **Microbenchmarks**: `.repos/effect/packages/effect/benchmark/` runs tinybench (devDependency
  `tinybench ^6.1.3`, `.repos/effect/packages/effect/package.json:114`) directly under `node`.
  Most relevant to cogwork's stages: `benchmark/stream/splitLines.ts` (stream throughput across
  chunking shapes, including many 8-byte chunks simulating streaming I/O — the token-delta
  analogue), `benchmark/httpapi/sseClientDecoder.ts` (schema-typed SSE decode with a synthetic
  `Response`, no network), `benchmark/rpc/RpcSerialization.ts` (json vs ndjson vs msgpack
  encode/decode, asserting round-trip correctness inside the bench), plus `Pool.ts` and the
  `schema/` benches (which pin `iterations: 1_000, warmupIterations: 100` explicitly).
- **`runtimeperf`** (`.repos/effect/packages/effect/runtimeperf/`, ~1000 LOC, own README and
  unit tests): fixture contract of `{ run, validate }` factories (synchronous, no I/O — the
  worker hard-rejects Promise-returning fixtures), a **fresh Node process per measurement** so
  processes, not tinybench samples, are the observations, base/head checked out as git
  worktrees with alternating execution order, and seeded-bootstrap classification
  (`runtimeperf/stats.mts`) with `--fail-on-regression` opt-in.
- **`typeperf`** (`.repos/effect/packages/effect/typeperf/`): gates *type-level* cost on
  committed exact thresholds (`suites/schema/thresholds.json`) — a machine-independent metric,
  which is why it can gate at all.
- **Perf CI: none for runtime timing.** The only gated perf-adjacent check is bundle size
  (`.repos/effect/.github/workflows/check.yml`, base-vs-head compare with a PR comment).
- **No fake clocks in benches.** `TestClock` appears only in correctness tests, never in the
  benchmark tree — benches are wall-clock in isolated processes.

### codex — divan micros, a Bazel macro tier, and the strongest replay test culture

- Runner is **divan** (`.repos/codex/codex-rs/Cargo.toml:328`). Microbench:
  `codex-rs/utils/image/benches/prompt_images.rs` (prompt-image loading across synthetic sizes,
  with a 48-variant pool deliberately defeating an internal cache). Macro tier:
  `codex-rs/cli/e2e_benches/codex_help.rs` — divan with `sample_count = 20, sample_size = 1`
  shelling out to the built `codex` binary, registered as the Bazel `e2e-benchmarks` suite
  (`codex-rs/BUILD.bazel:19-26`) and run with optimized builds ("Keep measured binaries
  comparable to production-style optimized builds", `justfile:109-111`).
- **CI runs benches as smoke only**: `just bench-smoke` = `cargo bench -- --test`
  (`.github/workflows/rust-ci.yml:78-79`) — proves the benches start, compares no timings.
- **Deterministic replay everywhere in tests**: a wiremock-based mock model server
  (`codex-rs/core/tests/common/responses.rs`) capturing every request; a **gated SSE server**
  (`codex-rs/core/tests/common/streaming_sse.rs`) that releases stream chunks one at a time
  behind per-chunk `oneshot` gates — the most directly transferable pattern for deterministic
  agent-stream interleaving; a `rollout-trace` crate that reduces recorded raw events back into
  conversation state, and a TUI replay mode reconstructing sessions from persisted events; 748
  insta snapshots. None of it is used for perf measurement — it is all correctness — but it is
  the record/replay substrate a perf harness would sit on.

### opencode — a product-level perf harness that deliberately refuses to gate

- **Playwright-driven scenario benchmarks** at `.repos/opencode/packages/app/e2e/performance/`:
  a shared fixture that forces exactly one machine-readable `BENCHMARK {…}` JSON line per run,
  optional Chrome DevTools trace capture (`chrome-trace.ts`), and streaming scenarios that push
  **160 scripted deltas under a deterministic 30× CPU throttle**, reporting completion time,
  throughput, RAF gap distributions, long tasks — the closest existing analogue to replaying a
  run into a renderer and scoring it.
- **Explicit anti-gating stance** (`e2e/performance/AGENTS.md`): "Benchmarks do not assert
  machine-dependent performance budgets… Assertions verify scenario and metric collection
  completion." Benchmarks run serially, against production builds, excluded from normal test
  discovery, and never in CI.
- **A packaged VCR**: `@opencode-ai/http-recorder`
  (`.repos/opencode/packages/http-recorder/`) records real Effect `HttpClient` and WebSocket
  traffic into JSON cassettes and replays deterministically; **CI is forced into replay mode**
  (`src/recorder.ts`: `if (isCI()) return "replay"`), unused recorded interactions error, and
  cassettes containing detected secrets are refused at write time (`src/redaction.ts`).
- **Deterministic load fixtures**: a seeded lorem generator with pinned IDs
  (`e2e/performance/timeline/session-timeline-stress.fixture.ts`) and a full fake server that
  synthesizes the SSE event stream from a caller-supplied event array
  (`e2e/utils/mock-server.ts`).
- **A perf research log**: `packages/opencode/perf/test-suite.md` — hypothesis / change /
  before / after / decision tables, with warmups and medians emitted by
  `script/bench-test-suite.ts`. The before/after discipline this document asks for, practiced.

### t3code — the only true CI perf gate, and it gates bytes, not milliseconds

- **Transfer budget**: hard caps on wire bytes, decoded bytes, and message counts per provider
  (`.repos/t3code/apps/server/integration/TransferBudgetReport.integration.ts`,
  `TRANSFER_BUDGET` with ~30% headroom over a deterministic 9 MB fixture), enforced by a plain
  assertion in the test suite (`apps/server/src/server.test.ts:8182`) and diffed against a
  main-branch baseline artifact into a PR comment (`.github/workflows/ci.yml:86-107`,
  `thread-transfer-report.yml`). It can gate in CI *because the metric is machine-independent*.
- **A replay provider adapter**: `TestProviderAdapter.integration.ts` feeds a scripted
  `ReadonlyArray<FixtureProviderRuntimeEvent>` per turn through a Queue/Stream as if it were a
  live provider — the budget scenario refuses to run without it ("Transfer budget history
  requires the replay adapter."). Quiescence comes from receipt draining
  (`waitForReceipt`, `drainProviderRuntime`), never sleeps
  (`OrchestrationEngineHarness.integration.ts`).
- No timing benchmarks at all.

### biome-effect-linting-rules — nothing perf-related.

### Cross-repo verdicts

1. Every repo that measures timing keeps timing out of CI gates; the two that gate (effect's
   `typeperf`, t3code's transfer budget) gate **machine-independent counts**. Counts cogwork
   can gate the same way: events ingested, SQLite inserts, IPC frames sent, renderer folds,
   bytes over the socket per replayed run — deterministic under replay, meaningful for exactly
   the defects in the bottleneck survey (per-event sends, O(n²) refolds).
2. Every deterministic event-stream harness is a replay of scripted/recorded events through the
   real consumer (codex's gated SSE server, opencode's mock SSE server and cassettes, t3code's
   replay adapter). Nobody generates load synthetically from scratch.
3. Fake clocks are for correctness, never for perf — benches are wall-clock, isolated, warmed.

## 4. How a replay runner slots into cogwork

The engine's seam is already the right shape:

- **A harness runner is a small interface** whose load-bearing member is
  `run: (request) => Stream.Stream<AgUiEvent, HarnessError, HarnessRunnerEnv>`
  (`packages/engine/src/harness.ts:223-235`). Runners register as a plain array —
  `harnessRunners = [cursorRunner(...), codexRunner(...), providerRunner(...)]`
  (`apps/cli/src/rpc.ts:82-86`) — provided to `Harness.layer`
  (`packages/engine/src/harness.ts:455`). A `replayRunner` is a fourth element.
- **The recording already exists.** Every harness event of every run is persisted:
  `RunRecorder.record` encodes the event to JSON and appends
  `{ seq, type, name, data, atMillis }` (`packages/engine/src/run-recorder.ts:68-93`;
  `packages/contracts/src/run.ts:64-71`) via one SQLite insert
  (`apps/cli/src/ledger.ts:439-455`) into `run_events`
  (`packages/engine/src/control-store-schema.ts:134-144`, primary key `(run_id, seq)`, indexed
  `at`). `atMillis` per event means recorded pacing is available: replay at recorded speed by
  sleeping the inter-event deltas, or divide the deltas for multiplied speed. One retention
  caveat: rows older than 30 days are deleted at boot
  (`packages/engine/src/control-store.ts:100,586-589`), so a stream worth keeping as a fixture
  must be exported out of the store (a checked-in NDJSON file of decoded `AgUiEvent`s is the
  natural fixture format).
- **The decode-and-refeed seam is proven.** `RunRecorder.replay` already reads a settled run's
  rows and decodes each back into the very `AgUiEvent` a live subscriber saw — its own comment:
  "A settled run reads back through the same seam it was written through"
  (`packages/engine/src/run-recorder.ts:96-106`) — and the daemon uses it to serve history to
  every watch (`packages/engine/src/daemon.ts:159`). A replay runner is that same decode,
  pointed at the *front* of the pipeline instead of the back: emit the decoded events as its
  `run` stream, and everything downstream — executor fold (`Stream.runFoldEffect`,
  `packages/engine/src/executor.ts:781`), recorder, ledger insert, event bus, NDJSON socket,
  Electron IPC, renderer fold — is the real code under real load.
- **Prior art for the runner itself is in the tests.** `executor.test.ts` builds complete
  `HarnessRunner`s from canned event arrays: `testRunnerDefaults` supplies capabilities,
  catalog, readiness, and preflight (`packages/engine/src/executor.test.ts:574-611`), and the
  simplest runner is `run: () => Stream.fromArray(events)` (`executor.test.ts:614-624`;
  `harness.test.ts:281` and following do the same with `Stream.empty` / `Stream.fail`). A
  production replay runner is this test double plus: a fixture loader (NDJSON file or a source
  `run_id` in a copied control store), pacing (`Stream.mapEffect` with a scaled
  `Effect.sleep` on the recorded deltas, or unpaced for saturation tests), and a fan-out knob
  (N concurrent replays to simulate 6–8 agents — the scheduler and executor already fork one
  fiber per run).
- **The headless composition exists too.** `engineTestLayer` wires bus + ledger + recorder +
  session store with a pluggable ledger core
  (`packages/engine/src/testing/engine-test-layer.ts:16-27`), and the daemon takes the SQLite
  ledger as an injected layer (`packages/engine/src/daemon.ts:315`,
  `apps/cli/src/rpc.ts:301`) — so a bench entry point can run daemon-side replay with the real
  SQLite ledger, no Electron, and measure engine-side stages in isolation from the renderer
  when wanted.
- **What to measure during replay** is the observability doc's subject: spans already name
  every service method, `Metric.timer` histograms are the missing piece, and counters make the
  machine-independent gate (events, inserts, frames, folds per replayed fixture) — see
  `docs/research/effect-observability-for-performance.md`.

Two honest caveats for option (a) in this codebase. First, replay exercises the pipeline but
not the agent subprocesses themselves — spawn cost, sandbox, git worktree churn, and the
provider runner's per-file `git diff` subprocesses (bottleneck survey §1) are outside a
replayed stream and need either component benches or a recorded file-event fixture of their
own. Second, k6's maintenance warning applies: a recorded fixture couples to the `AgUiEvent`
schema; the forward-compat guard in `RunRecorder.replay` (drop what no longer decodes) makes
stale fixtures fail soft, so fixtures should assert their decoded event count to fail loud
instead.

## 5. Renderer-side capture under replay

Standard practice needs only two primitives, both already designed for scripted load:

- **React `<Profiler>`**: wraps the transcript/board tree and reports per-commit timings via
  `onRender(id, phase, actualDuration, baseDuration, startTime, commitTime)`; `actualDuration`
  "indicates how well the subtree makes use of memoization" and comparing it against
  `baseDuration` shows whether memoization works at all — the exact question for the O(n²)
  refold fix. Caveat from the docs: "it is disabled in the production build by default", so
  renderer benches run a dev/profiling build and are compared only against the same build kind
  (<https://react.dev/reference/react/Profiler>).
- **User Timing**: `performance.mark()` at ingest (frame received from IPC) and
  `performance.measure()` at commit gives ingest-to-paint latency per event batch, collected
  via `PerformanceObserver`/`getEntriesByType("measure")`
  (<https://developer.mozilla.org/en-US/docs/Web/API/Performance/measure>). Aggregate to
  medians/p95 per replayed fixture.

opencode's harness shows the assembled version: drive the UI with scripted streams under a
deterministic CPU throttle, capture a Chrome DevTools trace when asked, and emit one
machine-readable JSON result line per scenario (`.repos/opencode/packages/app/e2e/performance/`
— `benchmark.ts`, `chrome-trace.ts`). For cogwork the driver is simpler than Playwright: the
replay runner pushes events through the real daemon socket, and the renderer measures itself
with the two primitives above.

## 6. Recommendation

| Option | Pros | Cons |
| --- | --- | --- |
| **(a) Record-and-replay through the real pipeline** | Representative by construction (V8's whole argument for real-world workloads); deterministic workload — before and after see byte-identical event streams, which live LLM runs can never give; zero token cost per iteration; speed-multipliable to find cliffs; the recording already exists in `run_events` with per-event timestamps; the decode seam (`RunRecorder.replay`) and the runner shape (`Stream.fromArray` test doubles) are already in the codebase; measures cross-stage interactions (backpressure, IPC coalescing, event-loop contention) that microbenchmarks structurally cannot; enables machine-independent count gates (t3code's pattern). | Doesn't exercise agent subprocess/sandbox/worktree cost — the stream starts where the harness's stdout ends; fixtures couple to the `AgUiEvent` schema and need re-recording as it moves (k6's maintenance warning); wall-clock results still machine-dependent, so timing comparisons stay local before/after, not CI gates; small build cost (a `replayRunner` + fixture export). |
| **(b) Component microbenchmarks** | Precise attribution to one stage (ledger insert, schema decode, renderer fold); fast inner loop while optimizing that stage; strong runner support with built-in statistics (tinybench/vitest bench, Effect's own benchmark tree as templates — `splitLines.ts` is nearly the token-delta bench already); cheap to keep. | Non-representative in isolation — V8 retired Octane for exactly this failure mode, and a stage bench cannot see the interaction defects the bottleneck survey names (unbounded accumulation, per-event IPC, event-loop starvation); a stage win proven in a micro can vanish end-to-end; every vendored repo keeps micro timings out of CI gates. |
| **(c) In-situ measurement only** | Zero build cost; perfectly representative environment; catches what the lab misses. | Workload differs on every sample (the LLM never replays), so before/after deltas are confounded by workload, not just noise — no source read treats uncontrolled use as an attribution instrument; slow (real runs), costly (tokens), and the sample count the statistics require (≥10–30 per side) is impractical per fix. |

**The combination the sources support:**

1. **(a) is the measurement layer.** Build the replay runner: export 2–3 recorded streams as
   fixtures (a heavy provider run with diffs, a chatty multi-agent set, a long transcript),
   replay N concurrent copies through the registered-runner seam, and score each run with
   pipeline counts (machine-independent) plus wall-clock/latency distributions
   (machine-dependent, compared locally). This is Telemetry-over-WPR transposed: recorded real
   traffic, deterministic replay, whole real system.
2. **(b) is the drill-down layer.** When replay names a stage, write the tinybench micro for
   that stage (Effect's `benchmark/` tree is the template; `runtimeperf`'s process-isolation
   and seeded-bootstrap comparison is the upgrade path if micros ever need to gate), keep it
   for the optimization inner loop, and re-verify the win in the macro replay before claiming
   it.
3. **(c) is the validation layer.** Keep in-situ observability (spans, `Metric.timer`
   histograms per the observability doc) to detect regressions in daily use and confirm lab
   wins survive reality — never to produce the before/after number.
4. **Statistical hygiene everywhere**: warmup, fixed workload, ≥10 runs per side (30 for small
   deltas), compare distributions with significance (Welch's t-test or a seeded bootstrap), and
   report "no stars, no conclusion." Gate CI, if at all, on replay-derived counts and budgets —
   never on milliseconds.
