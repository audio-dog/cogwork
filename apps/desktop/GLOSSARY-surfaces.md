# Desktop glossary: Shell surfaces

Part of the [desktop glossary](./GLOSSARY.md).

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
Queued items stand in the order the scheduler will run them; below them, a collapsed **Waiting**
group holds admitted items that fail a Trigger filter, each with the engine's reason. Clicking a
card opens that item's tab in the side panel. It stays mission-control; there is no chat-first home.
_Avoid_: Dashboard, home screen, Board / Inbox (both deleted).

**Waiting**:
A Work item a Trigger admitted that now fails one of the Trigger's filters, such as an issue that
gained an open blocker. It holds no scheduler slot, and it returns to the queue when its filters
pass again.
_Avoid_: Blocked (the filter's condition, not the item's place), stuck (a park), queued (eligible now)

**Item tab**:
The **Subject surface** for a work item — a side-panel tab opened by clicking a work item card or
through **Open item**, one per work item, keyed to (workspace, work item), titled by its
`WorkItemId` (`#50`, `AUD-1`), deduped (a second open focuses the existing tab) and persistent (no
preview state). The canonical drill-in, and both a context and an action surface: identity, the
item's **queue state**, the item's Pull request, blockers, the live run transcript, previous
attempts, metadata, and **Start over** for a tracker item. The Pull-request section is labelled
plainly "Pull request" — never "PR gate".
_Avoid_: Detail tab (there is no single reusable one), preview tab, PR gate (as user-facing copy).

**Queue state**:
Where a work item stands with the engine, in the engine's words: running, queued (with its place),
waiting (with the failing filter, such as "blocked by #1050"), parked (with the park reason), or not
admitted (no Trigger matches it). The Item tab shows it so a person can see why an item is not running.
_Avoid_: Status (the daemon query), stage (the fixed pipeline's word)

**Open item**:
The Feed header field that opens an Item tab from a work item reference — `#1048`, `AUD-1`, or a
GitHub or Linear URL — and a Workspace, even when Cogwork has no record of the item. The CLI takes
the same references.
_Avoid_: Search (it resolves one reference, it does not query), go to, jump to

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

