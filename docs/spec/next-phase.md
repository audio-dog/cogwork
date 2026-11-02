# Next phase: mission control, first-party runtime, proactive assistant

> **Superseded snapshot.** This is a point-in-time handoff from wayfinder map
> [#159](https://github.com/taylorfsteele/cogwork/issues/159), closed 2026-08. Its phase numbering
> and roadmap slices describe work that has since shipped or moved, and are **not** maintained.
> For what the product is and where it is going, read
> [`docs/agents/product.md`](../agents/product.md). For what is built, read the issue tracker or
> the code. What stays useful here is the **Decision log** at the foot of this file — the index
> from an area to the ticket or ADR that holds its full reasoning.

The product and architecture spec for cogwork's next phase, with a sequenced roadmap. Every
decision here was settled on the wayfinder map
[#159](https://github.com/taylorfsteele/cogwork/issues/159) between 2026-07 and 2026-08; each
section links the ticket or ADR that holds the full reasoning. This document is the index and the
handoff — the tickets are the depth.

## What cogwork is becoming

**cogwork is a productivity assistant for a software engineer. Coding orchestration is its
first capability, not its definition.** ([#168](https://github.com/taylorfsteele/cogwork/issues/168))

The `triage → implement → follow-up → PR` pipeline that exists today is one **workflow**, keyed by a
work-item type, running over a shared runtime (scheduler, run ledger, event bus). Future non-coding
workflows — a Slack reply, meeting prep — are peers over that same runtime, not more stages in one
pipeline. The general loop underneath every workflow is **sense → classify → schedule → act →
record**; issue-tracker-plus-coding-harness is its first instance.

The north star (a capstone, not the exit criterion): a meeting mentions a bug, cogwork mints
the ticket, triages it, implements it, and opens the PR. cogwork builds cogwork.

Three phases get there:

1. **Mission control** — a desktop app over the existing AFK daemon: watch the fleet, act on the few
   decisions the pipeline can't self-resolve.
2. **First-party runtime** — cogwork owns the model loop (bring-your-own-provider) behind the
   existing `HarnessRunner` seam; external CLI harnesses remain pluggable.
3. **Proactive layer** — ingestion of real-world context (meetings first) that turns into proposed
   work items feeding the same pipeline.

**Audience for all three: the maintainer, dogfooding.** Casual non-coders come later.

### Standing constraints

- **Architect hosted-ready, build local-first.** No single-user or single-machine assumption in any
  seam that is expensive to reopen; build no hosting, auth systems, or tenancy.
  (technical-disposition *take the shape that survives the turn you can see coming*)
- **Autonomous-with-override, never approval-gated.** Agents run unattended end-to-end; triage
  *self-halts* with its reasoning when work isn't AFK-able; the one hard human gate is PR review +
  merge. New surfaces inform and offer override — they do not block agents behind approvals.
  (ADR 0007, technical-disposition *self-halt over gates*)
- **Utility model calls go through the owned provider layer, never a CLI harness.** Harnesses exist
  solely to run coding sessions. (engine ADR 0006, principle 9)
- **Session contracts are interactive-ready** even though everything in this phase is AFK-only.
  Interactive sessions (chat, steer/queue, mid-run approvals) are explicitly sequenced after phases
  1–2.

## Product spec

### Phase 1 — Mission control

The maintainer's daily driver over the AFK daemon. Ambient confidence that everything is moving,
plus the ability to act in place on the few decisions that land on a human.
([#160](https://github.com/taylorfsteele/cogwork/issues/160) spec,
[#167](https://github.com/taylorfsteele/cogwork/issues/167) prototype)

**Shell layout** (settled by the [prototype](https://github.com/taylorfsteele/clanker-forge/blob/dc38a35306d750b75fd4345cca95769885ae40c4/prototypes/mission-control-v1.html)):
a Slack/Codex-style three-band desktop window.

- **Left nav rail** — views (Feed / Board / Inbox / Lanes) and a per-workspace filter.
- **Center: the Feed (home)** — activity-first. Running agents are the hero, as live cards with a
  "watch this agent" affordance; then Queued; then Recently done. (The lifecycle **Board** — kanban
  across `Needs triage → Ready for agent → Working → In review → Needs you → Blocked` — was
  explored as the home in #160 and demoted to a view by the prototype.)
- **Right rail (collapsible)** — the single contextual surface. Defaults to **Attention**: triage
  self-halts with the agent's question inline, and PRs waiting at the merge gate. Clicking an item
  swaps the rail to that item's detail: live-run drill-in, triage approval, or PR gate. **Lanes** is
  the rail-collapsed wide multi-repo overview. `blocked` is badge-only.

**The live run drill-in** is the "watch the agents work" promise: streamed text, reasoning, tool
calls with args and results, file diffs, per-run status and usage. It requires the widened harness
event (see architecture).

**PR state** rides on each item — checks, review status, mergeable/base-diverged, wait time — read
from the source-control provider. Actual diff review and merge stay on GitHub, deep-linked; the PR
read model is shaped richly enough to host an in-app review panel later.

**Actions.** The daemon grows exactly three mutating RPCs (it has zero today):

1. **Cancel-and-park** — stop an in-flight run and park the item `ready-for-human` so the scheduler
   doesn't restart it.
2. **Reclassify / respond** — set an item's triage role and/or post a comment (drives the existing
   `setRoles` / `note` adapter methods). This powers answering self-halts and overriding decisions
   *in place* — the single biggest driver of daily pull.
3. **Pause / resume scheduling** — global; drain semantics minus process exit. Surfaced next to the
   scheduler gauges (in-flight/limit, daily budget, per-workspace load — all already in
   `DaemonStatus`).

**Deferred from v1:** in-app kick-off (issues stay minted by the authoring skills), in-app PR
review/merge, live numeric dial editing (waits for settings-as-data), nudge/steer (interactive
phase).

### Phase 2 — First-party runtime

cogwork owns the model loop: a TanStack AI runner registered behind the existing
`HarnessRunner` seam, beside the CLI harnesses (cursor-acp), not replacing them. (engine ADR 0006;
capability audit [#164](https://github.com/taylorfsteele/cogwork/issues/164))

**Bring-your-own-provider.** API keys for every provider, plus OpenRouter OAuth (the only
third-party OAuth a provider sanctions). ChatGPT-subscription login works but is
unauthorized-in-writing — a flagged fast-follow, not v1. Anthropic prohibits and enforces against
subscription-OAuth reuse. The model picker reads the models.dev `api.json` catalog.
([#163](https://github.com/taylorfsteele/cogwork/issues/163))

**The AFK keystone: no live ask.** The full allow/ask/deny policy vocabulary is authored now, but
while AFK, `ask` compiles to `deny`. A denied tool call is a tool result the model adapts to — it
never parks the item and adds no approval RPC. All approval UX and the interrupts machinery wait
for the interactive phase. ([#166](https://github.com/taylorfsteele/cogwork/issues/166))

**Dogfood cutover is the phase-2 exit:** cogwork's own triage/implement/follow-up stages run
on the first-party runner by default, with cursor-acp still registered.

### Phase 3 — Proactive layer

One new job: turn real-world context into a **proposed action**. In phase 3 there is exactly one
kind — **mint a work item** — and the existing pipeline carries it the rest of the way.
([#168](https://github.com/taylorfsteele/cogwork/issues/168))

- **First context source: Granola meeting transcripts.** Slack and calendar come later.
- **Extraction is agentic**, through the owned runtime (never a harness): separate actionable items
  from chatter, attribute each to a recognized `workspace`. It never mints into a project it
  doesn't recognize — unknown work surfaces as a question.
- **Mint gate: hybrid by confidence, tuned approval-first.** High-confidence → auto-mint into
  `needs-triage`; medium → go/no-go; unrecognized → question; chatter → withheld. Start with the
  auto-mint bar very high and loosen as extraction earns trust. The go/no-go governs *admission of
  new work*, not a running agent, so the autonomous-with-override principle holds.
- **Dedup is engine-driven**: a per-source watermark plus minted-keys gate the expensive model call.
  No agent is ever asked whether a meeting was already handled.
- **Surfacing** (direction only; UI goes through a prototype like #167): one surface holding
  go/no-gos, questions, and auto-mint awareness, grouped by meeting. Requires a
  pending-proposed-actions read model and one approve/dismiss RPC — the phase-3 addition beyond
  phase 1's three commands.

### Explicitly later (in scope for the product, out of scope for this effort)

- **Interactive sessions** — chat surface, steer/queue, mid-run approvals. Contracts are shaped for
  it throughout; the machinery and UX come after phases 1–2.
- **Phase 4+ non-coding workflows** — new proposed-action kinds (Slack reply, meeting prep, drafts),
  their actuators, and the owned coordination store they require.
- **Knowledge layer** ("what it knows about you") — opencode's System Context is the reference
  shape; phase-3 meeting ingestion is its seed.
- **Settings-as-data migration**, in-app PR review panel, casual-user onboarding, hosted/multi-user,
  selling a first-party AI provider.

## Architecture spec

### Contracts and transport ([#161](https://github.com/taylorfsteele/cogwork/issues/161))

- **Transport stays Effect RPC over a Unix socket with NDJSON.** Effect RPC makes the protocol one
  swappable layer; WebSocket/HTTP+SSE and TLS are a later layer swap with no contract change. The
  socket moves to `~/.cogwork` at `0600`.
- **CQS split.** `packages/contracts` RPCs divide into `DaemonQueries` (read) and `DaemonCommands`
  (state/behavior-changing); the auth seam guards commands more strictly.
- **Commands** are unary and return the updated classified work-item read model — the same shape the
  `ItemChanged` event carries, so client and stream stay consistent:

  | Command | Payload | Typed errors |
  |---|---|---|
  | `CancelRun` | `{ runId, note? }` | `RunNotFound`, `RunAlreadyFinished` |
  | `Reclassify` | `{ workspace, workItem, role, note? }` | `WorkItemNotFound`; tracker failures reuse `IssueTrackerError` |
  | `SetScheduling` | `{ desired: "paused" \| "running" }` | none — idempotent |

  Typed errors are `Schema.TaggedErrorClass` in contracts, unioned per RPC; unexpected exceptions
  stay defects (generic message out, detail logged).
- **Two subscription streams, one-per-client** (the client fans out its own views, buffers bounded):
  `WatchEvents` carries the new `DaemonEvent` union
  (`RunActivity | ItemChanged | RunChanged | SchedulerChanged`) and moves the board off polling;
  `WatchActivity(runId)` stays for the run drill-in (ledger replay, then live).
- **Auth placeholder:** one `RpcMiddleware` puts a `Principal` (fixed local owner today) into
  handler context; a token rides as a request header, transport-agnostic. No handler may assume
  "there is no caller." Read models already key by `WorkspaceId`, so per-user scope is a later
  handler filter, not a reshape.

### Desktop shell and UI client (ADR 0008, ADR 0009; [#162](https://github.com/taylorfsteele/cogwork/issues/162))

- **Electron**, built with electron-vite + electron-builder (updates via electron-updater / GitHub
  channels). No Tauri, no browser-tab-first (browsers can't open the Unix socket), no Rust in
  phase 1.
- **Desktop is the primary daemon host on a laptop.** The engine runs as a bundled Node child
  supervised by Electron (RunAsNode fuse stays off); the same engine entry serves headless
  `daemon` for CI/SSH; the CLI becomes a thin client plus headless launcher.
- **Cursor-shaped window behavior:** single instance, close-to-hide (engine keeps running), dock +
  tray with Quit stopping the engine.
- **UI stack:** React, TanStack Router (no Start — the daemon is the backend), **Effect AtomRpc +
  `@effect/atom-react`** for server state (stream RPCs as pull atoms; TanStack Query only as an
  escape hatch), zustand for local chrome, shadcn + Tailwind v4 in `packages/ui` (primitives/tokens
  only; features live in `apps/desktop`), TanStack Markdown + Highlight, electron-window-state +
  electron-log. The renderer never opens the socket — Effect RPC lives in main behind a typed
  main↔renderer IPC seam.

### Session model ([#165](https://github.com/taylorfsteele/cogwork/issues/165))

The owned runtime **formalizes existing structure** — the scheduler already serializes per
work-item, so no interactive coordinator is needed for AFK.

- **Session is first-class**: our `SessionId`, engine-minted at insert; `RunRecord.session` becomes
  a real FK. A Session has many **Runs** (a Run = one prompt's execution to terminal — opencode's
  "drain", a term we avoid because the scheduler already uses it). No other new vocabulary.
- **Sum type:** owned-transcript sessions for the first-party runner; opaque-handle sessions for CLI
  harnesses, which keep their own history (ADR 0006's deliberately unequal paths).
- **One truth:** the event-sourced run ledger stays authoritative; the transcript is a projection
  folded from a Session's events. `SessionStore` mirrors `@tanstack/ai-persistence`'s contract
  (`loadThread` = ledger fold); adopt `withPersistence` + its `interrupts` store only once the
  runner's loop exists (it's `chat()` middleware — unwireable before then; re-verify the version
  pin at build).
- **History delivery is in-process pull**: a `HarnessRequest` carries a `SessionId`, never a
  transcript. Context grows inside the loop, so compaction must live there — a frozen pushed
  transcript structurally can't. A `SessionId` is also the network-friendly thing that crosses any
  future wire.
- **Event contract widens whole, not curated:** the full AG-UI event serialized inside a stable
  envelope (runId / seq / atMillis / correlation ids). The first-party runner emits it natively;
  cursor-acp maps best-effort; the ledger fold keeps reading only the fields it needs.
- **Restart recovery keeps engine ADR 0002**: a crashed owned Run resumes by folding the transcript
  and sending the continuation nudge.

### Tools, permissions, sandboxing ([#166](https://github.com/taylorfsteele/cogwork/issues/166))

- **Owned tool set** (opencode's shape): read, write, edit, bash, glob, grep, webfetch — TanStack
  `toolDefinition`s with Effect handlers. No tracker/PR tools; `git`/`gh` ride inside bash;
  coordination writes stay engine-side. MCP skills grow the surface per run (engine ADR 0005).
- **Execution through ai-sandbox's `localProcessSandbox`** pointed at the run's worktree — buys
  `sandbox.file.diff` (the live diff feed), the policy carrier, and secret scrubbing for free. No
  real isolation now (single-user trust, same as cursor-acp today); the sandbox provider is a seam,
  and a real isolation provider is the only path to airtight confinement — a hosted concern.
- **Per-stage policy profiles** keyed off the playbook's `ResolvedStage`, over one shared tool
  registry: **read-only** (triage: read/glob/grep/webfetch) and **full** (implement, follow-up).
  Engine-owned defaults now; per-workspace override waits for settings-as-data.
- **Confinement is coarse now:** command-glob rules plus a small hard-deny list (force-push to
  `main`, `curl | sh`, `rm -rf` of home/absolute paths), writes gated to the worktree,
  network/webfetch allowed. The model is treated as fallible, not adversarial; even a hard-deny
  just returns "denied", and the loop budget bounds thrashing.
- **Secrets:** credential store mints → TanStack Secrets channel → tool/exec env. Never the ledger
  or event log. The runner's own model API key resolves the same way.

### Context assembly (engine ADR 0007; [#169](https://github.com/taylorfsteele/cogwork/issues/169))

- The first-party runner pulls a **context assembler** that returns structured **instruction
  layers** — global → repo → playbook — rendered into `systemPrompts`; the filled playbook prompt
  stays the user message.
- **Ambient instructions are `AGENTS.md` only:** `~/.cogwork/AGENTS.md` globally, plus every
  `AGENTS.md` from the worktree cwd up to the project root.
- **Playbook skills** come from `packages/engine/skills/` and are both inlined (`SKILL.md` in the
  playbook layer) and **provisioned** — the skill directory copied under `~/.cogwork/`, never
  into the driven worktree.
- CLI harnesses keep today's name-in-prompt path; MCP skills stay on the capability channel;
  compaction is a named runner seam (`onConfig` / `summarize()`), algorithm deferred until the loop
  exists.

### Provider layer ([#163](https://github.com/taylorfsteele/cogwork/issues/163), [#164](https://github.com/taylorfsteele/cogwork/issues/164))

- Extend the existing `credential-store.ts` seam: API keys per provider + the OpenRouter PKCE flow.
- TanStack AI supplies the agent loop, provider adapters, the AG-UI event vocabulary, the policy
  evaluator, and managed MCP. We own: the `HarnessEvent` widening, approval UX/transport (later),
  provider login flows, capability assembly, the Effect bridge, and (interactive phase) the durable
  prompt inbox and steer/queue semantics. Top risk from the audit: docs-vs-installed version drift —
  re-verify against the pinned version at build.

### Seams held open, deliberately not built (`/prefactor` discipline, [#168](https://github.com/taylorfsteele/cogwork/issues/168))

Marked so future work knows the reopen cost; none of this is in scope to build:

- **The issue tracker plays three roles** — sensor, work-item identity, coordination store. Non-
  coding work has no tracker, so the roles must separate eventually (reference: t3code's
  command/event split). Deferred. ADR 0017 does not split them; it fixes that **no** role is ever
  Plugin-supplied — every external system the Engine reads is an Engine port over a Connection.
- **"Act" generalizes to an actuator.** The coding harness is one actuator; the owned provider layer
  is another. Nothing may assume act == run a harness.
- **Owned coordination store** — needed when a work item has no tracker. The phase-3 ingestion
  watermark (in the run-ledger DB) is its first small instance; the full store waits for the first
  non-coding workflow.
- **Knowledge layer** — deferred; phase-3 ingestion is its seed.

## Roadmap

Sequenced, ticket-sized slices. Each is scoped to be mintable as a GitHub issue the pipeline can
triage and (mostly) execute AFK; a few are flagged **human-paired** where they need accounts,
installs, or product taste. Mint one tranche at a time via the authoring skills — don't flood the
board. Dependencies are named inline; anything unlisted is parallel-safe.

New vocabulary (`Session`, `context source`, `ingestion worker`, `proposed action`, instruction
layers, skill provision) enters the relevant `CONTEXT.md` with the slice that builds it, per the
domain-docs convention.

### Phase 1 — Mission control

Contract work first (it unblocks everything), then the shell, then the surfaces.

1. **Split contracts into queries and commands; add the Principal seam.** CQS split of
   `packages/contracts`; `RpcMiddleware` injecting a fixed local-owner `Principal`; socket moved to
   `~/.cogwork` at `0600`; token-as-header shape stubbed.
2. **`DaemonEvent` union and the `WatchEvents` stream.** `RunActivity | ItemChanged | RunChanged |
   SchedulerChanged`, one-per-client, bounded buffers; `WatchActivity(runId)` kept for drill-in.
   Depends on slice 1.
3. **The three commands.** `CancelRun` (stop + park `ready-for-human`), `Reclassify` (drives
   `setRoles`/`note`), `SetScheduling`; typed errors per the table above; each returns the
   classified-item read model. Depends on slices 1–2.
4. **Read model: PR summary per item.** Checks, reviews, mergeable/base-divergence, wait signal —
   carried in `DaemonStatus` and `ItemChanged`.
5. **Read model: inline triage proposal.** Self-halted items carry the agent's proposal text
   (today it's buried in a tracker comment).
6. **Widen the harness event.** The AG-UI-whole-in-an-envelope contract (runId / seq / atMillis /
   correlation ids); cursor-acp maps best-effort; ledger fold unchanged. (Phase-2 session work
   builds on this, but the run view needs it now.)
7. **Electron shell scaffold.** electron-vite + electron-builder; engine as a supervised bundled
   Node child; single instance, close-to-hide, dock + tray; window-state + electron-log; typed
   main↔renderer IPC with RPC-over-socket confined to main. **Human-paired** (signing,
   distribution setup).
8. **UI workspace scaffold.** `packages/ui` (shadcn + Tailwind v4 primitives/tokens) and
   `apps/desktop` (React, TanStack Router, AtomRpc + atom-react, zustand). Depends on slice 7.
9. **The Feed and left nav, with the Attention rail.** Home screen per the prototype: live run
   cards, Queued, Recently done; rail defaults to Attention (self-halts + PR gate). Depends on
   slices 2, 4, 5, 8.
10. **Item detail in the rail.** Live-run drill-in (widened events: reasoning, tool calls, diffs),
    triage approval (answer/override in place via `Reclassify`), PR gate with deep links. Depends
    on slices 3, 6, 9.
11. **Board, Inbox, and Lanes views; scheduler gauges + global pause.** The remaining views over
    the same read models; pause/resume wired to `SetScheduling`. Depends on slice 9.

### Phase 2 — First-party runtime

The structural prefactor (slices 1–3) is behavior-preserving — cursor-acp keeps working throughout
— and can start as soon as phase-1 contract work lands.

1. **Session as a first-class entity.** `SessionId` FK on runs, engine-minted at insert; the
   owned-transcript / opaque-handle sum type; `SessionStore` interface with `loadThread` as a
   ledger fold; one-line engine ADR 0002 amendment.
2. **Reshape `HarnessRequest` into a Session-referencing envelope.** `prompt: string` becomes the
   envelope carrying a `SessionId`; short engine ADR 0006 amendment (a sharpening, not a
   reversal). Depends on slice 1.
3. **`ContextAssembler` implementation.** Instruction layers (global/repo `AGENTS.md` walk +
   playbook), skill inlining + provision under `~/.cogwork/`, per engine ADR 0007. CLI
   harness path untouched.
4. **Provider credentials and model catalog.** Extend `credential-store.ts`: API keys per provider
   + OpenRouter PKCE OAuth; models.dev `api.json` as the picker catalog. **Human-paired** (real
   accounts to verify against).
5. **The owned tool set over ai-sandbox.** The seven tools as `toolDefinition`s with Effect
   handlers, run through `localProcessSandbox` at the worktree; `sandbox.file.diff` wired toward
   the run-view diff feed.
6. **Per-stage policy profiles; ask compiles to deny.** Read-only vs full profiles keyed off
   `ResolvedStage`; the hard-deny list; engine-owned defaults. Depends on slice 5.
7. **The runner.** The TanStack AI `chat()` loop behind `HarnessRunner`, registered beside
   cursor-acp: native AG-UI emission into the widened envelope, secrets via the TanStack channel,
   per-turn context pull through the assembler (`onConfig`), per-stage loop budget. Depends on
   slices 1–6 and phase-1 slice 6.
8. **Owned utility-call path.** A thin engine service for non-session model calls (routing,
   summaries, later extraction) over the same provider layer — never a harness. Depends on
   slices 4, 7.
9. **Persistence adoption.** `withPersistence` + the `interrupts` store at the then-pinned version;
   `messages` backed as a ledger projection so the ledger stays the one truth. Depends on slice 7.
10. **Dogfood cutover.** Default cogwork's own playbooks to the first-party runner;
    cursor-acp stays registered. **Human-paired** (judgment call on readiness). Depends on
    slices 7–9.

### Phase 3 — Proactive layer

Direction is settled ([#168](https://github.com/taylorfsteele/cogwork/issues/168)); these
slices are deliberately coarser and graduate into sharp tickets once phase 2 lands. Blocked behind
the owned runtime (extraction runs through it).

1. **`createWorkItem` on the issue-tracker port** and both adapters (GitHub, Linear) — the one
   capability the port lacks.
2. **Ingestion worker + watermark.** The third daemon-global heartbeat; per-source watermark +
   minted-keys in the run-ledger DB (the first crack of the owned coordination store).
3. **Granola integration research** — MCP vs API. A `/research` ticket at build time.
4. **Agentic extraction** through the owned utility path: actionable-vs-chatter, workspace
   attribution, confidence scoring; never mint into an unrecognized project.
5. **Proposed-action store, pending read model, approve/dismiss RPC** — the one mutating RPC beyond
   phase 1's three.
6. **Proactive surface** on mission control — prototype first (like #167), then build: go/no-gos,
   questions, auto-mint awareness, grouped by meeting.
7. **Product ADR: the hybrid-by-confidence mint gate** — recording why go/no-go on admission
   doesn't violate autonomous-with-override.

Capstone: the meeting-to-PR demo, end to end.

## Decision log

The full reasoning per area, in resolution order on the map:

| Area | Ticket / ADR |
|---|---|
| TanStack AI capabilities | [#164](https://github.com/taylorfsteele/cogwork/issues/164) · [audit doc](../research/tanstack-ai-audit.md) |
| Provider auth landscape | [#163](https://github.com/taylorfsteele/cogwork/issues/163) · [landscape doc](../research/provider-auth-landscape.md) |
| Mission control product | [#160](https://github.com/taylorfsteele/cogwork/issues/160) · ADR [0007](../adr/0007-autonomous-with-override-triage-self-halts.md) |
| Runtime session model | [#165](https://github.com/taylorfsteele/cogwork/issues/165) |
| Tools / permissions / sandbox | [#166](https://github.com/taylorfsteele/cogwork/issues/166) |
| Mission control UI shape | [#167](https://github.com/taylorfsteele/cogwork/issues/167) · [prototype](https://github.com/taylorfsteele/clanker-forge/blob/dc38a35306d750b75fd4345cca95769885ae40c4/prototypes/mission-control-v1.html) |
| Client contract / transport | [#161](https://github.com/taylorfsteele/cogwork/issues/161) |
| Desktop shell + UI stack | [#162](https://github.com/taylorfsteele/cogwork/issues/162) · ADRs [0008](../adr/0008-desktop-shell-is-electron-primary-daemon-host.md), [0009](../adr/0009-mission-control-ui-client-stack.md) |
| Proactive layer + reframe | [#168](https://github.com/taylorfsteele/cogwork/issues/168) |
| Context assembly | [#169](https://github.com/taylorfsteele/cogwork/issues/169) · engine ADR [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md) |
| Wayfinder map | [#159](https://github.com/taylorfsteele/cogwork/issues/159) |
