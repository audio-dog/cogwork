# Spec: desktop shell revamp — item tab, Attention, Activity, Settings, degraded engine states

> Published as [taylorfsteele/cogwork#53](https://github.com/taylorfsteele/cogwork/issues/53) (`ready-for-agent`). The issue is the live copy; this file is a repo snapshot.

Spec produced from the wayfinder map #7 (**Wayfinder: desktop shell layout revamp — prototype to production**). All design tickets on the map are resolved; this spec collects every decision from the map, its child tickets, and the prototype branches into one buildable document.

## Problem Statement

As the person operating cogwork from the desktop shell, the mission-control surfaces I need were designed but never built. Today:

- Clicking a work item card gives me no real drill-in: there is one shared detail surface, not a per-item tab, and a live agent run still reads as a firehose rather than a transcript.
- The list of items that need me is still the old attention rail, full of jargon ("self-halt", "merge gate") and raw AI prose dumped into cards.
- Raw daemon activity is a separate left-nav route that shows per-delta noise, silently drops event types, and gives no insight into engine lifecycle (on/off, connection lost).
- There is no Settings surface at all: I cannot change theme comfortably, see or set scheduler limits, or set a daily budget.
- When the engine is off, connecting, or broken, each surface improvises its own treatment (full-page takeover, ad-hoc "Waiting for daemon events…" text), and the engine starts idle at launch so the app boots into a dead state.

## Solution

Build the five decided surfaces on the existing shell (custom title bar, collapsing sidebar, tabbed/resizable side panel — already on main), following the designs locked on the map:

1. Flip the launch defaults: the engine starts **on**, scheduling starts **paused**. One shared, subscription-aware **degraded gate** then owns the Off / Connecting / Broken treatments across the whole shell, with a compact echo in every side-panel surface.
2. The side panel gains **per-item tabs**: clicking a work item card opens a persistent, deduped tab titled by its work item id, with sub-tabs `Main | Live run | Pull request`, triage approve/reclassify, blockers, previous attempts, metadata, and the **run transcript** (Conversation + Now) rendered live.
3. The **Attention tab** becomes a filterable launcher: one flat urgency-sorted list of **Needs a decision** and **Ready to merge** rows, deterministic signals only, a segmented kind filter with counts, and a workspace funnel filter.
4. The **Activity tab** moves into the side panel as a two-zone Transcript surface: a compact live **Now** panel over a newest-at-top event log, backed by a new **unified renderer event source** (prefactor) that merges daemon events with synthesized engine-lifecycle events.
5. A **Settings** experience: the account menu swaps the left sidebar into settings navigation with embedded search, and grouped card-row pages (General · Appearance · Engine) with a theme preview picker.

Already landed on main and **not** part of this spec's work: the app shell frame (#8), Board/Inbox deletion (#9), the Feed spotlight + ledger build (#35 / PR #36), the old-shell dead-code cleanup including the Lanes view and the `_connected` layout (#20 / PR #46), the shadcn chat primitives (#10), and the `InputGroup` + menu fixes (PR #45).

## User Stories

1. As an operator, I want the engine to start automatically when I launch the app, so that the app never boots into a dead "engine off" state I have to fix every time.
2. As an operator, I want scheduling to start paused at launch, so that launching the app never silently starts spending my budget until I press start.
3. As an operator, I want one clear warning treatment when the engine is off, with a single "Turn on engine" action, so that I always know how to get back to a working state.
4. As an operator, I want a skeleton of the target surface while the app connects, with no artificial delay, so that startup feels instant instead of flashing placeholder text.
5. As an operator, I want a clear error treatment when the engine fails or the daemon is unreachable, with a single "Restart engine" action, so that recovery is one click and I am not offered useless manual retries.
6. As an operator, I want the sidebar, header, and engine toggle to stay usable while the main view shows a degraded state, so that I can still act on the engine itself.
7. As an operator, I want every side-panel surface to show the same compact off/connecting/broken vocabulary as the main view, so that the app never contradicts itself about engine state.
8. As an operator, I want an adopted engine to look exactly like a running engine, so that I am not confused by supervisor-internal jargon like "Adopted".
9. As an operator, I want paused scheduling presented calmly (a banner and a start action), not as an error, so that the deliberate default state does not read as something broken.
10. As an operator, I want to click a work item card and get a tab for that item in the side panel, so that I can drill into exactly the work I care about.
11. As an operator, I want opening an already-open item to focus its existing tab instead of duplicating it, so that the panel never fills with copies.
12. As an operator, I want item tabs titled by the work item id with the workspace in the tooltip, so that tabs stay compact but unambiguous across workspaces.
13. As an operator, I want every item tab open to be persistent (no preview state), so that a tab I opened stays until I close it.
14. As an operator, I want the item tab to open on a Main view with identity, state, triage, blockers, pull request summary, previous attempts, and metadata, so that I get context before detail.
15. As an operator, I want a running item to pulse its "Live run" sub-tab and show an "Agent is running… View live run →" affordance on Main, so that a live agent is prominent without hijacking my landing view.
16. As an operator, I want a "Pull request" sub-tab that appears only when the item has a pull request, showing checks, review, base divergence, and wait time with an "Open on GitHub" action, so that I can judge a PR without leaving the app.
17. As an operator, I want the agent's triage proposal shown on the item tab clearly marked as an AI suggestion, rendered as markdown with truncation and expand, so that I can read it without mistaking it for a system fact.
18. As an operator, I want to approve or reclassify a Needs-a-decision item from its item tab, so that triage is one click from the drill-in.
19. As an operator, I want to cancel and park a running run from the item tab, so that I can stop an agent that is going wrong.
20. As an operator, I want all item-tab actions to carry equal visual weight, so that the app does not pick a "primary" action for me.
21. As an operator, I want a live run rendered as a natural prose conversation where reasoning, tool calls, and diffs collapse to one-line rows I can expand, so that I can follow the agent without drowning in raw events.
22. As an operator, I want consecutive tool rows folded behind a "+N previous tool calls" toggle with only the newest visible, so that tool-dense runs stay readable.
23. As an operator, I want a pinned "Now" line with run status, stage, elapsed, and tokens above the transcript, so that I always see what the agent is doing this second.
24. As an operator, I want transcript prose rendered as markdown with syntax-highlighted code and diffs, so that agent output reads the way it was written.
25. As an operator, I want auto-scroll to the live edge with a jump-to-latest button, so that I can scroll back without losing the live tail.
26. As an operator, I want to expand a previous attempt and read its transcript in place, so that I can compare what past runs did.
27. As an operator, I want one Attention list of everything that needs a person, sorted most-urgent first, so that I always know what to look at next.
28. As an operator, I want attention items named "Needs a decision" and "Ready to merge" in plain language, so that I do not have to learn internal jargon like self-halt or merge gate.
29. As an operator, I want attention rows to show only deterministic signals (kind, id, title, workspace, wait time or reason, PR status dots), so that a glanceable list is never padded with AI prose.
30. As an operator, I want to click anywhere on an attention row to open the item tab, so that the list is a launcher and the acting happens in one place.
31. As an operator, I want a segmented kind filter (All · Needs a decision · Ready to merge) with counts on every segment, so that I can scope the list with zero ambiguity about what is selected.
32. As an operator, I want a workspace funnel filter with a multi-select menu and a slim summary banner with Clear, so that filtering by workspace never grows the header no matter how many workspaces I have.
33. As an operator, I want a quick-open button on each attention row that opens the PR on the code host or the ticket on its tracker (GitHub or Linear), so that I can jump to the source in one click.
34. As an operator, I want an Activity tab in the side panel showing a live Now zone (running agents, scheduler in-flight/limit, engine and connection state) over an event log, so that I can confirm the engine works at a glance.
35. As an operator, I want each running agent collapsed to one live heartbeat row that updates in place and opens its run transcript on click, so that runs never flood the log with per-delta rows.
36. As an operator, I want the event log to include all daemon event types (including item removals and workspace changes that are dropped today) plus engine on/off, connection lost/restored, and stream errors, so that nothing that happened is invisible.
37. As an operator, I want event rows with relative time, a type indicator, a one-line human summary, and a link to the run or item involved, so that I can read the log without decoding payloads.
38. As an operator, I want to expand any event row to its raw payload, so that debug depth is always one click away.
39. As an operator, I want minor events hidden by default behind a "Show / Hide minor events" toggle, so that the default view stays calm.
40. As an operator, I want a "Pause / Resume new events" toggle that freezes the visible log, so that I can inspect a row while events keep arriving.
41. As an operator, I want to filter events by type and by free text, and to click an entity to scope to it, so that I can isolate one run or item's story.
42. As an operator, I want errors emphasized in the log, so that failures stand out from routine flow.
43. As an operator, I want to open Settings from the account menu at the bottom-left of the sidebar, so that settings are where every desktop app puts them.
44. As an operator, I want Settings to take over the left sidebar with a "Back to app" control, so that I stay oriented inside the same window instead of a modal.
45. As an operator, I want to search settings from the sidebar and jump straight to a highlighted setting, so that I never hunt through categories.
46. As an operator, I want settings grouped into General, Appearance, and Engine pages with card-style rows (title and description left, control right), so that each setting explains itself.
47. As an operator, I want a theme picker with system/light/dark preview tiles that applies immediately, so that I can see what I am choosing.
48. As an operator, I want a close-to-hide switch, scheduler concurrency steppers, and a daily budget input in Settings, so that the engine's behavior is configurable without editing files.
49. As an operator, I want Settings to work with the daemon disconnected, so that theme and local preferences never depend on the engine.
50. As an operator, I want calm empty states rendered with one consistent treatment across the Feed and every side-panel tab, so that "nothing here" never looks broken.
51. As a developer of the shell, I want a pure `(enginePhase, boardResult) → treatment` function to own the degraded states, so that the mapping is unit-testable and cannot drift per surface.
52. As a developer of the shell, I want one unified renderer event source feeding the Activity tab, so that the view lands on clean ground instead of re-merging streams in components.

## Implementation Decisions

Vocabulary throughout is the **Shell surfaces** glossary in the desktop context doc (side panel, item tab, Feed, Attention tab, Needs a decision, Ready to merge, Activity tab, run transcript). Extend that glossary as new surfaces settle. All UI is composed from the shared UI package's shadcn primitives (base-nova, Tailwind v4, React 19 — `use()`, no `forwardRef`, React Compiler so no manual memoization), per the desktop app's agent guide, the shadcn skill for any component work (reuse primitives; add missing ones with the shadcn CLI from the UI package), the react-composition-patterns skill, and the effect-ts skill for any Effect code. The typed IPC seam and the AtomRpc event stream are kept as-is; only presentation changes. Prototype branches are **primary sources to steal from, never to promote**: every build rewrites the throwaway code properly.

### Build order / dependencies

1. **Launch-default flip** — must land before the degraded gate (it is what makes Off a warning).
2. **Degraded gate** — blocked by (1); its compact echo is consumed by every side-panel surface.
3. **Side panel per-item tabs** — blocks the item tab.
4. **Item tab + run transcript** — blocked by (3); the Attention and Activity tabs link into it.
5. **Attention tab** — needs the item tab for click-through and a tracker-ticket-URL read-model change (below).
6. **Activity prefactor, then Activity tab** — the prefactor (unified renderer event source) lands first.
7. **Settings** — independent of the daemon surfaces; must reconcile open PR #44 (below).

### 1. Launch-default flip (prerequisite, from #18)

- On launch the engine supervisor starts the engine (today it is idle unless `COGWORK_ENGINE_AUTOSTART=1`); scheduling starts **paused**. The person presses to start scheduling.
- Update the desktop context doc: the **Engine supervisor** and **Engine toggle** entries currently say "idle at launch by default", which becomes wrong.
- First-run copy of the paused banner may be softened.

### 2. Degraded engine gate (from #18, research #41)

- **State model** — fold two long-lived push subscriptions (engine phase from the `onEngineStatus` IPC seam; board result from the AtomRpc event stream) into four operational states:
  - **Live** — engine `running`/`adopted` + stream Success.
  - **Off** (warning) — engine `stopped`/`unknown`.
  - **Connecting** (transient) — engine `starting`, or engine up + stream Initial.
  - **Broken** (error) — engine `failed`, or stream Failure while the engine claims it is up.
- **Mechanism** — one shared, subscription-aware gate: a **pure `(enginePhase, boardResult) → treatment` function**. Explicitly **not** TanStack Router route-level (`pendingComponent`/`errorComponent`/`loader` bind to the route load lifecycle; our signals change after load; the header engine badge/toggle and the side panel live outside the router outlet). Keep per-route `errorComponent` only as a crash safety net. `pendingMs: 0` — no artificial delay.
- **Placement** — one shared status surface in the main view; shell chrome stays live. Each side-panel surface (Attention, Activity, item tab) shows a **compact form** of the same three treatments — one vocabulary shell-wide. This replaces the removed `_connected` full-takeover's remaining pieces (the engine-offline card/message, `DaemonUnavailable`) and every ad-hoc per-surface text ("Waiting for daemon events…").
- **Treatments + locked copy** (refine wording at build):
  - **Off**: "Engine is off" · "Turn the engine on to resume work." · action **Turn on engine** (`setEngineEnabled(true)`).
  - **Connecting**: skeleton of the target surface, no text; a quiet "Connecting…" only if it persists.
  - **Broken**: engine failed → "The engine stopped unexpectedly."; daemon unreachable → "Can't reach the daemon." · single action **Restart engine** (off, then on). No manual "retry connection" (reconnect is automatic). No "view logs" (no logs surface exists; out of scope).
- **Adopted = Live.** Never show the word "Adopted" in the UI; the header badge shows the same generic live copy as a spawned running engine.
- **Scheduling paused is calm, not degraded**: reuse the existing paused banner and the header scheduling toggle as the "Start scheduling" action.

### 3. Side panel: per-item tabs

- **Superseded (right-panel revamp):** the side panel is a user-assembled **surface catalog**, not a fixed set. Attention and Activity are **Tool surfaces** you add and close like any tab; item tabs are **Subject surfaces**. Tabs are drag-reorderable and persist across launches. The store no longer seeds fixed surfaces. See product ADR 0010 and the desktop `CONTEXT.md` glossary (surface catalog, Tool surface, Subject surface).
- Generalize the side-panel store from its fixed surface kinds (attention · detail · activity) to **per-item tabs**: identity is (workspace, work item id); tab title is the id (`#50`, `AUD-1`); workspace in the tooltip; a second open **focuses** the existing tab; every open is **persistent** (no preview state). Attention and Activity are no longer fixed — they are Tool surfaces (see the superseding note above).
- Animate the panel opening/closing like the left sidebar (panel-level chrome, surfaced while deciding #13).

### 4. Item tab (from #13 content, #25 layout, #11 transcript; steal from branch `prototype/item-tab-layout`, commit `6ca32df`)

- **Layout: sub-tabs** — a strip `Main | Live run | Pull request` inside the tab. In the prototype the strip is a custom row of buttons under a border (not the shadcn Tabs primitive); active segment gets the accent treatment; no counts or badges on tabs. `Pull request` appears only when the item has a PR; if the active sub-tab disappears (e.g. the PR is gone), fall back to Main. Opens to **Main**.
- **Running emphasis** — a running item pulses a small primary dot on the `Live run` label and shows a clickable, content-hugging affordance on Main: pulsing icon + "**Agent is running.** {live status line} **View live run →**", which jumps to the Live run sub-tab. This is how "open to Main" (#13 Q11) and "transcript focal when live" (#13 Q3) reconcile.
- **Width discipline (review refinement)** — status chips and the running banner hug their content (`w-fit`/`self-start`); each sub-tab's content is width-capped (`max-w-3xl` in the prototype) and centred, so nothing stretches edge-to-edge when the panel is expanded to full view.
- The item tab is a **context and action surface** — for a real item it is never "nothing to act on": identity, state, claim, blockers, and attempt history always give it something to show.
- **Main sub-tab, top to bottom** (sections absent when empty, not placeholder'd):
  1. **Header** — mono id · workspace, then title, then a content-hugging state chip (tones: live = primary, attention = amber, ready = emerald, blocked = muted; a running chip carries a pulsing icon). The live-run status line is **not** duplicated here: it renders inside the running affordance on Main and inside the Now banner on the Live run sub-tab (the winning prototype relocated it there from #13's header sketch).
  2. **Action bar** — equal-weight outline buttons, contextual: **Cancel & park** (running), **Approve** / **Reclassify** (NeedsHuman), **Open on GitHub** (PR exists). No single AI-chosen primary action (revisit once trust is earned).
  3. **Triage** (NeedsHuman only) — reason badge; the proposal in a muted box with a leading amber "AI SUGGESTION" chip, rendered as markdown with truncation + expand; approve/reclassify (role toggle, note, Apply). The proposal is **nullable** on the read model (exhaustion / crash hand-offs carry `proposal: null`) — the triage section must still render its reason and actions without one. The triage control lives **here only** — the Attention tab launches into it (supersedes the earlier "shared with the Attention tab" note).
  4. **Blockers** (Blocked only) — the open blockers as a plain list, with links.
  5. **Pull request summary** — "PR #{n}" + status badges (labels pinned: Checks passing/failing/pending; Review pending / Changes requested / Ready to merge; Conflicts / Behind base; hide the divergence badge when none). Labelled plainly "Pull request" — **never "PR gate"**. The read model stays `PrSummary`. (Order follows the winning prototype — Triage → Blockers → Pull request — which supersedes #13's content-list ordering.)
  6. **Previous attempts** — collapsed list (stage · outcome · time · summary), expandable to that run's transcript in place; the latest/live run is focal. Empty copy: "No previous attempts."
  7. **Metadata** — Branch, Session, Harness, Tokens, Started, Ended; nulls render as "—"; values mono.
- **Live run sub-tab** — the #11 **Conversation + Now** transcript:
  - Pinned **Now banner** (built standalone/relocatable): run status, stage, harness, elapsed, tokens, plus one live status line reading the live edge (`Thinking…` / `Running <tool>…` / `Editing <path>` / `Ran <tool>` / `Run finished.`). When no run is live: an Empty with "No live run" / "The latest completed run is shown below."
  - **Conversation stream**: assistant prose as a natural stream (not chat bubbles). Reasoning, tool calls, and diffs collapse to one-line rows — icon + verb heading (`Read file`, `Ran command`, `Searched`, `Edited`, `Thought`) + one-line preview — with a right-side status marker (check done / soft pulsing dot running / ✕ error); each row expands to full args/result/diff in a bordered code block. Consecutive tool/thinking rows fold behind "**+N previous tool calls**" keeping only the newest open (max visible = 1); a prose block breaks the run. Auto-scroll to the live edge with a jump-to-latest button and a "Working…" indicator while active.
  - **The build adds** markdown rendering in the prose and syntax highlighting for code/diff bodies, with a chat-tuned typeset applied only to the prose (tool rows and the banner stay outside it). These were deferred from the prototype.
  - Components: the `message-scroller` primitive for the live edge; custom folded rows rather than `bubble`. The data model is unchanged: the daemon run-activity stream folds into transcript entries (text | reasoning | tool | diff | error) via the existing fold.
- **Compact degraded echo** from the gate (section 2) when the engine is off/connecting/broken.

### 5. Attention tab (from #12 behavior, #26 anatomy; steal from branch `prototype/attention-cards`, commit `2c1bf37`)

- **Naming** — "Needs a decision" (was self-halt; read-model tag stays `NeedsHuman`, reasons needs-info / ready-for-human) and "Ready to merge" (was merge gate; PR review ready). **Rename the `PrGate` component and every "Merge gate" string in code** as part of this build.
- **Launcher, not actor** — the whole row is the click target → the item tab. No triage controls and no AI prose on rows (the proposal lives on the item tab, marked as an AI suggestion). Deterministic signals only.
- **List: flat urgency rows** (Treatment B) — one unified list, no per-kind headers. Sort: decisions first, then Ready to merge by longest wait (`waitingSinceMillis` ascending). An item that is both NeedsHuman and merge-ready appears once, as Ready to merge.
- **Row anatomy**, left to right: kind color bar + kind icon (amber = Needs a decision, emerald = Ready to merge; icon-and-bar carry the kind — no text pill in this treatment), truncated title, mono id · workspace, then for PR rows three **status dots** (checks / review / base-divergence; emerald good, destructive bad, amber pending/behind, muted none; tooltip spells them out), a fixed-width right-aligned signal, and a hover-revealed quick-open icon.
- **Signal line** — PR rows: "waiting {relative time}". Decision rows: the reason as plain copy ("Needs info" / "Ready for human") — because the needs-human read model has **no wait time** (no `haltedSinceMillis`; adding one is out of scope). Fallback: "needs a person".
- **Kind filter (G3)** — a segmented control on the ToggleGroup primitive: `[ All · Needs a decision · Ready to merge ]`, a count on every segment, exactly one segment active (All is the reset; no multi-select ambiguity). Counts come from the full list, not the workspace-filtered one.
- **Workspace filter (F5)** — shown only with more than one workspace: a funnel icon button (aria "Filter workspaces") with a primary active-dot when filtering, opening a fixed-width Popover menu — "All workspaces" reset row, then a Checkbox row per workspace with per-workspace counts, any combination. When filtered, a slim summary banner below the header lists the active workspaces with **Clear** (clears workspaces only). No workspace chips; the header never grows.
- **Quick-open (provider-aware)** — Ready to merge: opens the PR url on the code host (stops row-click propagation). Needs a decision: opens the tracker ticket (GitHub Issues or Linear, per the workspace's tracker) — which requires the read-model change below; until it lands the control would be a disabled stub, so land the read-model change with this build.
- **Read-model change (contracts + engine, in scope)** — surface a **tracker ticket URL** on the needs-human read model (today only the PR summary carries a `url`).
- Empty copy: "Nothing needs a person right now." Empty states use the shared Empty primitive.
- Compact degraded echo from the gate. Loading/connecting is owned by that echo (skeleton, per the gate's Connecting treatment) — the prototype's stand-in "Waiting for the daemon…" text is exactly the ad-hoc per-surface copy the gate retires; do not carry it into the build.
- This build replaces the old attention rail list that the side panel still renders today (kept live through the dead-code cleanup precisely so this build could swap it out).

### 6. Activity tab (from #14 model, #27 layout; steal the Transcript variant from branch `prototype/activity-two-zone`, commit `223fea1`)

- **Prefactor first** (its own change, before the view): a **single unified renderer event source** that merges the daemon event stream with synthesized app/engine-lifecycle events and the per-run preview fold, so the view lands on clean ground. It owns:
  - **Row model**: id, kind, timestamp, type label, one-line human summary, severity (info/success/warn/error), optional entity (run | item), raw payload, and a low-signal flag.
  - **All six daemon event tags**, including `ItemRemoved` and `WorkspaceChanged` (both silently dropped today), with a human summary decoded per tag: item → "{title} → {classified state}", item removed → "{id} removed", run → "{work item} · run {status}", workspace → "{name} registered · {tracker}" or "{source} failed · {message}" (failure reads as an error), scheduler → "{inFlight}/{limit} in flight · budget {used}/{limit}". Run rows carry outcome severity (succeeded → success, failed/crashed → error, exhausted/interrupted → warn). A **paused** scheduler tick is not low-signal: it stays visible, reads "paused · {inFlight}/{limit} in flight", and carries warn severity.
  - **Synthesized lifecycle events**, emitted on transitions only: engine started/starting/stopped/failed, event stream disconnected (error), connection restored, connecting (low-signal).
  - **Run activity collapses to one live row per run** via the run-preview fold (label + one-line text, clipped) — never per-delta log rows.
  - **Low-signal classification** (hidden unless verbosity is on; default off): eligible item churn, item removals, non-paused scheduler ticks, "connecting" heartbeats.
  - **Timestamps**: arrival-stamped on receipt (the stream only carries a real timestamp on run events, which use it).
  - **Session-only** — a bounded client-side buffer (the prototype stand-in had no cap; the build must bound it); the log starts fresh each launch. The daemon has no event archive; durable history is future engine work, out of scope.
- **The view** — two zones in the #11 / MessagesTimeline design language, replacing the Activity left-nav route (delete the route; Activity becomes a fixed side-panel tab):
  - **Now panel** (compact, pinned, always live — unaffected by freeze): engine status dot (pulsing when up) + "Now" + engine copy (Engine on/starting/off/failed) + connection copy (Connected/Connecting/Disconnected); scheduler gauge "{inFlight}/{limit} in flight · budget {used}/{limit}"; one heartbeat row per active run (work item · latest preview) that opens the **run transcript** on click. Empty: "No runs in flight."
  - **Event log** — newest-at-top prepend. Rows: severity-colored type icon, one-line summary (destructive-colored on errors), entity link ("Open run → {id}" / "Open item → {id}" → run transcript / item tab), relative time (absolute on hover); whole row toggles **expand-to-raw** (pretty-printed payload). Consecutive same-kind rows fold behind "**+N previous {kind} events**" with only the newest visible and a "Show fewer" to re-collapse.
  - **Toolbar** — free-text search ("Filter events…", matching summary + type label + entity id); the #26-style funnel type filter (aria "Filter event types"; menu: "All event types" reset + checkboxes with counts for **Runs · Items · Scheduler · Workspaces · System**) over a slim summary banner with Clear; a verbosity icon toggle (tooltip "Show / Hide minor events"); a freeze icon toggle (tooltip "Pause / Resume new events" — pause/play icon; freezing snapshots the visible log, the live feed resumes on unfreeze). Click-an-entity to scope ("show only this run"). Workspace filtering only matters with more than one workspace.
  - Copy is locked plain — the earlier AI-speak ("low-signal events", "freeze the log") is retired.
  - Empty copy: "No events match. The log is session-only and starts fresh each launch."
- Compact degraded echo from the gate.

### 7. Settings (from #17 rounds 1 + 2, the #42 clarifications; steal from branch `prototype/settings-experience`, commit `c4cb842`)

- **Entry** — the account button at the sidebar bottom-left; its menu's **Settings** item enters settings.
- **Sidebar takeover** — entering settings swaps the content of the **real** left sidebar (the prototype faked this with a fixed overlay because it could not drive the real sidebar — the build must swap actual Sidebar content). Title-bar drag must keep working **inside the takeover too** (the prototype keeps a drag region at the top of the settings rail). Inside settings: **no "Settings" title, no collapse toggle**; a ghost "**Back to app**" control with a left arrow lives at the top of the rail.
- **Search (day 1)** — a sidebar-embedded combobox on the InputGroup primitive (placeholder "Search settings…"), **not** the Command primitive (confirmed against t3code: Command is reserved for a ⌘K palette, which is out of scope). Typing replaces the section nav with a flat result list of matching settings — category icon + setting name + category label — matched case-insensitively over title + keywords. Selecting a result navigates to that section page, clears the query, scrolls the setting into view, and highlights it briefly (~1.6 s). The **main pane does not change while searching**. Empty: "No settings match."
- **IA (round 2 — supersedes the round-1 Appearance/Window/Scheduler/Budget sections)**: **General · Appearance · Engine**, landing on General.
  - **General → Window**: **Close to hide** — "Closing the window hides it and leaves the engine running." — a Switch.
  - **Appearance → Theme**: a system/light/dark picker of large mock-window preview tiles (ToggleGroup; System tile is half-light/half-dark; selected tile gets a primary ring), wired to the theme provider for real.
  - **Engine → Scheduler**: **Global concurrency** — "How many runs the scheduler keeps in flight across all workspaces." — and **Per-workspace concurrency** — "How many runs stay in flight inside a single workspace." — numeric steppers (min 1) on InputGroup.
  - **Engine → Budget**: **Daily budget** — "Spend ceiling per day before the engine pauses new work." — an InputGroup with `$` prefix and `/ day` suffix.
- **Page structure** — each category page: a big category header, then sub-section headers, each over a grouped divided-row card (Card + Item + Separator); rows are title + description left, control right; centered, max-width column. Built from existing primitives only — no bespoke form CSS.
- **Routing** — a real settings route plus per-section routes, so navigation is addressable; unknown sections redirect.
- **State wiring** — theme is real. Close-to-hide is main-process window behavior; scheduler limits are read-only from the scheduler read model today (the scheduling RPC only toggles running/paused); daily budget has no engine surface yet. Check contracts/engine for a config-write RPC and the typed IPC seam; if the write path is absent, wire theme for real, persist the rest locally behind a clearly-marked TODO, and cut the **"desktop preferences persistence seam"** follow-up ticket (define the write path: main-process IPC for close-to-hide, a daemon config RPC for limits/budget; seed the store from the real source). The open round-1 build (PR #44) already checked and found **no write path** — no config-write RPC for limits/budget and no typed IPC seam for window prefs — so expect the follow-up ticket to be needed.
- **Menus are intentionally opaque** — the merged menu fix did more than restore the open/close animations: it deliberately dropped the translucent-glass treatment and the item-highlight overrides for a plain opaque `bg-popover` menu. That is a recorded decision, not a regression to "fix" back while building here.
- **Settings needs no daemon connection** — theme and local preferences work offline; no degraded gate inside settings.
- **Reconcile open PR #44** — it implements the superseded round-1 design (Command-dialog search, "Settings" header in the rail, plain theme toggle, Appearance/Window/Scheduler/Budget sections, and a `command` + `dialog` primitive add). Its route-driven takeover, settings catalog (one source feeding search and card copy), preferences store, and route validation match the final design and are worth salvaging; its search UI, rail chrome, theme control, and IA must be reworked to round 2. Rework or close-and-recut — do not merge it as-is. Drop the `command`/`dialog` primitives if nothing else uses them.

### 8. UI primitives

- Add **checkbox** and **popover** to the UI package via the shadcn CLI (used by the winning Attention and Activity designs; today they exist only on prototype branches). The prototypes' `select` and `tabs` adds served losing variants only — do not add them.
- `InputGroup`, `Table`, `ToggleGroup`, and the chat primitives (message-scroller, message, bubble, marker, attachment, collapsible) are already on main.

### 9. Empty states (from #19)

- Keep the shared Empty primitive for every calm-empty state — the audit found it already consistent; per-surface empty copy belongs to each surface's design above. Optional nicety, not required: an inline/section Empty variant to replace the Feed's bespoke section-level empty note.

## Testing Decisions

- A good test exercises **external behavior only** — feed inputs through the public seam and assert on outputs; never assert on internal structure, intermediate state, or render internals.
- The highest existing seam in this area is the **pure fold/derivation layer** of the desktop renderer (plain functions from daemon read models to view models), and this spec deliberately routes its logic through that seam. Test there:
  - the degraded gate's `(enginePhase, boardResult) → treatment` map (all four states, the precedence between engine phase and stream result);
  - the unified renderer event source (per-tag human summaries, severity, low-signal classification, transition-only synthesis of lifecycle events, arrival-vs-real timestamps, the one-row-per-run collapse, buffer bounding);
  - the Attention fold (kind derivation, dedupe of both-kinds items, urgency sort, kind/workspace filter semantics where an empty set means all, segment counts);
  - the side-panel tab store (per-item tab identity, dedupe/focus, persistence, close behavior);
  - the settings search match (title + keyword matching, result grouping).
- Prior art: the existing renderer feature tests (the run-activity fold, the side-panel store, daemon-error mapping) and the contracts board-fold tests — all plain vitest on pure functions. Follow their shape.
- UI composition itself is validated by typecheck, biome, build, and the desktop test suite — the gate every ticket on this map used: desktop typecheck + biome clean, build green, desktop tests green.

## Out of Scope

- The **Lanes view** — cut from this effort and already deleted; revisit as a fresh effort only.
- A **chat-first home** / calm "What should we build" screen — the Feed keeps its mission-control layout.
- A **global command palette (⌘K)** — settings search is in scope; global search is not.
- **Design-system work** — shadcn primitives are used as-is.
- **Keyboard navigation and shortcuts** across the shell (revisit after the shell and panel land).
- **Workspace management UI** (add/remove workspaces) — a future Settings section.
- **Notifications and badging** (dock badge, system notifications for attention items) — needs its own grilling.
- A **structured halt reason** / wait-time field (`haltedSinceMillis`) on the needs-human read model — engine change, only if the bare reason enum proves too thin. (The tracker ticket URL, by contrast, **is** in scope — the Attention quick-open needs it.)
- A **durable event archive** in the daemon — the Activity tab is session-only.
- **In-app PR review/approve/merge** — noted future add; v1 opens the code host.
- A **logs surface** for the Broken state — possible later idea.
- The **desktop preferences persistence seam** — in scope only as far as checking for a write path and wiring what exists; if absent, it becomes its own follow-up ticket rather than blocking Settings.

## Further Notes

- **Primary sources**: branch `prototype/item-tab-layout` (`6ca32df`), branch `prototype/attention-cards` (`2c1bf37`, includes dev-only mock scenarios busy/decisions/prs/quiet/empty), branch `prototype/activity-two-zone` (`223fea1`, includes mock scenarios busy/calm/errors plus live), branch `prototype/settings-experience` (`c4cb842`), branch `prototype/feed-cards-sections` (already built). All are throwaway references — steal, don't promote. Losing variants are preserved on the branches deliberately.
- Prototype judgments were made at ~440 px side-panel width and against the maximized panel — sanity-check both when building.
- The Attention and Activity funnels share one filter pattern (funnel icon + fixed-width multi-select + slim banner + Clear); build it once.
- The Feed's queued/claimed read-model folds (`itemsWithPr`, `claimedItems`) were left orphaned by the Board/Inbox deletion for later tabs — the item tab and Attention builds may find them useful or may delete them.
- Wayfinder map: #7. Design decisions: #8–#20, #25–#27, #41 (and the consolidated Settings record on #17). Builds already landed: #35 (PR #36), PR #45, PR #46.


