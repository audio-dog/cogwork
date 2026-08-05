# Feldspar Engineering Rigor Roadmap

Status: draft v2 — updated 2026-07-27 after a full codebase audit, a comparison against
pingdotgg/t3code (a modern Effect-native Electron AI app), and the alpha cost review.

## Goal

Make correctness the easiest path for engineers and coding agents: strict types, executable
boundaries, reproducible verification, safe persistence, focused modules, and measurable AI
quality **and cost**. Patterns only govern if they are copyable (an exemplar to imitate),
checked (a machine gate that rejects deviation), and small (an interface an agent can hold in
context). Every change below serves those three properties.

## Where we are

### Strengths to protect

- The domain design is right: a staged context pipeline (Ingest → Identity → Synthesis →
  Prioritize → Generate) with correlation ids and a persisted decision trace (`pipeline_events`).
- The frozen-corpus LLM-judge eval harness (`/evals-run`) — ahead of comparable apps; it is the
  only mechanism that can prove "cost down, quality held."
- Safety architecture: approve-then-execute cards gate external writes; proper process isolation
  (contextBridge, no node integration); native code behind one TS seam.
- Working seams: `ExternalContextProvider` has multiple adapters; jobs accept structural `*Store`
  dependencies that tests fake; LLM jobs share one shape (client factory, timeout, strict JSON).
- Testing culture exists (259 test files). Coverage is missing at seams, not in willingness.

This is not a rewrite candidate. The domain layer stays; the skeleton around it is what's missing.

### Four root causes (what the ~40 audit findings reduce to)

1. **Contracts live in prose, not code.** `ProposedActionRecord` is declared three times
   (main/preload/dashboard) and has drifted (`worthScore`, `snoozedUntil` missing from preload);
   ~93 IPC handlers accept `input as X` casts; CLAUDE.md documented a pipeline deleted months ago
   and no check failed. Agents pattern-match what they read, and what they read is wrong.
2. **Composition and domain behavior are fused.** Layers exist (ipc → service → repository) but
   modules don't. Behavior accretes where wiring is: `oauthMcpServerService.ts` (7,768 lines, 234
   changes/3mo) holds OAuth + pipeline orchestration + card execution; `ExternalContextDatabase`
   is a 291-method facade. "Append to the biggest file" is the locally easiest move for humans
   and agents alike.
3. **State moves by polling, not events.** The renderer runs an 18-call IPC fan-out every 2s;
   execute has no claim transition (double-approve = double-send); manual sync bypasses the
   scheduler's single-flight; tests sleep instead of awaiting completion.
4. **The environment doesn't push back.** Strict mode off, no CI, no typecheck script, EOL
   linter, hoisted phantom deps. Every convention is advisory, and advisory conventions rot.

### The cost mandate

~$20k/month LLM spend on <10 alpha users. The PM's product areas map onto this roadmap as:
data ingest (#1, reviewed), context generation (#2) and agentic actions (#3) — the Phase 6
module extractions — and UI (#4, Phase 3). Cost instrumentation exists (`src/main/llmUsage/` +
a global fetch interceptor in `apiCallLogger.ts`, published-rate pricing, sqlite + Mixpanel
sinks) but attribution is opt-in (`x-feldspar-caller` header per call site; `synthesisId` only
on harness paths), the ledger is disjoint from `pipeline_events`, and no report/budget reads it.
Capture exists; accountability doesn't. Whether architecture (re-processing unchanged content)
or model economics dominates the bill is currently unknowable — making it knowable is Phase 0.

## Target architecture: four pillars

1. **Contract spine.** One schema-first contracts layer is the only way data crosses process,
   persistence, and LLM seams. Types are inferred from schemas, never written twice; the preload
   bridge derives from contracts; handlers decode at the seam; each operation declares its typed
   error union. (t3code: schema-only `packages/contracts` with a test beside every contract.)
2. **Domain modules behind a thin composition root.** The root only wires. Deep modules drawn
   around existing domain concepts: `SourceConnections`, `ContextDepthPipeline`,
   `ProposedActionLifecycle`, `AgentChatHost`, `HomeFeed`; renderer feature modules (home, chat,
   timeline, settings, meetings). A module is a folder: contract + implementation + tests +
   colocated types. Agents load one folder, not 7,768 lines.
3. **Event/receipt spine.** The main process emits typed completion receipts (sync finished,
   card drafted, action executed). The renderer becomes TanStack Query invalidated by receipts;
   tests await receipts; single-flight and claim-then-execute live at module interfaces.
   (t3code: `RuntimeReceiptBus` + queue-backed drainable workers.)
4. **Enforcement layer.** CI gate, TS7 strict ratchet, and lint as a policy engine: custom rules
   encoding Feldspar invariants with counted baselines so legacy code ratchets down instead of
   blocking. Agent guidance shrinks to a small operational file pointing at code — exemplar
   modules, contracts, skills — because prose that restates code is prose that rots.

Growth falls out: a new connector is a new adapter; a new action capability is a tool-inventory
entry, not enum surgery; a new surface (menu bar, CLI, web) is a new client of the contract spine.

## Stack decisions

### Adopt

- TypeScript 7 native compiler. (Validated: t3code runs tsgo/native-preview in production CI.)
- Formatter + type-aware linter with **custom-rule support as a hard requirement** — the policy
  engine matters more than the brand. Evaluate Biome vs oxlint-with-JS-plugins (t3code ships 4
  custom oxlint rules + ~30 language-service diagnostics as errors); pick whichever carries
  custom Feldspar rules best. Native TypeScript checking remains authoritative.
- Valibot for application-owned runtime schemas (the contract spine).
- Drizzle ORM, Drizzle Kit, Drizzle Studio, and `node:sqlite`.
- TanStack Router with hash history.
- TanStack Query for IPC-backed server state, invalidated by receipts (not polling).
- Tailwind CSS 4 through `@tailwindcss/vite`.
- pnpm catalogs + `engines` pin + explicit build allowlists + minimum-release-age for new
  versions (t3code's supply-chain config, all config no code).

### Retain

- Electron Forge.
- Separate Vite build targets for main, preload, renderer, overlay, and worker.
- The Rust `napi-rs` bridge for macOS capabilities; audit replaceable capture/OCR paths separately.
- Repository boundaries during the Drizzle migration; the job-level structural `*Store` seam is
  the real test seam (two adapters) — do not invent in-memory repositories.
- **The eval harness and `pipeline_events` trace** — they are the quality-and-cost regression
  mechanism everything else leans on.

### Defer (explicitly, with a decision mechanism)

- **Effect: deferred, not rejected.** It is one coherent implementation of pillars 1–3 (Schema =
  contracts, Service/Layer = modules, streams/tagged errors/Scope = event spine) with an
  off-the-shelf enforcement kit — and t3code proves agents write it well when given vendored
  reference source + lint. We are not ready to adopt it while the module skeleton is still being
  drawn. Decision mechanism: build the first Phase 6 extraction (`ProposedActionLifecycle`)
  **designed twice** — plain-TS-with-discipline vs Effect service — against the same
  characterization tests and eval scenarios; compare locality, testability, and agent-legibility
  (hand both to a fresh agent with a task); record the verdict as an ADR and stamp the winner as
  the pattern for remaining extractions. Until then: no `effect` imports in production code.
- Regardless of that verdict, adopt the enablement pattern now: an exemplars/vendored-reference
  area agents are pointed at, and lint rules that police the house idiom.

### Avoid

- TanStack Start in the desktop renderer (its server-function transport assumes a server;
  Feldspar's privileged backend is Electron IPC).
- Big-bang folder rewrites or simultaneous persistence and domain refactors.
- Retrofitting existing code to any new idiom — new idioms apply to extracted modules only.

## Delivery principles

- Small, independently reviewable PRs.
- Characterization tests before structural changes; the eval harness before any prompt/model/cost
  change.
- No new suppressions, unsafe casts, unvalidated process inputs, or global `types.ts` files.
- Co-locate schemas and inferred types with their domain.
- Counted-baseline ratchets: legacy violations are counted and may only decrease; new code is
  held to zero.
- Every phase adds a machine-enforced invariant.
- Agents run focused verification locally (smallest relevant test set); CI owns the full suite.
- Docs that can't drift: generated or code-adjacent references over prose restatements.

## Phase 0: Cost ledger and urgent safety

The business case and the safety floor. Ships before or alongside Phase 1.

### Cost accountability

- Make LLM-call attribution total: every call site sets caller + `synthesisId`/todo/action ids;
  enforce with a lint rule (no unattributed OpenAI/Anthropic calls).
- Join `llm_usage` to `pipeline_events` on `synthesisId` so cost per stage per pass per document
  is queryable.
- One local report: dollars per stage / per user / per day, plus the top-10 most expensive call
  sites. Read from sqlite; no external tooling required.
- Then cut what the data indicts (expected mix: model right-sizing, content-hash gating so
  unchanged documents skip paid stages, prompt slimming, prompt caching, batching non-urgent
  stages) — every cut validated by an eval run.
- Unblock `add-resynthesis-eval-mode` (OpenSpec change, currently unstarted): synthesis is the
  expensive stage and is currently unevaluable, which blocks safe cost work there.

### Urgent safety (from the audit; independent of architecture)

- Confine the agent harness working directory away from the userData root (today `Read`/`Grep`/
  `Glob` can reach `settings.json` tokens and `credential-key.json`).
- Validate `scribehow:` protocol URLs before persisting `backendUrl`/`frontendUrl` (host
  allowlist); today any local page can steer token refresh.
- Claim-then-execute for proposed actions: atomic `ready → executing` transition so
  double-approve cannot double-send; idempotent re-entry.
- Enforce the protocol allowlist for `shell:open-external` in main (renderer-only today).
- Revisit the "calendar writes live in the draft/chat toolset" decision; the code comment calls
  it deliberate, the chat prompt claims no write tools exist. Whatever the outcome, record an ADR
  and make prompts match capabilities (test-asserted).
- Rewrite CLAUDE.md to the live pipeline (todo-prioritization → harness drafter); the current
  text documents deleted files (`proactiveActionDetectionJob`, assessor, threshold knobs).

Exit criteria:

- The team can answer "which stage spends what, per user, per day" from one report.
- The four security items above are closed; the calendar decision is recorded.
- Agent guidance names only files that exist.

## Phase 1: Reproducible verification

- Pin Node and pnpm (align README/setup with Electron 42's `>=22.12` engine); fix workspace pnpm
  configuration.
- Remove `node-linker=hoisted`; use the isolated linker; declare every direct dependency.
- Make clean checkout installation reliable.
- Add scripts: `format`, `format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`,
  `test:watch`, `native:check`, `verify:fast`, `verify`.
- Add PR CI: frozen install, formatting, lint, typecheck, deterministic tests, Rust
  fmt/clippy/test, OpenSpec validation. Hard 10-minute job timeouts. PR size labels.
- Add a packaged-output smoke: grep the built preload bundle for expected bridge symbols
  (catches the "Cannot find module on launch" class in seconds — t3code pattern).
- Keep signing, packaging, and live LLM evaluations in separate macOS or scheduled jobs.
- Same aggregate verification command locally and in CI; stop `prestart` from rebuilding
  Rust + worker unconditionally (conditional or explicit).
- Dependency hygiene: drop unused prod deps (`zustand`, LaunchDarkly client until a consumer
  exists); patch reachable audit highs (`tar` via sqlite3, `sharp`, `linkify-it`); treat ESLint 8
  as freeze-only until Phase 2 replaces it.

Exit criteria: unchanged from v1 (clean checkout runs `verify:fast`; PRs cannot merge with
deterministic failures; CI reproducible locally).

## Phase 2: Modern TypeScript and static analysis

- Upgrade directly to TypeScript 7; split tsconfig by runtime; ratchet to full strict
  (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, unknown catch, override
  and switch safety) with counted baselines.
- Stand up the lint policy engine. Beyond stock rules (floating promises, cycles,
  process-boundary mistakes), write Feldspar rules:
  - no `ipcMain.handle` outside the validated contract adapter
  - no unattributed LLM API calls (Phase 0's rule lives here permanently)
  - no `Date.now`/`Math.random` in pipeline code (inject a clock)
  - no `setInterval` polling in the renderer
  - no imports of another domain's internals; no imports from the global types barrel
  - no `new OpenAI`/SDK construction outside the client factory
- Inventory ESLint behavior, establish parity, remove ESLint and plugins.
- Reject new `@ts-ignore`, unscoped disables, unexplained `any`.

Exit criteria: v1's, plus the custom rule set runs in CI with baselines only decreasing.

## Phase 3: Renderer platform

- Tailwind 4 via the Vite plugin; drop PostCSS/Autoprefixer (unchanged from v1).
- TanStack Router with hash history; panels/screens/deep links as typed routes with Valibot
  search schemas (unchanged from v1).
- **Feature modules own their state** (home feed, agent chat, timeline, settings, meetings):
  each owns its query hooks, invalidation, and UI. The app shell is auth gate + layout. This is
  the renderer half of Pillar 2 — `entry.tsx` stops owning 25 state bags and drilling ~80 props
  into `MeetingsDashboard`.
- Replace the 2-second 18-call poll with receipt-driven invalidation (Pillar 3): main emits
  typed events; features invalidate their own queries. While extracting: push limits into SQL
  (history/feed queries currently `selectAll()` then slice in JS), stop shipping README bodies
  and toolCalls JSON on list reads, add the missing status/dismissed indexes.
- Local component state stays local; Zustand only if genuinely shared client state appears.

Exit criteria: v1's, plus no periodic full-dashboard refresh and no unbounded list query on a
poll path.

## Phase 4: Executable process contracts (the contract spine)

- One contract module per domain: Valibot schema + channel + validated `ipcMain.handle` adapter
  + typed renderer client, defined once. Adding an operation = editing one file (today: 6–8
  lockstep edit sites across three type worlds).
- Each operation declares a typed error union, not just a normalized error shape.
- Every contract file has a colocated test (t3code pattern); contract tests exercise
  renderer → preload → main success and failure paths.
- Generate or assemble the preload API from contracts; delete the hand-maintained preload type
  copies (this is what kills the `worthScore` drift class).
- Validate high-risk mutations first: proposed-action execution, agent chat send, timeline
  correction, OAuth/source mutation, write-tool execution.
- Extend the spine beyond IPC: persisted JSON payloads, configuration, and application-owned LLM
  outputs validate through the same layer. `settings.json` gets a schema on load (fail closed to
  defaults with a backup).
- Dissolve `external-context/types.ts` (3,408 lines, ~283 exports, ~200 importers) into domain
  modules + contracts as domains adopt the spine; forbid new barrel exports immediately.
- Remove application-owned Zod incrementally; retain only where a third-party SDK requires it.

Exit criteria: no privileged IPC handler trusts cast input; main and renderer share one contract
definition per operation; the types barrel is shrinking under a counted baseline.

## Phase 5: Drizzle and `node:sqlite`

Unchanged from v1 (schema source of truth, inferred types, reviewed migrations, historical
fixtures, driver benchmark with main-thread stall budget, query patterns), plus:

- Multi-release migration fixtures: check in 2–3 real historical database snapshots and assert
  the full upgrade chain (compound migrations are only piecewise-tested today).
- Align persistence interfaces with the job-store seam: introduce per-domain store interfaces
  matching the structural `*Store` types jobs already fake; implement with repositories; shrink
  the 291-method `ExternalContextDatabase` facade behind them during the migration, not before.

## Phase 6: Domain modules and the event spine

The heart of the program, and the PM's "eng review of context generation and agentic actions" —
the review artifact is the seam.

- Extraction order (characterization tests precede each; compatibility facade preserved until
  callers migrate):
  1. `ProposedActionLifecycle` — draft/execute/dismiss/snooze/staleness/settlement. The
     claim-then-execute fix and write-tool contracts live at this interface. **This extraction
     is the Effect design-it-twice spike** (see Stack decisions → Defer).
  2. `ContextDepthPipeline` — stage binding, cold-start gates, single-flight at the interface
     (closes the manual-sync bypass), `synthesisId` correlation, per-stage cost/idempotency
     hooks (content-hash gating lands here).
  3. `SourceConnections` — OAuth flows, token exchange, credential protection,
     `withAccessToken`. Protocol-URL validation (Phase 0) hardens into this interface; the
     safeStorage-bypass decision (`preferLocalFallback`) gets revisited and recorded here.
  4. `AgentChatHost` and `HomeFeed` (the ~150 real lines inside the `ExternalContextService`
     pass-through; delete the other 58 forwarding methods after).
- Split `mcpRemoteDocumentProvider` (6,109 lines) into per-connector adapters (Granola, Notion,
  Slack-archive) over one deep MCP transport; the watermark-completeness contract ("advance only
  on complete drains" — Slack does this, Notion/Granola don't) becomes part of the provider
  interface.
- Build the receipt bus: typed completion events for sync/draft/execute/settlement milestones;
  queue-backed workers with a `drain()` tests can await. Renderer invalidation (Phase 3) and
  test synchronization both consume it.
- Import-boundary rules between renderer, preload, main, contracts, persistence, and native
  (Phase 2's lint engine enforces).
- Each extracted module becomes the stamped exemplar the next extraction copies.

Exit criteria: composition roots wire, not implement; the five modules exist with their own
contracts and tests; forbidden cross-domain imports fail CI; no polling in tests for pipeline
completion.

## Phase 7: Native capability audit and rigor

Unchanged from v1 (map exports to call sites, replace where Electron/Node suffices, consume
generated `napi-rs` declarations, gate Cargo fmt/clippy/test, packaged smoke for addon loading).

## Phase 8: Tests, AI feedback loops, and cost governance

- Deterministic unit, integration, migration, IPC contract, and packaging tests mandatory.
- Cover the boundary surface by risk: IPC handlers (87, currently zero tests), preload bridge,
  auth service, capture orchestration.
- Live MCP/LLM evals nightly or on labeled PRs, compared against versioned baselines with
  **quality, latency, and cost budgets** — the ledger from Phase 0 feeds per-scenario cost.
- Prompt, model, detection, synthesis, or drafter changes must name affected scenarios and
  report eval deltas (quality and cost).
- Turn pipeline traces and user feedback into regression scenarios; confirm stochastic
  regressions across repeated runs before blocking.
- Agent policy: focused verification locally (`verify:fast` scoped to the change), CI owns the
  full suite; integrated verification skills for user-visible changes.
- Maintain the exemplars area (vendored reference code + stamped module exemplars) agents are
  pointed at before writing.

Exit criteria: deterministic regressions block immediately; AI behavior changes produce
reviewable quality/cost evidence; the burn rate is explainable per stage and trending down
without eval regressions.

## Phase 9: Documentation and governance

- Concise `ARCHITECTURE.md` (pillars + module map) and `CONTRIBUTING.md`.
- An encyclopedia/glossary naming domain terms (signal, synthesis, dossier, todo arc, card,
  receipt, stage) — the single best agent-onboarding artifact in the reference repo.
- ADRs for: Electron IPC over server functions; TS7 + lint policy engine; Valibot boundary
  schemas; Drizzle + `node:sqlite`; TanStack Router hash history; AI evaluation and cost policy;
  **Effect deferral and its decision mechanism**; calendar-writes-in-draft outcome; credential
  protection (safeStorage vs local key).
- Keep agent guidance operational and short, pointing at contracts, exemplars, and skills;
  machine checks remain authoritative. Add a staleness check where feasible (guidance that names
  files which no longer exist should fail something).

## Priority

### P0

- Phase 0 entire: cost ledger + attribution rule, top-10 report, urgent security items,
  CLAUDE.md truth rewrite.
- Reproducible installation and PR CI.
- TS7 strictness ratchet start.
- Contract spine over the five high-risk mutations.

### P1

- `ProposedActionLifecycle` extraction (with the Effect design-it-twice verdict) and
  `ContextDepthPipeline` extraction with cost/idempotency hooks.
- Receipt bus; renderer feature modules + TanStack Query; kill the 2s poll.
- Lint policy engine with Feldspar custom rules and counted baselines.
- Tailwind 4; TanStack Router.
- `add-resynthesis-eval-mode` + eval cost budgets.

### P2

- Remaining extractions (`SourceConnections`, `AgentChatHost`/`HomeFeed` facade deletion);
  connector adapter split.
- Drizzle schema/migration spike, historical fixtures, then full `node:sqlite` cutover with
  domain stores.
- Native declaration and packaging rigor.
- Dependency/cycle/dead-code analysis; encyclopedia + ADR backfill.

## Immediate backlog

- [ ] Total LLM-call attribution + `llm_usage` ↔ `pipeline_events` join + cost report.
- [ ] Close the four urgent security items; record the calendar-writes ADR.
- [ ] Rewrite CLAUDE.md to the live pipeline.
- [ ] Establish reproducible local and CI verification commands (incl. preload-bundle smoke).
- [ ] Replace the hoisted install with the isolated linker; prune dead deps; patch audit highs.
- [ ] Upgrade to TS7 with ratcheted strict configs and counted baselines.
- [ ] Stand up the lint policy engine (formatter + custom Feldspar rules); retire ESLint.
- [ ] Contract spine for the five high-risk mutations; begin dissolving `types.ts`.
- [ ] Characterization tests, then extract `ProposedActionLifecycle` — designed twice
      (plain TS vs Effect); record the ADR verdict.
- [ ] Extract `ContextDepthPipeline` with single-flight + content-hash gating at the interface.
- [ ] Receipt bus + renderer feature modules on TanStack Query; remove the 2s poll.
- [ ] Ship `add-resynthesis-eval-mode`; add cost budgets to the eval harness.
- [ ] Tailwind 4 via Vite plugin; TanStack Router with hash history.
- [ ] Spike Drizzle + `node:sqlite` against historical database fixtures.
- [ ] Codify architecture docs: pillars, module map, encyclopedia, ADRs.
