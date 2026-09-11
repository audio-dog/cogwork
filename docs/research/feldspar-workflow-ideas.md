# Research: Feldspar workflow ideas

Resolves [#657](https://github.com/colonylabs/cogwork/issues/657), part of the
[Customizable Workflows map (#656)](https://github.com/colonylabs/cogwork/issues/656).

**Question**: what operations, triggers, or workflow shapes does Feldspar (`~/sites/feldspar`, the
AI assistant desktop app) have that are worth copying into Cogwork's customizable Workflows system?

All claims below were read from the Feldspar source on 2026-09-11. Paths are relative to the
Feldspar repo root. The load-bearing primary sources: `CONTEXT-MAP.md`,
`src/main/external-context/CONTEXT.md` (the Context Depth glossary), `AGENTS.md` (the 8-stage
pipeline description), `docs/architecture/cost-map.md`, and the files cited inline.

---

## 1. What Feldspar is, in one paragraph

Feldspar ingests the user's work context from connected sources (Slack, Notion, Granola, Google
Calendar), builds a knowledge layer (entity graph + accumulating profiles), and prepares **proposed
actions** the user approves before anything executes. One serial pipeline
(`ingest → link-identities → entities → synthesize → consolidate-todos → prioritize → propose →
self_reflect`) runs on a single interval with single-flight and back-to-back drain
(`src/main/external-context/jobs/externalContextJobScheduler.ts`). Execution of an approved action
happens only through validated write-tool contracts (`src/main/external-context/writeToolContracts.ts`).
Structurally it is remarkably close to Cogwork's settled model: agent judgement in discrete steps,
deterministic scaffolding between them, and side effects behind an owned, typed gate.

## 2. Candidate workflows, in the settled model's terms

### A. Meeting transcript → tracked issues *(validates Granola → Issue)*

Feldspar source: transcript ingestion via the Granola/Notion MCP provider (`AGENTS.md` stage 1),
todo minting from salient documents (`jobs/unitTodoService.ts`, `unitTodoExtractor.ts`), and the
merge-or-mint gate (`jobs/todoMergeMatcher.ts`, `todoAnchors.ts`, `jobs/reconciliationVerifier.ts`).

- **Trigger**: Granola transcript ingested (polling source, per-source watermark). Deterministic
  filter before any Run: user attended, transcript has substantive content
  (`jobs/salienceDetector.ts`).
- **Operation 1 — Extract commitments.** Work context: the transcript plus attendee identities.
  Typed outcomes: `commitments (list)` | `nothing_actionable`.
- **Operation 2 — Reconcile against the backlog** (per commitment). Typed outcomes: `new` |
  `duplicate_of(item)` | `advances(item)`.
- **Transitions**: `new` → output action *create issue*; `duplicate_of` → output action *post
  comment* attaching the new evidence, or end; `advances` → output action *post comment* /
  *update issue*; `nothing_actionable` → end.
- **Fit**: clean. Feldspar's hard-won lesson is Operation 2: a new extraction is either **minted or
  merged into an existing open todo** — a merge is correct dedup, not a dropped result. Without a
  reconcile step, Granola → Issue spams duplicate issues on every re-ingest (the grace window
  re-pulls recent content by design).

### B. Directed message → classify → dispatch *(validates Slack → Review)*

Feldspar source: the salience rules for Slack (`jobs/salienceDetector.ts`: DM, @mention, direct
question, decision in an active channel — "precision over noise; a miss is cheap because the next
scheduled pass catches it"), and conversation-scoped extraction
(`jobs/slackConversationCatchUp.ts`: per-conversation buckets with their own extraction watermark).

- **Trigger**: Slack message ingested. Deterministic declarative filter: directed at the user
  (DM / mention / direct question), resolved from source-native identity metadata — no agent call.
- **Operation 1 — Classify the ask.** Work context: the *whole conversation*, not the single
  message. Typed outcomes: `review_request(pr)` | `actionable_ask` | `needs_human_judgement` |
  `not_actionable`.
- **Transitions**: `review_request` → Operation 2 *run PR review* → output actions *post comment*
  (on the PR) + *notify*; `actionable_ask` → dispatch the matching Operation; `needs_human_judgement`
  → park + *notify* with a brief (see §3.4); `not_actionable` → end.
- **Fit**: clean. Two things to copy: the deterministic directed-at-me filter as trigger anatomy,
  and conversation-scoped (not message-scoped) work context.

### C. Executed work → completion assessment *(validates PR Merged → Verify)*

Feldspar source: `jobs/followUpCompletionAssessor.ts`. When one ask spawns several follow-up cards,
executing one does **not** auto-close the original; an assessor reads the whole thread and judges
`fulfilled` vs `outstanding`. **Fail-soft: any assessor error → null → a deterministic fallback
rule** (no live sibling ⇒ fulfilled).

- **Trigger**: PR merged (artifact state change on an external system).
- **Operation — Assess whether the originating ask is fully handled.** Work context: the original
  issue, the merged PR, sibling open work. Typed outcomes: `fulfilled` | `outstanding(remaining)`.
- **Transitions**: `fulfilled` → output action *close issue*; `outstanding` → output action
  *create issue* (the remainder) or *notify*.
- **Fit**: clean, and it sharpens the spec: an assessment Operation needs a **deterministic default
  route when the Run fails** — Feldspar never lets a judgement failure wedge the lifecycle.

### D. Staleness sweep over parked/proposed work

Feldspar source: `jobs/proposedActionStalenessService.ts` + `proposedActionStalenessEvidence.ts`
(post-ingest review of live suggestion cards), `proposedActionDeadline.ts` (deadline passed),
`proposedActionSourceAge.ts` (source older than 14 days auto-retires), and deterministic completion
detection (the proposed meeting already exists on the calendar, the proposed doc was already
written — `meetingRedundancy.ts`, `documentRedundancy.ts`).

- **Trigger**: scheduled, plus after each ingest pass.
- **Operation — Is this still worth doing?** Deterministic checks run first (deadline passed,
  source too old, the world already did it); an agent verdict only for the ambiguous remainder.
  Typed outcomes: `keep` | `retire(reason)` | `refresh`.
- **Transitions**: `retire` → output action *withdraw* (cancel the parked touchpoint / close the
  notification) + optionally *notify*; `refresh` → re-run the drafting Operation; `keep` → end.
- **Fit**: fits the stance and fills a real gap — Cogwork's park/notify/resume touchpoints
  currently have no story for *the world moved on while parked*. Feldspar shows most of the sweep
  is deterministic scaffolding; the agent only breaks ties.

### E. Scheduled digest / status update

Feldspar source: `jobs/workstreamUpdateJob.ts` + `workstreams/workstreamUpdateGenerator.ts` — a
research pass over accumulated context, then a drafting pass, with a **bounded follow-up loop**
(the writer may request more context at most `FELDSPAR_WORKSTREAM_UPDATE_FOLLOW_UP_LIMIT = 1`
times, "capped low so the loop can never thrash"), then a worth gate before anything is shown.

- **Trigger**: schedule (e.g. weekly per workstream/workspace).
- **Operation 1 — Research** (bounded, capped). Outcomes: `context(bundle)` | `nothing_new`.
- **Operation 2 — Draft the update.** Outcomes: `draft` | `not_worth_reporting`.
- **Operation 3 — Worth gate** (see §3.3). Outcomes: `publish` | `withhold`.
- **Transitions**: `publish` → output action *post message* / *notify*; everything else → end.
- **Fit**: clean; needs only the `schedule` trigger kind the map already implies.

## 3. Patterns worth copying (independent of any one workflow)

### 3.1 Salience gate: cheap deterministic filter + scheduled-sweep backstop

`jobs/salienceDetector.ts` is explicit doctrine: *"Keep me conservative: precision over noise. A
below-bar event falls through to incremental writes + the next scheduled pass, so a miss is cheap;
a false positive wastes a synthesis run."* Every event Trigger should pair a declarative,
deterministic filter (directed-at-me, authored-by, names-X) with a scheduled sweep that catches
what the filter missed. This resolves half of the map's open "Trigger anatomy" question.

### 3.2 The candidate funnel: detect → assess → gate

Feldspar never goes straight from signal to side effect. Detection surfaces **candidates**;
an **assessment** scores each against a confidence threshold (default 88, per `CONTEXT.md`);
a **worth policy** gates finished drafts against a value bar (default 55,
`proposedActionWorthPolicy.ts` via `AGENTS.md` stage 7). In Cogwork terms: routing decisions as
Operations with outcomes `worthy | not_worthy`, with the threshold as an Operation setting. This is
the settled model's "a routing decision can itself be an Operation", validated in production.

### 3.3 Frozen, validated output plans behind approval

`writeToolContracts.ts`: a proposed action's tool-call plan is validated at **propose time** (the
corrective error goes back to the agent in-context, which retries) and again at **execute time**
("defense-in-depth on the replayed plan, which is frozen verbatim on the card"). Each contract
normalizes deterministically, then validates with a strict schema. For Cogwork: an outcome that
carries a pending output action should freeze a typed, engine-validated plan at Operation end, and
park→resume should execute exactly what the human approved — never re-draft.

### 3.4 A "brief the human" outcome (thought partnership)

`proposedActionRegistry.ts` has a `thought_partnership` action type: *"the incoming ask solicits
the user's OWN opinion... there's nothing to execute. The card carries Feldspar's brief."* Not
executable by design. In Cogwork terms this is a first-class outcome whose payload is a brief for
the human — the park + notify touchpoint with structured content, not a degenerate "failed" state.

### 3.5 Supersede semantics with a loop circuit breaker

`jobs/todoSuccessionLadder.ts`: when work advances past its live card, the card is **atomically
replaced**, not duplicated — and a lifetime succession cap (default 10) exists purely as *"a
runaway-loop circuit breaker, NOT a semantic limit"*, leaving room for legitimately long arcs
(message → reply → schedule → reschedule). Cogwork's Transition graphs will have cycles
(refresh, retry, supersede); the spec should carry a per-lineage cap like this.

### 3.6 Watermark + grace-window ingestion, with a run manifest

Polling connectors resume from a per-source `last_queried` watermark minus a connector-specific
grace window (Slack ~1 day, Notion/Granola ~3 days, 14-day first-sync backfill), because these
sources filter by posted/created date only — the grace, not a modified-since query, is how edits
get re-pulled (`AGENTS.md` stage 1, `CONTEXT.md` "Watermark"). Connectors on the uniform contract
are drained against a **RunManifest** — "the run's definition-of-done" — and the stage reports
complete only when every manifest item was fetched (`connectors/buildRunManifest.ts`). Both belong
in the anatomy of any polling Trigger (Granola is one).

### 3.7 Correlated per-pass trace

Every LLM-decision stage logs a persisted event correlated by `synthesisId` — "the first-class
debugging surface for the pipeline" (`CONTEXT.md` "Pipeline Events"). Cogwork's Run ledger covers
Runs; Workflows add engine-owned routing decisions between Runs, and those need the same
correlated trace per workflow execution.

### 3.8 A cost lesson for budgets

`docs/architecture/cost-map.md` (measured Aug 2026): one drafting agent was **44% of all measured
spend**; the most expensive single call ($2.02/call) was *outside* the pipeline; and "call volume
and cost are nearly uncorrelated." Keeping budgets engine-level (as the map settled) is right, but
per-Operation cost attribution in the ledger is what made Feldspar's costs diagnosable at all.

## 4. What does not fit, and why

- **Companion / frontmost-app triggers** (`src/main/companion/` — detect the focused Slack
  conversation from the window title, draft in an overlay, paste into the frontmost app).
  User-attention desktop software. Cogwork is an orchestration control plane; a "user is looking
  at X" trigger has no analog, and paste-into-app is an agent writing to a shared surface without
  the engine — exactly what the output-action rule forbids.
- **Screen capture as a context source** (`src/main/capture/` — screenshots, AX trees, local
  summarizers; currently dormant). Privacy posture and product scope both wrong for Cogwork.
- **Autonomous entity curation** (Workstreams are "created, revised, and retired autonomously from
  the corpus", `CONTEXT.md`). Cogwork Workflows are user-authored; letting agents restructure the
  routing graph contradicts deterministic scaffolding. The *shape* (agent proposes, human approves
  a structure change) could return later as a workflow, not as engine behaviour.
- **The living knowledge layer itself** (entity graph, accumulating profiles, synthesis). It is
  Feldspar's heart and its biggest cost center. For Cogwork it is a possible future *context
  source*, not a workflow feature; adopting it would be a separate map. Noted, not proposed.
- **Meeting overlays** (`src/main/meeting-overlays/` — prep/recap windows around calendar events).
  The overlay surface doesn't fit; the underlying shape (calendar-proximity trigger → prep brief →
  notify) is just workflow E/§3.4 and needs nothing new.

## 5. Flags for the Workflows spec

1. **Trigger anatomy** (map's open question): an event Trigger = source + event kind + a
   *deterministic declarative filter* (directed-at-me / authored-by / names-X), with a scheduled
   sweep backstop; a polling Trigger = watermark + grace window + manifest completeness. (§3.1, §3.6)
2. **Missing output actions** for the catalog: *update/comment-on existing artifact* (the merge
   half of create-or-update, §2.A), *withdraw/retire* a previously created artifact or parked
   touchpoint (§2.D), *supersede/replace* a live artifact (§3.5), and *notify-with-brief* as a
   structured payload (§3.4).
3. **Reconcile-before-create** must be expressible cheaply — either a standard Operation archetype
   or engine assistance — or every artifact-creating Workflow duplicates on re-ingest. (§2.A)
4. **Failure routing**: every Operation needs a declared default Transition on Run failure/timeout;
   Feldspar's assessors are uniformly fail-soft to a deterministic rule. (§2.C)
5. **Cycle cap**: a per-lineage circuit-breaker cap on Transition cycles, generous and
   non-semantic. (§3.5)
6. **Frozen output plans**: an outcome carrying a pending output action freezes a typed,
   engine-validated plan; resume executes the approved plan verbatim. (§3.3)
7. **Staleness over parked work**: parked touchpoints need re-evaluation triggers (scheduled /
   post-ingest) so the system can withdraw work the world overtook. (§2.D)
