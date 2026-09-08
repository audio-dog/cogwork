# Preventing test-suite performance drift with machinery

Date: 2026-09-03.

> **This is a research record, not the plan.** The decision it fed is ADR
> [0022](../adr/0022-a-sensor-lives-where-its-signal-is-produced.md), and the decision departs from
> the recommendation below in three places. `turbo run test --affected` (recommendation 3) was
> **rejected**: CI must run every test on every pull request, and a warm cache already resolves an
> unchanged package in 0.12s, so it bought seconds at the cost of a guarantee. The measurement was
> made **fortnightly** rather than continuous, because the problem does not warrant more. And the
> comparison in recommendation 4 became the sensor itself rather than a separate hand-run tool: one
> job measures current `main` against a **baseline commit** on the same runner, which this survey
> did not consider and which is what makes a slow cadence sound. Everything else below carried
> through, including all five "do not adopt" findings.

**Question.** How does this repo automatically stop its test suite getting slower, so that slowness
is caught by machinery instead of by a human filing a ticket every month? Can a Biome GritQL plugin
count things in a file? Which performance gate survives a noisy 4-vCPU runner? What reduces the
repeated module-import cost now that `isolate: false` is rejected? Can Turborepo per-package caching
and one Vitest scheduler coexist? And what do Effect, Vitest, Vite, Biome and Turborepo actually
commit for this?

**Sources.** Primary only. The Biome 2.5.11 binary in this worktree, driven directly with test
fixtures (`biome lint`, `biome explain`) — the GritQL answers in §1 are measured, not read. The
installed `vitest@4.1.11` package: its shipped `.d.ts` JSDoc and its compiled reporter code. The
Vitest v4 documentation source at tag `v4.1.11` read from the repository, because the live
`vitest.dev` now serves v5 docs and this repo pins `^4.1.10` (`pnpm-workspace.yaml:34`). The
vendored Effect repo at `.repos/effect`. The committed workflow and config files of
`vitest-dev/vitest`, `vitejs/vite`, `biomejs/biome` and `vercel/turborepo`, read through the GitHub
API. Official docs for GritQL, CodSpeed, `github-action-benchmark`, Datadog Test Optimization and
Turborepo. The shipped source of `@codspeed/vitest-plugin@5.7.1` and its npm registry metadata.

**TL;DR.** Counting is **not expressible** in Biome 2.5.11's GritQL: accumulation across matches
silently stops at the first match (measured: three `it()` calls accumulate to a list of length 1),
`bubble` cannot pierce an accumulator, numeric ordering predicates fail to compile, and diagnostic
messages do not interpolate variables at all. So "fail if a file declares more than N tests" cannot
be a Grit plugin — but Biome ships `complexity/noExcessiveLinesPerFunction`, and a whole family of
test-hygiene rules already gated on the `vitest` dependency, all currently unset in `biome.json`.
CodSpeed's default instrument is a **category error for this suite**: its own docs say "CodSpeed CPU
Simulation mode does not include system calls in the measurement", and this suite is 60–75% idle on
subprocesses, so the instrument would measure almost none of the real cost; its plugin also only
applies in Vitest's `benchmark` mode, so it never sees an ordinary `it()`. Vitest has no built-in
baseline comparison for tests (only `benchmark.compare`, which renders a column and never changes
the exit code). The one mechanism that is both noise-robust and cheap is the shape Effect already
committed and Vitest already documents: **paired base-vs-head measurement plus a bootstrap
confidence interval on the median ratio**, plus **`timeout-minutes` as a crude ceiling** — and the
crucial structural fix, which is that `turbo run test` will start up to **10** concurrent Vitest
pools by default on 4 vCPU. No repo surveyed commits a timing budget for its own test suite; Effect's
`runtimeperf-compare --fail-on-regression` exists and is **wired into no workflow at all**.

---

## 1. GritQL and Biome: counting is not available

### The measured answer: no

Every claim here comes from running the Biome binary in this worktree (`biome --version` →
`2.5.11`) against a fixture with a `describe` containing exactly three `it()` calls, with a config
loading one plugin and no built-in rules.

**Accumulation does not aggregate across matches.** The canonical counting idiom compiles and runs,
but produces the wrong number:

```grit
`describe($name, $body)` where {
  $count = 0,
  $body <: contains `it($t, $f)` where { $count += 1 },
  $count <: 3,                     // never matches
  register_diagnostic(span = $name, message = "…")
}
```

With three `it()` calls, `$count <: 3` does not fire and `$count <: 1` **does**. The list form
behaves identically: `$calls = []` then `$calls += $t` then `length(target = $calls) <: 1` fires,
`<: 3` does not, `<: 0` does not. `contains` binds its metavariables once, so the accumulator is
written once. This is the failure mode that matters most, because it is **silent** — the pattern
compiles, runs, and reports a plausible-looking wrong count.

**`bubble` cannot rescue it.** `bubble($calls)` (piercing) and bare `bubble` both abort at runtime
with `count errored: Variable $calls is not bound`, surfaced as an `info` diagnostic, not an error.
Upstream GritQL documents `bubble` precisely as the way to stop a metavariable locking to its first
binding ([Grit: bubble](https://docs.grit.io/language/bubble)), and documents piercing with
`bubble($name)` — but Biome's engine does not bind the outer accumulator inside the bubble.

**Numeric ordering predicates do not compile.** `$n > 2`, `$n >= 2` — even on a plain `$n = 5` with
no accumulation — fail with `Error(s) during loading of plugins: Failed to compile the Grit plugin`.
These are real grammar productions (`GritPredicateGreater`, `GritPredicateGreaterEqual`,
`GritPredicateLess`, `GritPredicateLessEqual` in the Biome GritQL grammar vendored at
`.repos/biome-effect-linting-rules/rules/gritql.ungram:399-402,470-488`), so this is an
unimplemented compiler path, not a syntax error on my part. Only `<:` match-style comparison works:
`length(target = [1, 2, 3]) <: 3` fires and `<: 9` correctly does not — so `length()` itself is
implemented, and equality against a fixed number works.

**Diagnostic messages do not interpolate.** `register_diagnostic(span = $name, message = "name is
$name")` prints the literal text `name is $name`. Even a plain snippet metavariable is not
substituted. A counting rule could therefore not report the count it found.

Net: the three ingredients of an aggregate assertion — accumulate, count, compare — are
individually present and jointly unusable. **Counting or aggregate assertions over a file are not
expressible in Biome 2.5.11's GritQL.** Do not attempt a "max N tests per file" or "max N lines per
file" Grit plugin.

### What the docs say, and why they were not enough

Biome's plugin docs carry no limitations section and state only that "GritQL support in Biome is
actively being worked on… some features are still outright missing"
([Biome: GritQL reference](https://biomejs.dev/reference/gritql/),
[Biome: linter plugins](https://biomejs.dev/linter/plugins/)), deferring to the tracking issue.
That issue lists **multifile patterns** and **sequential patterns** as not implemented, marks
built-in Grit functions as partially supported with "exact coverage is unclear", and states plainly
that "Biome doesn't support JS functions inside GritQL"
([biomejs/biome#2582](https://github.com/biomejs/biome/issues/2582)) — which closes off the escape
hatch Grit itself offers, where "JavaScript functions can implement custom math logic"
([Grit: functions](https://docs.grit.io/language/functions)). Upstream Grit documents `length` and
list accumulation with `+=` ([Grit: patterns](https://docs.grit.io/language/patterns)) but its
`where`-clause reference documents only `<:`, `!`, `and`, `or`, `if` and `=`
([Grit: conditions](https://docs.grit.io/language/conditions)) — no arithmetic. The maintainer's own
vendored rule guidance already reached the same conclusion by a different route: "Avoid unsupported
features such as rewrites, suppressions, and multi-file matches. Prefer simple captures plus
`contains` checks when variadic or nested bindings fail"
(`.repos/biome-effect-linting-rules/docs/rule-guidance.md:22`).

### What Biome *can* enforce natively, and does not today

All verified with `biome explain <rule>` against the local 2.5.11 binary. None of these appear in
`biome.json`, whose linter block sets only `preset: "recommended"`, one `style` rule and one
`nursery` rule (`biome.json:14-30`).

Bounding size and complexity:

| Rule | Group | Default severity | Note |
| --- | --- | --- | --- |
| `noExcessiveLinesPerFunction` | `complexity` | `info` | "Restrict the number of lines of code in a function." `maxLines` default 50. Counts the function **body** only. |
| `noExcessiveCognitiveComplexity` | `complexity` | `info` | Cognitive-complexity score per function, threshold default 15. |

There is **no built-in rule bounding whole-file line count**, and no `nursery` rule specific to test
files.

Test hygiene — Biome ships a whole `test` **domain**, and each of these rules "is enabled when one
of these dependencies are detected: … `vitest@>=1.0.0`", which this repo satisfies in every package:

| Rule | Group | Default severity | Recommended for the domain |
| --- | --- | --- | --- |
| `noExcessiveNestedTestSuites` | `complexity` | `info` | no |
| `noFocusedTests` | `suspicious` | `warn` (unsafe fix) | yes |
| `noSkippedTests` | `suspicious` | `warn` (unsafe fix) | no |
| `noDuplicateTestHooks` | `suspicious` | `error` | yes |
| `noExportsInTest` | `suspicious` | `error` | yes |
| `noMisplacedAssertion` | `suspicious` | `warn` | no |
| `noDoneCallback` | `style` | `info` | no |

None of these bound *speed*. `noExcessiveNestedTestSuites` is the closest structural proxy, and
`noFocusedTests` is the one that protects correctness rather than time. The relevant conclusion for
the drift question: the 27 committed Grit plugins and their fixture tests
(`biome.json:32-60`, `configs/lint/tests/rules.test.mjs`) prove custom static rules are cheap
*here* — but static analysis cannot express the property in question, and Biome's own size rules
bound functions, not test files or suite duration.

## 2. Noise-robust performance gating, ranked

### CodSpeed

**It measures simulated cycles, not wall time.** "CodSpeed instruments your benchmarks to measure
the performance of your code, simulating the CPU behavior. A benchmark will be run **only once**"
([CPU Simulation instrument](https://codspeed.io/docs/instruments/cpu/)). Cycles are estimated as
`Icycles + (L1 misses × L2/L3 cost) + (LL misses × RAM cost)`, with each instruction weighted by
measured real-hardware cost, then converted to a displayed "execution speed" via a constant
frequency. That is what makes it hardware-agnostic and immune to ambient load.

**It is a category error for this suite, and CodSpeed says so itself.** From the same page:

> To ensure that our execution speed measurements are as stable and reliable as possible, **CodSpeed
> CPU Simulation mode does not include system calls in the measurement**. Instead, we focus solely on
> the code executed within user space (the code you wrote), excluding any time spent in system calls.

A suite that is 60–75% idle waiting on real `git` and real agent executables consists almost
entirely of what that sentence excludes. Spawning a subprocess is a syscall; waiting on it is a
syscall; the child's own work is a different address space the simulation never enters. CodSpeed
would report a near-flat number while the suite's actual cost doubled. The docs even note the
excluded wall time "is recorded and this data is available in the trace view" — diagnostic, but
explicitly not in the gating metric. CodSpeed's own answer is its Walltime instrument on
"bare-metal ARM64 runners managed and provided by CodSpeed"
([Walltime](https://codspeed.io/docs/instruments/walltime/)), which captures I/O and syscalls — and
which warns "you should try and avoid running multiple benchmark processes in parallel since this
can lead to noisy measurements", i.e. the opposite of what `turbo run test` does.

**It only instruments `bench()`, never `it()`.** The docs are titled "Writing benchmarks with
vitest-bench" and show only `bench()` inside `describe()`
([vitest plugin](https://codspeed.io/docs/benchmarks/nodejs/vitest)). The shipped plugin source
settles it: `apply(_, { mode }) { if (mode !== "benchmark") … }`
(`@codspeed/vitest-plugin@5.7.1`, `dist/index.mjs:32-33`) — the plugin does not apply outside
Vitest's benchmark mode. Instrumenting the existing 1640 tests is not on offer.

**Vitest 4 is supported**, despite the docs. The docs claim "only compatible with `vitest` v3.2 and
above"; the npm registry metadata for `@codspeed/vitest-plugin@5.7.1` declares
`peerDependencies: { "vitest": "^3.2 || ^4", "vite": "^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0",
"tinybench": ">=2.9.0" }`. Note `vite: ^7` — this repo resolves `vite@8.2.2`, so the peer range
would not be satisfied today. **Unverified:** whether that peer range is enforced or merely warned
about under this pnpm configuration.

**Gating works and is real.** CodSpeed provides a "CodSpeed Performance Analysis" status check that
can be made required in branch protection, failing on the project's regression threshold, with an
admin-only "acknowledge" escape hatch
([performance checks](https://codspeed.io/docs/features/performance-checks/)).

**Pricing:** Free plan covers up to 5 users with unlimited runs and repositories, private
repositories included; open source gets unlimited users and 600 macro-runner minutes/month; Pro is
$15/user/month ([pricing](https://codspeed.io/pricing)). For a single-maintainer private repo the
free tier is sufficient — cost is not the objection here, measurement validity is.

### `benchmark-action/github-action-benchmark`

- **Formats:** `cargo`, `go`, `benchmarkjs`, `pytest`, `googlecpp`, `catch2`, `julia`,
  `benchmarkdotnet`, `jmh`, `benchmarkluau`, plus `customBiggerIsBetter` and `customSmallerIsBetter`.
  The custom formats take a plain JSON array where "every entry… only needs to provide `name`,
  `unit`, and `value`", with optional `range` and `extra`
  ([README](https://github.com/benchmark-action/github-action-benchmark)). Any script that can emit
  three fields per metric is a supported producer — including one that parses Vitest's JSON reporter.
- **It can fail a build.** `fail-on-alert`: "If it is set to `true`, the workflow will fail when an
  alert happens." `alert-threshold` is a ratio like `"150%"`; `fail-threshold` optionally separates
  the failing bar from the alerting bar and must be ≥ `alert-threshold`. `comment-on-alert` leaves a
  commit comment.
- **`gh-pages` is not required.** It is required only for the hosted charts.
  `external-data-json-path` names an "External JSON file which contains benchmark results until
  previous job run… this action updates the file content instead of generating a Git commit in
  GitHub Pages branch", with `save-data-file: false` and `skip-fetch-gh-pages` as companions. So
  history can live in `actions/cache` or a committed file.

Its weakness for this repo is that it compares a scalar against the previous recorded value on a
different runner at a different time. Against a 14s–56s spread, a percentage threshold either sits
above 300% (and catches nothing) or fires constantly.

### Datadog Test Optimization

- **It does track per-test duration against a baseline, with named statistics.** From the Datadog
  glossary: *baseline mean* is "the mean duration of the same test in the default branch, calculated
  over the last week of test runs"; *absolute change* is "the absolute difference between the test
  duration and the baseline mean"; *relative change* is the relative form; *standard deviation
  change* is "the number of standard deviation above the baseline mean"
  ([Datadog glossary](https://docs.datadoghq.com/glossary/?product=ci-cd)). Duration is a queryable
  facet in the Test Optimization Explorer
  ([explorer](https://docs.datadoghq.com/tests/explorer/)). Its own regression rule is extremely
  loose: a run is flagged only when duration exceeds **five times** the mean *and* the maximum
  recorded on the default branch, with a 500 ms floor.
- **It cannot gate a PR on duration.** Datadog PR Gates supports exactly six rule types — SAST, SCA,
  code coverage, IaC scanning, secret scanning, and new flaky tests
  ([PR Gates](https://docs.datadoghq.com/quality_gates/)). There is no duration or performance rule.
  Duration regressions can notify (via a CI Test monitor) but not block.
- **Instrumenting Vitest:** `dd-trace` as a dev dependency plus
  `NODE_OPTIONS="--import dd-trace/register.js -r dd-trace/ci/init"` and `DD_TEST_SESSION_NAME`;
  Vitest ≥ 1.6.0; dd-trace v6 needs Node ≥ 22. Documented limitations: browser mode unsupported; and
  notably, "Vitest's isolation setting causes setup overhead", with the suggested mitigations being
  to disable isolation or set `DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT=true` — which then
  disables custom test tags, custom spans, log correlation and failed-test replay
  ([JS test setup](https://docs.datadoghq.com/tests/setup/javascript/)). The first mitigation is
  the option this repo already rejected.

### Vitest's own facilities

- **`--reporter=json`** emits, per test file: `startTime` and `endTime` as epoch milliseconds
  (derived as the min test `startTime` and max `startTime + duration`), and per assertion:
  `duration` in milliseconds, `fullName`, `status`, and `location` when `includeTaskLocation` is on;
  plus run-level `numTotalTestSuites`, `numTotalTests` and a top-level `startTime`
  (verified in the compiled reporter, `vitest@4.1.11`,
  `dist/chunks/index.UpGiHP7g.js:3541-3608`). Per-file wall time and per-test wall time are both
  available. What is **not** in the JSON is the phase breakdown (transform / setup / import /
  tests / environment) that the terminal `Duration` line prints — and that breakdown is where the
  80.9s import cost is visible.
- **`--reporter=junit`** emits `time` in seconds on `<testcase>` and on `<testsuite>`
  ([reporters](https://vitest.dev/guide/reporters.html)). Coarser than JSON; no advantage here.
- **`slowTestThreshold`** exists, default **300 ms**: "The number of milliseconds after which a test
  is considered slow and reported as such in the results." It sets a `TestDiagnostic` flag and drives
  colouring. It does not fail a run.
- **There is no built-in baseline comparison for tests.** The only comparison in Vitest is for
  benchmarks: `benchmark.outputJson` ("benchmark output file") and `benchmark.compare` ("benchmark
  output file to compare against"), both also exposed as top-level CLI flags. Reading the compiled
  path, `compare` only supplies `baseline: options.compare?.[task.id]` into the table renderer
  (`dist/chunks/index.UpGiHP7g.js:4113,4135`) — it renders a comparison column and never influences
  the exit code. So Vitest can produce a baseline artifact and print a diff, but the fail decision
  must be written by hand.

### Ranking for this repo

1. **A committed base-vs-head paired comparison with a confidence interval, run in one job.** This is
   the only mechanism whose robustness comes from its *statistics* rather than from special hardware,
   and the repo's own vendored dependency already implements it (§5). Both refs are measured on the
   same runner in the same minute, so ambient load is largely common-mode; the decision is made on
   the distribution of paired ratios, not on a single duration.
2. **`timeout-minutes` on the `test` job.** Crude, free, one line, and immune to nothing — but it
   converts unbounded drift into a hard failure and is what every repo surveyed actually commits.
3. **`github-action-benchmark` with `customSmallerIsBetter`,** fed from `--reporter=json`, for
   *trend recording* with `fail-on-alert: false` and a very high `fail-threshold`. Useful as a chart;
   not a gate at this noise level.
4. **Datadog Test Optimization** — worth it only if per-test history and flake tracking are wanted
   for their own sake. It cannot gate, and its own mitigation advice points at the rejected setting.
5. **CodSpeed CPU simulation — do not adopt.** By its own documentation it excludes exactly the cost
   this suite is made of, and its plugin cannot see ordinary tests.
6. **CodSpeed Walltime on Macro Runners — do not adopt now.** It would measure the right thing, but
   it requires writing `bench()` wrappers for subprocess-backed flows, warns against the parallelism
   this suite depends on, and consumes metered minutes. Revisit only if a handful of named end-to-end
   flows become the thing worth guarding.

## 3. Reducing import cost without `isolate: false`

`isolate: false` is rejected: at `--maxWorkers=4` it deterministically fails, because a shared
registry leaks `vi.mock` registrations, `vi.stubGlobal` values and Effect `Context.Reference`
memoised defaults — and it is not even faster there. The property to test each alternative against
is therefore exactly one question: **does it share mutable module state across test files?**

First, a correction that matters before anything else: **`poolOptions` no longer exists in Vitest 4.**
The v4 migration notes record `poolOptions.forks.singleFork` → `maxWorkers: 1, isolate: false`,
`poolOptions.threads.singleThread` → `maxWorkers: 1, isolate: false`, `poolOptions.*.isolate` → the
top-level `isolate`, `maxThreads`/`maxForks` → `maxWorkers`, `minWorkers` removed entirely, and
`VITEST_MAX_THREADS`/`VITEST_MAX_FORKS` → `VITEST_MAX_WORKERS`
([v4 migration](https://v4.vitest.dev/guide/migration)). Confirmed against the installed package:
`singleThread` and `singleFork` appear nowhere in `vitest@4.1.11`'s shipped types or code. So
`singleThread`/`singleFork` are **not options to evaluate — they are spellings of the rejected
setting.** Anything that reaches them reaches `isolate: false`.

| Mechanism | Shares mutable module state across files? | Effect on import cost | Verdict |
| --- | --- | --- | --- |
| `pool: 'threads'` (from the v4 default `'forks'`) | **No.** Each test file gets its own `Worker`; isolation is unchanged. | "may be slightly slower than `pool: 'threads'` in larger projects" — the gain is process-spawn overhead, not module re-import. Each worker still re-imports Effect per file. | Safe. Try it; expect a modest win. `'forks'` is the default because it "is better for compatibility issues (hanging process and segfaults)" — a real consideration for a suite that spawns real `git` and real agent binaries. |
| `singleThread` / `singleFork` | **Yes** — they *are* `isolate: false` in v4. | n/a | Rejected by definition. |
| `fileParallelism: false` | **No.** Files still run in isolated environments, just one at a time. | Improves *startup* time only. Catastrophic for a wait-bound suite: 60–75% idle time stops overlapping. | Do not use suite-wide. Legitimate per-project, for suites that must not compete (Effect does exactly this, §5). |
| `experimental.fsModuleCache: true` | **No.** It caches *transformed module text* on disk, not live module instances. Each file still evaluates its own module graph. | The one mechanism aimed squarely at import cost. JSDoc: "Enable caching of modules on the file system between reruns." The v4 guide measures a >900-module single file at 8.75s first run (transform 4.02s, import 5.52s) → 5.90s second run (transform 842ms, import 2.35s). | **The best-fit candidate.** Caveats stated in the same guide: the gain "is most noticeable when rerunning a small number of tests that depend on a large module graph. For full test suites, parallelization already mitigates the cost" — so it helps local iteration much more than a cold CI run, and CI would need the cache directory persisted. `experimental`, so pin behaviour with a test. |
| `NODE_COMPILE_CACHE` | **No.** V8 bytecode cache, per-process. | Cuts compile, not transform or evaluation. Documented as "Disabled automatically when using the `v8` coverage provider". | Free; try it. |
| `deps.optimizer` (`.ssr` for `node` environments; `.web` was renamed `.client` in v4) | **No.** It changes how dependencies are *built*, not how modules are shared. | Vitest "bundles external libraries listed in the `include` option into single files using esbuild… By bundling them into one file we can save a lot of time", and the docs say plainly that with "a lot of tests, this might improve their performance" ([deps](https://vitest.dev/config/deps)). This is the most direct answer to "every file re-imports Effect": bundle Effect once. | **Highest-value safe experiment.** Requires explicitly listing Effect packages in `optimizer.ssr.include`. Note Effect's own root config does the opposite for one native module — `optimizeDeps: { exclude: ["bun:sqlite"] }` (`.repos/effect/vitest.config.ts:58-60`) — so expect per-package exceptions. |
| `server.deps.inline` | **No.** It forces a dependency through Vite's transform pipeline instead of being externalised. | Usually *increases* cost — it adds transform work. It is a correctness tool (ESM/CJS interop), not a speed tool. | Not a lever for this problem. |
| `test.projects` in one root config vs one Vitest process per package | **No.** Projects are a *scheduling* construct. Isolation is still per-file, and each project can set its own `isolate`, `pool` and `environment`. | The real win is one Vite server and one scheduler instead of N (§4), not fewer imports. | Structurally the most valuable change available — see §4. |
| `test.dir` | No. | Speeds file *discovery* only. Already effectively bounded by `include: ["src/**/*.test.{ts,tsx}"]` (`configs/test/base.ts`). | No further gain. |

The honest summary: nothing except sharing a module registry removes the per-file re-import of
Effect, and sharing the registry is what broke. What is available is making each import *cheaper* —
`deps.optimizer` bundling Effect, `fsModuleCache` persisting transforms, `NODE_COMPILE_CACHE`
persisting bytecode — and making the machine spend its idle time better (§4). Treat any claimed
speed-up as unverified until measured with the paired method in §2.

## 4. Sharding, and the Turborepo-vs-one-scheduler tension

### `--shard`

`--shard=<index>/<count>` splits **test files**, not test cases: "If you've got 1000 test files, the
`--shard=1/4` option will run 250 test files, no matter how many test cases individual files have."
It cannot be combined with `--watch`. The documented CI shape is `--reporter=blob --shard=i/n` on
each machine, upload `.vitest-reports/*` (and `.vitest-attachments/**` if `context.annotate` is
used) as artifacts, then a dependent job downloads all of them with `merge-multiple: true` and runs
`vitest --merge-reports`, which "Merges every blob report located in the specified folder
(`.vitest-reports` by default). You can use any reporters with this command (except `blob`)"
(v4 docs source, `docs/guide/improving-performance.md` and `docs/guide/cli.md` at tag `v4.1.11`).

Two facts that bear directly on the 4-vCPU problem:

- **Reporting merges cleanly; coverage does not have a documented merge path.** The v4 coverage guide
  contains no mention of merging, sharding, or `--merge-reports`. `--changed` interacts with coverage
  ("When used with code coverage the report will contain only the files that were related to the
  changes") and `--coverage.changed` exists, but there is no documented mechanism for combining
  coverage across shards. **Unverified:** whether running the coverage reporter under
  `--merge-reports` produces correct combined coverage. This repo has no coverage gate, so it is
  moot today.
- **Sharding is documented as a fix for main-thread contention, with an explicit worker arithmetic.**
  "Vitest will run only a single Vite server in its main thread… In a high CPU-count machine the main
  thread can become a bottleneck." The worked example: "Example for splitting tests on 32 CPU to 4
  shards. As each process needs 1 main thread, there's 7 threads for test runners (1+7)*4 = 32", i.e.
  `VITEST_MAX_WORKERS=7 vitest run --reporter=blob --shard=i/4`. **That arithmetic is the direct
  diagnosis of this repo's CI.** Eight packages each running `vitest run` on 4 vCPU means eight main
  threads before a single test executes.

### The oversubscription is worse than "N pools"

`turbo run` has **`--concurrency` default `10`**
([turbo run](https://turborepo.dev/docs/reference/run)). Nothing in `turbo.json` overrides it. So on
a 4-vCPU `ubuntu-latest` runner, `pnpm test` is permitted to start all eight package `test` tasks at
once — eight Vite main threads plus each pool's own workers — and then those processes fight over 4
cores while most of them are actually idle waiting on child processes. That is a plausible mechanical
explanation for the 14s–56s spread: the outcome depends on how the eight schedulers happen to
interleave.

### Is there a documented way to get both caching and one scheduler?

**Partly — and the honest answer is that no single documented mechanism gives both at full strength.**
Four options, each documented, with what each actually costs:

1. **`turbo run test --affected` (documented, and used upstream).** `--affected` "filters tasks to
   only packages changed on the current branch", by default equivalent to `--filter=...[main...HEAD]`,
   overridable with `TURBO_SCM_BASE` / `TURBO_SCM_HEAD`. This is exactly the "changed packages" input
   the question asks about, and Turborepo's own CI commits it:
   `turbo run check-types test build package-checks --affected --filter="./packages/*"
   --filter="!@turbo/repository" --color --env-mode=strict`
   (`vercel/turborepo`, `.github/workflows/test-js-packages.yml`). It preserves caching and shrinks
   the fleet — but it still spawns one Vitest per selected package. **Pair it with
   `--concurrency=1` or `--concurrency=2`** to stop the oversubscription: serialising the *pools*
   while each pool keeps its own internal parallelism is the cheapest structural fix available, and
   it requires no config change to Vitest at all.
2. **Sharding through Turborepo passthrough args — documented, and it destroys caching.** Turborepo's
   own Rust suite does this:
   `turbo run test --filter=turborepo-crates … -- --partition hash:${{ matrix.shard }}/2`
   (`.github/workflows/turborepo-test.yml`). But passthrough arguments are part of the **global**
   hash: "`turbo build -- --arg=value` will cause **all** tasks to miss cache when compared to either
   `turbo build` or `turbo build -- --arg=diff`"
   ([caching](https://turborepo.dev/docs/crafting-your-repository/caching)). So
   `turbo run test -- --shard=1/2` makes **every** package miss cache on **every** run. Do not do
   this to get sharding.
3. **A root task (`//#test`) running one Vitest with `projects`.** Root tasks are documented
   (`//#task-name`, invoked as `turbo run //#test`), and this repo already uses the pattern for
   `//#format-and-lint` (`turbo.json:5-9`). One Vite server, one scheduler, no oversubscription,
   and `--shard` becomes usable without passthrough-arg cache destruction. The cost is exactly what
   the question anticipates: one cache entry keyed on the whole repo's inputs, so any change anywhere
   reruns everything. `inputs` with `$TURBO_DEFAULT$` can narrow that, but not back to per-package
   granularity.
4. **Vitest's own change detection: `--changed [since]` plus `--project`.** `--changed` "Run tests
   only against changed files. If no value is provided, it will run tests against uncommitted
   changes"; `--project <name>` selects projects by name, repeatable, and supports wildcards
   (`--project=packages*`) and negation (`--project=!pattern`). Under a root `projects` config this
   gives one scheduler *and* change-based narrowing — but the narrowing is Vitest's module-graph
   reachability, not Turborepo's content-hash caching, so unchanged work is *re-run-but-narrowed*
   rather than *skipped-because-cached*.

Plainly: **there is no documented mechanism that keeps Turborepo's per-package content-hash caching
and gives Vitest a single scheduler at the same time.** The two designs disagree about what the unit
of work is. The best documented compromise is (1) — `--affected` with a low `--concurrency` — which
keeps caching intact, keeps eight small cache entries, and bounds the pool count with one flag.

## 5. Prior art: what is actually committed

### Effect (`.repos/effect`, read at this worktree's vendored HEAD)

Present:

- **One root `projects` config, ~35 projects, one scheduler** (`vitest.config.ts:89-195`), with a
  shared base merged into each (`shared`, `:57-87`).
- **Global concurrency on by default**: `sequence: { concurrent: true }` in the shared config
  (`vitest.config.ts:76-78`). This is notable because Vitest's own default is the opposite —
  `sequence.concurrent` is documented `@default false` in the installed types. Effect opts the whole
  monorepo into concurrent tests and opts *out* per project.
- **Per-project opt-outs for contended suites.** `cluster-integration` sets
  `sequence: { concurrent: false }`, `retry: 0` and `testTimeout: 60_000`
  (`vitest.config.ts:141-150`); `@effect/sql-mysql2` sets `fileParallelism: false` and
  `sequence: { groupOrder: 1 }` — but only under Deno with integration tests on, with the committed
  reason "MySQL starts a fresh container per integration test suite, so avoid competing with the
  other container-backed projects on Deno CI runners" (`vitest.config.ts:163-179`).
- **Runtime gating instead of skipping**: `isBun`/`isDeno`/`isNode` and env flags
  (`EFFECT_INTEGRATION_TESTS`, `EFFECT_CLUSTER_TESTS`) exclude whole projects and the
  `*.integration.test.ts` glob from the default run (`vitest.config.ts:5-12,41-55`).
- **A `--shard 1/2` × `{Node, Deno}` CI matrix with `fail-fast: false`**, container images
  pre-pulled in parallel before install, and **`timeout-minutes: 10` on every single job** —
  lint, types, build, bundle, test, doctest, circular, all of them
  (`.github/workflows/check.yml:21,33,46,61,79,116,157,172,186,205`).
- **A bundle-size gate that is genuinely base-vs-head**: check out the base ref into `base/`, build
  both in parallel (`pnpm build & cd base && pnpm install && pnpm build & wait`), then
  `node ./packages/tools/bundle/src/bin.ts compare --base-dir base/packages/tools/bundle/fixtures`
  (`.github/workflows/check.yml:74-107`). This is the pattern worth copying — the shape, not the
  metric.
- **Two committed performance harnesses with real statistics.** `pnpm runtimeperf-compare` and
  `pnpm typeperf-compare` (`.repos/effect/package.json`) each create detached git worktrees for
  `--base` and `--head`, symlink `node_modules` in, and measure both
  (`packages/effect/runtimeperf/compare.mts:63-91`). The decision procedure is a **bootstrap
  confidence interval on the median log-ratio of paired observations**: 10,000 resamples, a fixed
  seed (`0x5eed1234`) for reproducibility, and a three-way verdict —
  `improvement` when the high ratio is below `1 - minImprovementPercent/100` (default 2%),
  `regression` when the low ratio exceeds `1 + maxRegressionPercent/100` (default 5%), otherwise
  **`inconclusive`** (`packages/effect/runtimeperf/stats.mts:61-131`). There is a
  `--fail-on-regression` flag (`compare.mts:42`).

Conspicuously absent:

- **No timing budget for the test suite.** No assertion anywhere on suite duration; the only limits
  are `timeout-minutes: 10` per job and `testTimeout` on individual container-backed suites.
- **No lint rule guarding test-suite speed.** `.oxlintrc.json` has nothing of the kind, and no test
  asserts on durations.
- **`runtimeperf` and `typeperf` are wired into no workflow whatsoever** — `grep -rn
  "runtimeperf\|typeperf" .github/` returns nothing. Effect built a rigorous, noise-robust regression
  detector with a `--fail-on-regression` flag and then left it as a manual, developer-invoked tool.
  Even the repo with the best machinery does not run it automatically.
- **The perf harnesses measure product code, not the test suite.** They benchmark Schema decode
  paths and type-checking time, not `vitest run`.

### Vitest itself (`vitest-dev/vitest`, `.github/workflows/ci.yml`)

Present: `timeout-minutes: 10` on lint and **30 on test**; a `changed` job using
`tj-actions/changed-files` whose `should_skip` output short-circuits the whole test matrix when only
docs/markdown changed; a matrix that splits by *suite* rather than by shard —
`suite: [unit, e2e, coverage]` — with a committed rationale: "Split the heavy e2e and coverage suites
onto their own runners so they run in parallel with the unit suite instead of sequentially on a
single machine"; `fail-fast: false`; a `changed`→`test` gate; and a `PNPM_CONFIG_TRUST_LOCKFILE: true`
env with a comment quantifying the saving ("~15-20s on every job") and one job overriding it to
verify the lockfile once per run. Absent: **no `--shard`** (the tool that documents sharding does not
shard its own suite), no perf job, no timing budget, no speed lint rule.

### Vite (`vitejs/vite`, `.github/workflows/ci.yml`)

Present: `timeout-minutes: 20` on the build-and-test matrix, `10` on lint; a `changed` job feeding
`test-passed`/`test-failed` aggregation jobs; the suite split into named steps (`Test unit`,
`Test serve`, `Test serve (bundled dev)`, `Test build`). Absent: no sharding, no perf job, no timing
budget, no speed lint rule.

### Biome (`biomejs/biome`)

Present: **a dedicated `benchmark.yml` workflow** — the most elaborate perf CI of any repo surveyed.
It is gated by `dorny/paths-filter` with 14 per-subsystem filter groups (js, json, yaml, css, html,
graphql, markdown, grit, tailwind, configuration, manifests, module_graph, service, console), each
mapping specific crate paths to a benchmark job, so a PR touching only the CSS formatter runs only
the CSS benchmarks; `workflow_dispatch` and `merge_group` force all groups on. Each job runs on
`depot-ubuntu-24.04-arm-16` (dedicated, 16-core) and invokes
`CodSpeedHQ/action@…v4.19.1` with `mode: simulation` and `cargo codspeed run`, with
`timeout-minutes: 20` on compile and `50` on the benchmark run, and `CARGO_BUILD_JOBS: 3` carrying
the comment "Default is 4 (equals to the vCPU count of the runner), which leads OOM on cargo build"
— an explicit, committed acknowledgement that matching job parallelism to vCPU count breaks things.
Absent, and this is the important part: **Biome benchmarks its product, not its test suite.** Its
`pull_request.yml` `Test` job runs a plain `cargo test --workspace --features=js_plugin` with
**`timeout-minutes` appearing zero times in the entire file** — no ceiling at all on its own test
suite. No sharding, no timing budget, no speed lint rule.

### Turborepo (`vercel/turborepo`)

Present: `timeout-minutes` on **every** job (15 for JS packages and validation, 25 for the Rust
matrix, with an additional `timeout-minutes: 20` on the test *step* inside it); a
`shard: [1, 2]` × 3-OS matrix for Rust tests; sharding delivered as a **passthrough arg**
(`turbo run test --filter=turborepo-crates … -- --partition hash:${{ matrix.shard }}/2`) with a
committed comment noting "The nextest invocation (and its excludes) lives in turbo.json"; and
`--affected --filter="./packages/*"` for the JS package tests, i.e. the changed-package selection
from §4 in production use. Absent: no perf CI job, no timing budget for the test suite, no speed lint
rule — and no acknowledgement in the workflows that the passthrough-arg sharding busts the cache
their own docs warn about.

**The pattern across all five:** every repo bounds test time with `timeout-minutes` and narrows *what
runs* (changed-files gates, path filters, `--affected`, per-suite matrices). Not one commits a timing
budget for its own test suite, and not one has a lint rule or test that guards test-suite speed. The
only rigorous regression statistics in the set (Effect's) are applied to product code and run
manually.

## 6. Carry-over from the auto-filing research

Everything in `docs/research/performance-feedback-loop-into-tracker.md` (2026-09-01) about the filing
loop applies to test-performance signals **unchanged**: fingerprint the regression's identity rather
than its measurements; make the detector a state machine that fires on the transition, not per
sample; derive dedup state from the tracker itself rather than a parallel store; cap filings per day;
and re-file with a cross-link instead of reopening. A "the engine test suite got slower" signal is
the same shape as a "the daemon got slower" signal, and needs no new guardrail vocabulary.

Two corrections to that document, both verified at this worktree's HEAD:

- **Its claim that "the engine cannot create issues today" is stale.** `createIssue` landed in commit
  `82129aff` ("Add issue creation contract", 2026-09-01). It is on the port
  (`packages/engine/src/issue-tracker.ts:132`), routed per workspace
  (`packages/engine/src/issue-tracker-router.ts:17-19`), and implemented on the GitHub client
  (`packages/engine/src/github/client.ts:540,707`).
- **Its "one unpaginated page of 100 open issues" constraint is also stale**, and this changes the
  conclusion drawn from it. Open-issue observation now paginates fully: `listIssues` calls
  `collectIssuePages`, which recurses `/issues?state=open&per_page=100&page=N` until a short page
  (`packages/engine/src/github/client.ts:638-656`, `pageSize = 100` at `:333`), all under a 5-minute
  deadline (`paginationDeadline`, `:332,341-347`). Pagination landed in commit `fd2b9b2e`
  ("Paginate GitHub open issue observation"). So auto-filed ticket noise is **no longer a correctness
  risk of the "real work is hidden from the engine" kind** — that specific failure mode is closed.
  What remains is a real but different cost: every extra open issue is another page fetched against
  the 5-minute pagination deadline on every one-minute poll, plus scheduler budget and human
  attention. Rate limits stay mandatory; the *reason* is now cost and clutter, not blindness.

Nothing else about the loop is re-researched here.

## Recommendation

**Adopt.**

1. **`timeout-minutes` on every job in `.github/workflows/pull-request.yml`.** It has none today.
   Effect puts 10 on all nine jobs; Vitest 30 on test; Turborepo 15–25 everywhere. This is the only
   mechanism universally present in the prior art, it costs one line per job, and it turns unbounded
   drift into a failure. Set it generously — the measured spread tops out near 56s, so a 10-minute
   ceiling cannot be tripped by noise, only by genuine drift or a hang.
2. **`--concurrency` on `turbo run test`.** The default is 10; the runner has 4 vCPU; eight packages
   each start their own Vite main thread. This is the single largest lever identified, it is one
   flag, it preserves per-package caching completely, and it directly addresses the measured 14s–56s
   spread. Vitest's own sharding docs supply the arithmetic (`(1 + workers) × shards = CPUs`).
3. **`turbo run test --affected` in CI.** Documented, and committed in Turborepo's own CI. Narrows
   the fleet on top of the existing Turborepo cache without touching Vitest config.
4. **A committed `test:compare` script on Effect's model, invoked manually, not in CI.** Measure the
   suite at `--base` and `--head` in git worktrees on the same machine minutes apart, N paired rounds,
   and decide with a bootstrap confidence interval on the median ratio with a fixed seed and an
   explicit `inconclusive` verdict — `.repos/effect/packages/effect/runtimeperf/stats.mts:61-131` is
   a working implementation to follow. Paired same-machine measurement is the only thing that
   survives a 4× ambient-load swing, and `inconclusive` is what stops a noisy gate becoming a gate
   everyone ignores. Do not put it on the PR path: Effect built exactly this and wired it into no
   workflow, which is evidence about cost, not about correctness.
5. **The two Biome test-hygiene rules that are recommended for the `test` domain and currently
   unset:** `noDuplicateTestHooks` and `noExportsInTest` (both default `error`), plus `noFocusedTests`
   (default `warn`) which guards against a focused test silently shrinking the suite. Free, already
   gated on the `vitest` dependency this repo has in every package, no plugin needed.

**Try and measure, do not assume.**

6. **`deps.optimizer.ssr.include` listing the Effect packages,** in `configs/test/base.ts`. It is
   the only documented mechanism that attacks the measured problem — "every file re-imports Effect" —
   at its root, by bundling those imports once, and it shares no mutable module state, so it cannot
   reproduce the `isolate: false` failure. Highest expected value of anything in §3.
7. **`experimental.fsModuleCache: true`, and `NODE_COMPILE_CACHE`.** Both free, both isolation-safe.
   The v4 guide's own caveat is that the gain shrinks for full suites because parallelisation already
   hides transform cost — so expect this to help local iteration much more than CI, and expect CI to
   need the cache persisted between runs.
8. **`pool: 'threads'`.** Isolation-neutral, one line. But `'forks'` is the v4 default specifically
   for robustness against hanging processes and segfaults, which is a live concern for a suite that
   spawns real `git` and real agent binaries. Revert on the first flake.

**Do not adopt.**

9. **A GritQL plugin that counts anything.** Measured impossible in Biome 2.5.11 (§1), and the
   failure mode is silent wrong counts, which is worse than no rule.
10. **CodSpeed CPU simulation.** Its own docs exclude system calls from the measurement; this suite is
    60–75% syscall wait. It would report a flat line while the suite doubled. Its plugin also only
    applies in `benchmark` mode, so it cannot see the 1640 existing tests.
11. **CodSpeed Walltime on Macro Runners.** Measures the right thing, but needs `bench()` wrappers
    around subprocess flows, warns against parallel benchmark processes, and bills metered minutes.
    Revisit only if a small named set of end-to-end flows becomes the thing worth guarding.
12. **`--shard` via Turborepo passthrough args.** Documented to bust the cache for *every* task
    (`turbo build -- --arg=value` misses cache on all tasks). If sharding is ever wanted, it has to
    come with a root `//#test` task, which trades away per-package caching deliberately rather than
    by accident.
13. **`fileParallelism: false` suite-wide.** It removes exactly the overlap that a 60–75%-idle suite
    depends on. Legitimate only per-project, for genuinely contended fixtures — which is precisely
    how Effect uses it.
14. **Datadog Test Optimization as a gate.** PR Gates has six rule types and none of them is duration;
    its own regression bar is 5× the mean; and its documented mitigation for Vitest overhead is
    disabling isolation. Reconsider only if per-test flake history is wanted for its own sake.

**Flagged as unverified.**

- Whether the coverage reporter under `--merge-reports` yields correct combined coverage across
  shards — the v4 coverage guide is silent on merging. Moot while there is no coverage gate.
- Whether `@codspeed/vitest-plugin@5.7.1`'s `vite: "^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0"` peer range
  is enforced or merely warned about against this repo's resolved `vite@8.2.2`. Only matters if
  recommendation 11 is ever revisited.
- The actual magnitude of every §3 speed-up. None was measured here. Each must be validated with the
  paired method in recommendation 4 before being called an improvement — the same standard the 14s–56s
  spread imposes on any other performance claim in this repo.

## Bottom line

The machinery that catches this is not a lint rule and not an instruction-counting service. Counting
is measurably not expressible in Biome's GritQL, and CodSpeed's default instrument excludes by
design the syscall wait that *is* this suite's cost. What is available is three things at three
different price points: `timeout-minutes` as a free hard ceiling that every surveyed repo commits and
this one does not; `--concurrency` plus `--affected` on `turbo run test` as the structural fix for
eight Vitest schedulers contending over 4 vCPU, keeping the per-package cache fully intact; and a
paired base-vs-head comparison with a bootstrap confidence interval and an explicit `inconclusive`
verdict — Effect's committed method, which is the only surveyed approach whose robustness comes from
statistics rather than from special hardware. The prior art is unanimous on the negative result too:
no repo surveyed commits a timing budget for its own test suite, and the one repo that built a
rigorous regression detector with a `--fail-on-regression` flag runs it by hand. Bound the resource,
narrow what runs, and keep the statistically honest comparison as a tool rather than a gate.
