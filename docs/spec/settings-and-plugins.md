# Settings, Plugins, and the Run Plan

The product and architecture spec for cogwork's unified local-first system for settings, Plugins,
Connections, and contributions, settled on wayfinder map
[#124](https://github.com/colonylabs/cogwork/issues/124) between 2026-08-24 and 2026-08-26. It resolves profile, runtime-host, repository, private-workspace,
Workflow, and Operation inputs into an engine-validated **Run Plan** for every Run; powers the
**Plugins**, **Customize**, **Connections**, and **Workspaces** surfaces; and defines storage,
migrations, and the cutover from today's drift-prone sources.

Every decision here was settled on the map; each section links the ticket or ADR that holds the
full reasoning. **This document is the index and the handoff — the tickets and ADRs are the
depth.** Where a ticket's resolution was later amended, this document states the current form and
the [supersession chain](#supersession-chain) says which act amended it.

## Problem Statement

Setting up and steering cogwork's agents today means editing executable TypeScript. A workspace is
a committed `*.workspace.ts` file holding absolute personal paths, a credential's env-var name, a
harness choice, concurrency, and per-operation model settings — a shape only its author can safely
touch, and one a cloned repository could abuse. Personal rules reach agents through a hard-coded
path in one person's checkout. Skills live in a directory an external tool writes, with no way to
see which ones a Run will receive or why. The daemon's scheduler numbers have three rival
authorities — a CLI flag, an in-memory setting that dies with the process, and the workspace file —
so the desktop's settings rows silently revert on every restart.

There is no one place to answer: what will this Run be given, who turned it on, where did it come
from, and what happens when it is missing? A required input that is absent fails at launch, after
tokens are spent, instead of before dispatch. Nothing distinguishes a file you wrote from a file a
cloned repository shipped. And the desktop app and the CLI have no shared management contract, so
anything one changes the other cannot see.

## Solution

One local-first system, shared by the desktop app and the CLI, with four ideas at its core:

1. **Files you author are contributions; presence is enablement.** You write Skills, Rules,
   Commands, and Subagents as files in one of three fixed **Authoring trees** — your user tree, a
   repository's committed tree, or a per-workspace private tree. Cogwork scans the trees; a file
   that exists is active. Only the kinds that execute or connect keep a switch, and only you can
   flip it — a repository may offer, never enable.
2. **Plugins are first-party packs that ship with cogwork.** Install and uninstall are the whole
   lifecycle. Installing is the trust act, so a Plugin's MCP server is on after install. An app
   update is the only thing that changes a Plugin's files, and it lands at load.
3. **Connections replace hand-edited credentials.** A card per external system — GitHub, Linear —
   established by browser login or API key, engine-owned, referenced by id. Establishing a
   Connection installs the one Plugin that requires it. Secrets never live in files or bundles.
4. **The Engine validates everything into a Run Plan before dispatch.** Every Run's inputs are
   resolved once, checked against required needs, and frozen with an embedded trace that answers
   "why is this value what it is". A Run that cannot be satisfied is rejected before it costs
   tokens, with every cause listed — it never parks the item waiting for a human.

All durable state a person writes lives in one **Control store** per machine, under `~/.cogwork`,
with engine-owned migrations that fail closed. The desktop app and the CLI drive the same closed
list of management acts over one RPC contract, and every act returns and publishes the same
picture, so the two clients can never drift.

## User Stories

### Authoring and enabling contributions

1. As an engineer, I want to drop a Skill file into `~/.agents/skills/` and have my next Run use
   it, so that giving an agent a Skill is writing a file, not running a ceremony.
2. As an engineer, I want a Skill committed to a repository's `.agents/` tree to reach Runs in
   that workspace automatically once I register it, so that a team repo can carry its own agent
   guidance.
3. As an engineer, I want repo-specific agent files that must not be committed to live in a
   private per-workspace tree, so that my personal tuning never lands in a colleague's clone.
4. As an engineer, I want my file and a repository's same-named file to be two distinct things
   with two identities, so that one switch never governs both.
5. As an engineer, I want a repository's shipped MCP server to arrive **off**, with a row that
   says the repository offers it and I can turn it on, so that cloning a repo never starts a
   process on my machine.
6. As an engineer, I want deleting a contribution file to be the way I turn it off, so that the
   system never carries a setting that disagrees with the disk.
7. As an engineer, I want to see which Authoring tree a contribution came from on its row, so
   that I can tell my own files from a repository's at a glance.

### Plugins

8. As an engineer, I want to install a first-party Plugin in one act and have its contributions
   active immediately, so that install is not followed by a scavenger hunt of switches.
9. As an engineer, I want to uninstall a Plugin and have every setting I wrote for it at my own
   Scopes deleted with it, so that no dead rows accumulate.
10. As an engineer, I want an app update to be the only thing that changes a Plugin's files, with
    the change landing on the next Run and never on one in flight, so that updates need no
    ceremony and running work is never mutated.
11. As an engineer, I want the Plugins surface to show what ships with cogwork but is not
    installed, so that discovery is a list I read, not a storefront I browse.
12. As an engineer, I want a Plugin whose required Connection is missing to install anyway and
    read *Connection needed*, so that being offline or abandoning a login never rolls back an
    install.

### Connections

13. As an engineer, I want a card per external system where I connect via browser login or API
    key, so that setting up Linear or GitHub is a click, not a hand-edited credential in a file.
14. As an engineer, I want establishing a Connection to install the Plugin that requires it and
    turn its contributions on, so that connecting a system is one act, not two.
15. As an engineer, I want uninstalling a tools Plugin to leave its Connection standing — with a
    notice saying so — so that removing a bundle never stops the daemon reconciling my tracker.
16. As an engineer, I want removing a Connection to remove the Plugins that require it and warn me
    about workspaces left dangling, so that the dependency arrow only ever cascades downward.
17. As an engineer, I want a grant revoked outside cogwork to surface as a card needing
    re-connect — with my install and settings untouched — so that recovering from revocation is
    one login, never a re-install.
18. As an engineer, I want one grant per system and account to serve every port and contribution
    that uses it, so that I authenticate once, not per consumer.

### Run Plans and enforcement

19. As an engineer, I want every Run's inputs validated before dispatch, so that a Run that cannot
    be satisfied is refused before it costs tokens.
20. As an engineer, I want a rejected Run to list **every** cause the resolution found, so that I
    fix the configuration once instead of replaying failures one at a time.
21. As an engineer, I want a rejection to surface its causes as current state on the availability
    read model — never as a durable record, and never parking the item for a human — so that a
    configuration gap does not masquerade as a judgment call and does not accumulate rows.
22. As an engineer, I want the Run Plan to embed its resolution trace — the winning value with its
    Scope, level, and source, the operator applied, the shadowed candidates, and the inadmissible
    entries dropped — so that "why did the agent have this?" is answerable after the fact, even
    after a Plugin update.
23. As an engineer, I want an Operation's availability reflected before scheduling, so that work
    requiring a server that is down is not repeatedly claimed and rejected.
24. As an engineer, I want a permission profile a Harness cannot honour to be a named refusal,
    never a silent downgrade, so that a read-only Run is actually read-only or loudly not.
25. As an engineer, I want same-named contributions from different sources to reach the Harness
    under names qualified by their Authority, so that nothing is silently dropped or renamed.

### Settings and scopes

26. As an engineer, I want to set model, effort, harness, and permission profile as a default, for
    one Workflow, or for one Operation — with the most specific winning — so that a default never
    outranks a value that names the work.
27. As an engineer, I want a committed repository file to be unable to choose my model or spend my
    tokens, so that cloning a repo never hands it my wallet.
28. As an engineer, I want an inadmissible committed value to be dropped with a diagnostic naming
    the file — never silently ignored, never a hard error — so that a colleague's commit cannot
    stop my work and cannot confuse it invisibly.
29. As an engineer, I want engine policy to refuse with its source named rather than silently
    override, so that a constrained setting is distinguishable from one I never set.

### Workspaces, the daemon, and the store

30. As an engineer, I want to register a workspace as an act — not a committed file — so that
    nothing in a repository decides what my machine orchestrates.
31. As an engineer, I want to re-bind a moved checkout without losing the workspace's identity or
    settings, so that moving a folder is not a divorce.
32. As an engineer, I want deregistering a workspace to remove its bindings, its overlay settings,
    and its private tree in one act — while keeping its Run history — so that cleanup is complete
    but the record of what happened survives.
33. As an engineer, I want the daemon's concurrency limits and daily budget to survive a restart,
    so that the numbers I set are the numbers that hold.
34. As an engineer, I want a failed store migration to stop dispatch — daemon up, RPC serving,
    store reported unavailable, evidence preserved — so that a bad update never runs agents
    against a corrupted store.
35. As an engineer, I want a one-act restore of the pre-migration copy, so that recovery from a
    bad migration is mine to invoke and cheap to perform.
36. As an engineer, I want every management act available from the CLI, grouped by subject, so
    that a headless machine over SSH is a first-class host.
37. As an engineer, I want the desktop app and the CLI to converge within one published event of
    any change, so that two clients never show two truths.
38. As an engineer, I want secrets to reach Runs by reference — a bundle names an env key, the
    engine supplies the value — so that no secret ever sits in a file, a bundle, or a log.

## Implementation Decisions

Do not re-derive these; each links its owner. Vocabulary throughout is the shared kernel glossary's
(`packages/contracts/CONTEXT.md`), which these decisions minted.

### The execution vocabulary ([#128](https://github.com/colonylabs/cogwork/issues/128))

One chain: **Workflow → Operation (+ Work Context) → Run Plan → Run.** A Workflow is a reusable
automation of Operations and Transitions; cogwork owns the graph today. An **Operation Definition**
is the engine-authored contract — behavior, defaults, required needs, Operating Instructions,
outcomes. **Operation Settings** are the scoped choices that configure it. **Operating
Instructions** (mandatory, engine-authored) are resolved separately from **Work Context** (the
work-specific facts for one Run). The **Run Plan** is the immutable, engine-validated resolution of
one Operation and its Work Context before dispatch; a **Run** executes one Plan. Retired: playbook,
playbook skill, lifecycle stage, run manifest.

### Two lists, no umbrella (ADR [0011](../adr/0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md), [#132](https://github.com/colonylabs/cogwork/issues/132))

**Contribution kinds** — what a person authors as a file and Customize shows as a row: **MCP
server, Skill, Subagent, Rules, Command, Hook.** **Run Plan members** — what the Engine resolves
and hands a Harness: Harness Adapter, Instructions, Tools, Skills, MCP, Subagents, Commands, Hooks,
Middleware, Sandbox (Workspace, Policy), Structured Output, Persistence, Connections, Messages,
Provenance. The lists differ deliberately: Rules is a kind that resolves into Instructions; Tools,
Connections, and Middleware are members never contributed. **"Capability" is retired**; name the
kind. No inter-Plugin dependencies exist. The manifest points at files; nothing is inlined.
`version` is optional on a Plugin; a provenance stamp is mandatory; no contribution carries its own
version. Schemas are layered: the Engine owns a per-kind envelope it always validates; the
Plugin-supplied settings-blob schema currently **governs an empty set** — if a first parameter ever
arrives, validation belongs at install and update, not at Run Plan resolution, and setup gains its
first step. The manifest's auth-recipe field stays **present and unused** — the rule (require,
never define) is what is decided, and it holds whether or not the field ever fills.

**Identity** is `<authority>/<kind>/<localName>`. Authority is where the bytes came from —
`plugin:<pluginId>`, `engine`, or `local:<tree>` — immutable, part of the identity, carried into
the Run Plan as provenance. The `local` qualifier names the Authoring tree: `local:user`,
`local:repo`, `local:private` ([#204](https://github.com/colonylabs/cogwork/issues/204), ADR 0011
amendment). Authority and Scope stay orthogonal: Authority is where the bytes came from, Scope is
where the setting lives, and an id never changes when a setting moves.

### Two settings families, four Scopes (ADR [0013](../adr/0013-two-settings-families-with-different-scope-sets.md), [#134](https://github.com/colonylabs/cogwork/issues/134))

Four Scopes — **Settings profile** (principal), **Runtime host** (machine), **Workspace input**
(repo, committed), **Private workspace overlay** (principal-owned, per-workspace, uncommitted).
Cogwork mints every Scope identity (`Principal` constant; `HostId` at the store's first open;
`WorkspaceId` at register; the overlay key is the pair). Checkout path is a re-binding hint, never
identity.

Two families with different Scope sets, and the empty cells are empty by decision:

| Setting | Scopes that may hold it |
|---|---|
| A contribution's on / off — **MCP server** (the only kind with one) | Settings profile · Private workspace overlay |
| An **Operation setting** (on / off, harness, model, effort, permission profile, bound contributions) | Settings profile · Private workspace overlay — plus Runtime host for `harness` only |

The Runtime host holds machine facts, not contributions. The Workspace input holds no Operation
settings (a cloned repo must not choose what you spend) and cannot enable an executing kind (it may
offer — shipping a file is shipping data — but never start a process on your machine). An Operation
setting is written as a **default**, for one **Workflow**, or for one **Operation**; the most
specific wins before Scope is consulted. A contribution's on / off has no levels; per-Operation
enablement is **binding**, an Operation setting. On and off are the only values — absence shadows
nothing.

**Resolution** is a triple *(scope set, operator, direction)*; operators are `override-scalar`,
`append-sources`, `union-values`, `constrain` (`merge-by-key` retired — composing the contribution
set across Scopes is a union with nothing to reconcile, and a single identity resolves whole).
Direction, low to high: Settings profile → Runtime host → Workspace input → Private workspace
overlay; no kind inverts it — trust rides in the scope set instead. **One Engine ceiling**: engine
policy constrains rather than overrides and names its source; an Operation Definition's lock on a
setting *is* Engine policy, not a second mechanism.

**Four conflict classes**, assigned by when the failure is knowable: *inadmissible* and *dangling*
(load-time diagnostics, value dropped, file named), *ambiguous* (load-time error scoped to the
file; since #204 it narrows to a genuine duplicate — two install records under one `pluginId`),
*unsatisfiable* (the only one that waits for a Run; a Run Plan rejection). The resolution trace is
embedded in every Run Plan, never recomputed.

### Authoring trees and presence-as-enablement (ADR [0018](../adr/0018-contribution-files-live-in-three-authoring-trees.md), [#127](https://github.com/colonylabs/cogwork/issues/127))

A person authors contribution files in three fixed trees, one per Scope that can hold them:
`~/.agents/` (Settings profile), `<repo>/.agents/` (Workspace input),
`~/.cogwork/workspaces/<WorkspaceId>/` (Private workspace overlay). The Runtime host has none.
Cogwork **scans** the trees; a found file is a contribution with the tree's `local:` Authority — no
install, no manifest, no record. `~/.agents/` is shared with the harnesses on purpose (Codex and
Cursor already read `~/.agents/skills`), so a Skill there serves Runs and interactive sessions
alike. The trees are fixed; the only thing a person points cogwork at is a workspace.

**Presence is enablement for the four non-executing kinds.** Skill, Rules, Command, and Subagent
have no setting: they exist or they do not. MCP server keeps its switch and its scope set; **Hook
is deferred whole** (a named kind; no cross-harness projection designed; no Customize row; no Scope
set). Registering a workspace is the trust act that admits its repository's files — taken
knowingly: text sits at the same trust level as the repo's `AGENTS.md`, already read ambiently.
Two trees may hold the same local name; both are distinct identities, both reach the Harness, and
cogwork reconciles nothing.

**The Engine collects Rules and does not read them.** It decides on / off, glob matching, and
ladder position; severity and contradictions are the author's. Instruction precedence, general to
specific: global Rules → repo `AGENTS.md` → repo Rules → private-overlay Rules → Operating
Instructions, last and highest. Rules can never satisfy a required need.

`~/.cogwork/` is the **provision root**, distinct from the trees: identity-keyed bundle bytes,
written by the Engine, authored by nobody. **Install is for bytes that came from somewhere else; a
person installs nothing they wrote.**

### Plugins: first-party, two acts (ADR [0014](../adr/0014-plugin-install-is-machine-local-and-the-only-plugin-level-state.md) as amended, [#125](https://github.com/colonylabs/cogwork/issues/125), [#135](https://github.com/colonylabs/cogwork/issues/135), [#205](https://github.com/colonylabs/cogwork/issues/205))

**Every Plugin ships with cogwork.** Nothing is fetched; nothing third-party can be added. The
**Plugin catalog** is a first-party document on disk listing what ships. The Plugin acts are
**install** and **uninstall** — the whole lifecycle. The **install record** is the authority for
*installed*, in the Settings profile, keyed by `pluginId` alone; an install is machine-local, and
no design may assume synchronization. Provision is atomic (write elsewhere, swap in), keyed by
resolved identity, so a half-written bundle is unrepresentable and an update never mutates a key a
running Run reads.

**There is no Plugin-level on / off** — a deliberate divergence from Codex, whose plugin is an
application needing a second word for *off*; cogwork follows Cursor's collection-of-files model,
where a file not on disk is already off. One rule covers the product: presence is enablement, in a
tree and in the provision root alike. **After install a Plugin's MCP server is on** — installing is
the trust act — and its file kinds are on disk and therefore active. The default follows the
Authority, not the kind: a `local:repo` MCP server still starts off. Where a Plugin's server cannot
run yet, that is **MCP server readiness**, not an on / off.

**Struck, not deferred** (recorded so it is not re-derived): the catalog fetch, the computed
digest, the `active`/`deprecated`/`deleted` status set, the staged-update ceremony
(stage/accept/decline), the install record's `revision` field, and the **Plugin source** field.
All served an installable world cogwork is not in; if third-party install ever arrives it gets a
fresh decision. An app update is the only thing that changes a Plugin's files, and it lands at
load: the next Run reads what is on disk, a Run in flight keeps what it was given (the frozen Run
Plan guarantees it). A contribution an app update drops has its setting deleted, exactly as
uninstall deletes it — no dead rows are retained for a rollback nobody performs. **Partial install
is per-contribution**: an unparseable manifest installs nothing (the manifest carries the
identity), while a malformed pointed-at file yields no contribution — it is simply not a member of
the union, any setting written for it is *dangling*, and Customize shows the row honestly: *this
Plugin ships this Hook; it failed to load; here is the file*. Uninstall removes the record now; the
bytes become the reclaimer's — **uninstall does not free disk immediately**.

Surviving trust decisions from #135, independent of where bytes come from: the **Engine ceiling**
requires a non-interactive turn and the Operation's locked read/write posture. Read only also
requires worktree confinement. ADR 0025 permits Full to rely on a runner's declared native trust
boundary. Finer enforcement may be coarse only with its actual fidelity recorded **and no client
presenting it as exact**.
**Nothing reaches a contributed Hook's or MCP server's `command`, and the asymmetry is
principled**: the hard-deny list guards a fallible model, not an adversarial one, and a bundle may
ship the very script its Hook invokes — so a `command` allowlist would be theater. Executable
extensions exist in this destination: ADR 0006's data-not-code line governs cogwork's own config,
not what an installed Plugin runs in a child process. **A bundle names an env key; the engine
supplies the value; a bare `${NAME}` with no reference behind it is inadmissible** — a
shell-sourced secret is unrepresentable rather than forbidden. Uninstall deletes every setting at every principal-owned
Scope; committed Workspace input values survive as *dangling*. `localName` is a stable contract —
a rename is a drop plus an add.

### Connections (ADR [0017](../adr/0017-connections-are-engine-owned-and-pair-with-one-plugin.md), [#172](https://github.com/colonylabs/cogwork/issues/172))

**A Connection and a Plugin are two concepts**, cut by two cases neither set contains: a
Rules-only Plugin authenticates nothing, and GitHub is a Connection with no contributions. A
Connection is **engine-owned**: record in the Control store (id, system, account, status), secret
in the Credential store, keyed by **system and account** (`linear/acme`), one account per system
surfaced today. It has **no Scope** — reference is not scoping; a workspace references one by id
and a repository can never establish or override one. One grant serves every port on one account.
Establishment accepts any source the Credential store accepts — browser login where offered, API
key where not; an existing env-var token is a valid established Connection, so the cutover needs no
re-authentication.

**No issue tracker role is Plugin-supplied** — not sensor, not work-item identity, not
coordination store. Every external system the Engine reads is an Engine port over a Connection. A
Plugin may **require** a Connection by id from the Engine's known set and may never define one.
**One Connection is required by at most one first-party Plugin**, which is what makes "the Plugin
that requires Linear" derivable from the existing requirements field — no new field, no pairing
table. Two first-party Plugins requiring one Connection is knowable with the manifests in hand, so
it is a load-time diagnostic, never a Run Plan rejection. Reopen trigger, recorded: a second first-party requirer, or a marketplace, narrows the rule
without a data migration.

Lifecycle: **establishing a Connection installs the Plugin that requires it** (a one-time act, not
an invariant — "Linear as the tracker without the Linear tools" stays reachable). **Install is
never blocked on a Connection**; an abandoned login leaves the install standing and the row reading
*Connection needed*. **Removal cascades down the dependency arrow, never up**: removing a
Connection removes each Plugin requiring it and leaves bound workspaces *dangling* with a warning
naming them; uninstalling a Plugin leaves the Connection standing, with a notice, and never offers
to remove it. **Revocation is a state, not an act**: a grant revoked outside cogwork flips
**Connection readiness**, reconcile skips and reports, a requiring Run Plan rejects, and the card
reads *re-connect* — install records and settings untouched. Connection readiness is its own term:
an input to MCP server readiness for a contributed server, standing alone for an Engine port; no
`Readiness` umbrella exists. A provider key is not a Connection — it buys inference, not access to
the work.

### Run Plan resolution ([#130](https://github.com/colonylabs/cogwork/issues/130))

**Two paths into a Run Plan: on / off is the entry gate, and a binding is a designation.** Every
contribution that is on flows into every Run Plan for its workspace; a binding only says which
contribution serves an Operation Definition's declared need. **No mechanism narrows contributions
per Operation** — lazy tool discovery is the answer to context cost, not narrowing. **Every
declared need is required**; there is no optional need. **A need is a named slot carrying a kind**:
an Operation Definition never names a concrete `<authority>/<kind>/<localName>` — Operation
Settings bind one to the slot. Six kinds are bindable as needs: MCP server, Skill, Subagent,
Command, Hook, Connection. `unsatisfiable` has three reasons: unbound, bound but not available,
bound but not ready.

**Refusal and rejection are two shapes.** A refusal constrains a value, names its source, and the
Run proceeds. A rejection ends the Run before dispatch and carries **every** cause the resolution
evaluated — never just the first. A rejection writes no attempt record, never hands off, and never
parks the item; it is not a prepare failure. **A rejection leaves nothing durable, by design.**
Its causes and trace live on the availability read model — per (workspace, Operation), riding the
published picture, current rather than historical, superseded rather than accumulated. No
diagnostic survives a restart: a cold daemon recomputes the load-time conflict classes on its first
tick, and reports readiness as unknown-means-available. Preflight also checks the three Runtime
host facts nothing declares: the bound checkout path exists, the selected Harness is installed, and
its credential resolves. **MCP server readiness is evaluated for every projected server** — only a
required server's failure is `unsatisfiable`; an optional server that is not ready is a member
recorded with its reason. A permission profile the Harness cannot honour is a refusal with a named
source, never a silent downgrade; each runner declares statically which profiles its boundary can
enforce.

**Projection is runner-declared, at registration.** A runner never drops a member at render time;
the engine decides the consequence (required → unsatisfiable; optional → recorded
projected-nowhere with its reason). **Projected names are always qualified**, derived from identity
alone — injective across the Plan, carrying the Authority a person can read, recorded in
Provenance. The qualified name applies to the server name the engine hands the Harness, not only to
tool names. Constraint to carry: Codex caps model-visible tool names at **128 bytes** and truncates
past it — always-qualifying spends that budget, so the scheme must fit inside it.

**Work Context splits.** The Plan embeds the facts the Engine gated on — the reconcile snapshot's
roles, assignees, blockers, claim, priority, PR summary, stamped with snapshot generation and
observed-at — and references the prose, which stays a live read via tools. **Messages is a Run
Plan member**: the resolved user turn, named after TanStack AI, sibling of the instruction layers.
**Provenance** is the one member never projected: a flat list of separately-named records — the
resolution trace, the provenance stamps (declared version or content revision, per source;
engine-authored members take content revisions, never the app build), the projected names, the
projection dispositions, the observation identity.

**Availability gates in `classify`**, as an input, exactly like the assignee allowlist — `classify`
stays pure. The readiness conclusion is produced at resolution, held in memory, disposable: unknown
means available; a running server's open session is the signal; a failure expires on the Cooldown
window and a settings edit invalidates it at once. The executor's prologue is **re-check → claim →
worktree → dispatch**, and a fresh candidate that cannot run **declines** before the claim, so no
tracker-visible claim is taken for a Run that never existed. On resume, the availability check runs
in Claim recovery before Admit — ordered **ahead of the crash-cap branch**, so the crash-loop
hand-off is unreachable for an unsatisfiable need by construction; a rejected resume reuses
recovery's existing stale path: note the cause, release the claim, no attempt record.

**A Run Plan is frozen at acceptance.** Resolution happens once, in the executor, immediately
before dispatch; a settings edit, Plugin update, landed commit, uninstall, or deregister changes
nothing about a dispatched Run — the destructive acts **decline future picks and never reach into a
Run in flight**, which finishes and writes its outcome exactly as it would have. There is no queued
Run. Replay means re-read — reconstruction for a human, never
re-dispatch. One Plan per Run, keyed by `RunId`; no minted `RunPlanId`.

### The Control store (ADR [0015](../adr/0015-one-control-store-with-engine-owned-migrations.md), [#126](https://github.com/colonylabs/cogwork/issues/126))

**One SQLite database per machine**, at `~/.cogwork` (not Electron `userData` — a headless daemon
over SSH has no `userData`). It holds install records, Connection records, settings at every Scope
that is not a file, Runtime host bindings, minted Scope identities, the daemon's runtime limits,
store metadata, and the run history that was `runs.db` — the **Run ledger** is now a region of the
store, disposable by policy in the adapter (run-event writes swallow-and-continue; authoritative
writes raise and carry an expected revision). One file, one migration history, one backup, one
lock. The split-store alternative was overruled on precedent: a split compounds and cannot be
un-split when hosting arrives.

**The engine owns the migration loop**; Drizzle stays the query layer and its runtime `migrate()`
is never called (rejected on installed-code evidence). A migration is a TypeScript module;
`drizzle-kit` is a development-time tool only — `push` against the developer's disposable database,
`generate` produces the SQL the module is generated from; only the module ships. Boot: acquire the
lock, check compatibility, copy via `VACUUM INTO` only when a migration is pending, migrate,
validate, then dispatch. **Failure is closed**: the daemon starts, serves RPC, reports the store
unavailable, dispatches nothing; the failed database is preserved as evidence. Restore of the
pre-migration copy is a person's act. Retention on run events is mandatory — the copy is on the
boot path. The daemon's limits (global concurrency, per-workspace concurrency, daily budget) are
durable rows with a forced write order — row, then the in-memory value, then publish — and are
**not** on the Scope axis: one machine holds one value with no rival. Scheduling running/paused
stays a live control that resets to paused at launch.

### The management contract (ADR [0016](../adr/0016-one-management-contract-for-the-app-and-the-cli.md) as amended, [#133](https://github.com/colonylabs/cogwork/issues/133))

**Twelve acts across six subjects, and the list is closed:**

| Subject | Acts |
|---|---|
| A Plugin, keyed by `pluginId` | install · uninstall |
| A Connection, keyed by system and account | establish · re-connect · remove |
| `(contribution identity, Scope)` | set or clear a contribution's on / off |
| `(Operation setting, level, Scope)` | set or clear an Operation setting |
| A workspace | register · deregister · re-bind the checkout path |
| The daemon's runtime limits | set a limit |
| The Control store | restore the pre-migration copy |

Absent by decision: `pin` (struck permanently — no harness exposes version pinning to a person, and
there is no separately-installed bundle to decline updates to), minting a Scope identity (each is
minted elsewhere), and the four update acts (struck with the fetch machinery). `CancelRun`,
`Reclassify`, and `SetScheduling` are neighbours in the same RPC group, not members — they change
what the daemon is doing now, not what it is configured to be.

**The settings picture is one whole value on two carriers.** Everything the Control store owns
rides one new `DaemonEvent` member — **`ControlStoreChanged`** — published whole; the committed
Workspace input's scanned contributions and diagnostics ride `WorkspaceState.Registered`, recomputed on
the reconcile tick, because the Authoring tree is canonical and the store may never hold a competing
copy. The picture carries **rows, not effective values**: the ladder-rendering resolver is authored
once in the shared kernel and runs on each client. Named cost: two resolvers — the engine's (builds
the Run Plan, embeds the trace) and the kernel's (renders the ladder) — tested against the same
table.

**A write refuses what is enumerable from engine data in memory and accepts what depends on
disk**, reporting the latter as a diagnostic on the picture. ADR 0013's empty cells are
unrepresentable in the payload schema. **Deregister cascades** the workspace record, its Runtime
host binding, its overlay rows, and its private tree in one transaction — never Run history.
Re-bind writes the checkout path alone; identity survives a move. **There is no queued Run**, so a
settings edit invalidates nothing; the next tick resolves differently. **There is no restart
tier**: no act waits for a daemon restart — the workspace registry is a cell folded from events the
code already emits, and restore is an in-process pass that never pauses the scheduler. **Install is
provision-then-commit** — the filesystem effect first, then one store transaction, so a crash
leaves an unreferenced identity-keyed directory for the reclaimer rather than a record naming bytes
that do not exist. **Last write wins**, without
exception — every command returns the new picture and publishes the same value, so a stale panel
corrects within one event. **Every act has a CLI form**, grouped by subject; a database created the
obligation, since nobody hand-edits SQLite. Without a daemon the CLI opens the store read-only and
reports derived sections as *needs a daemon* — never omitted, never guessed; auto-starting a daemon
is rejected. Connection remove carries the *dangling* warning naming affected workspaces, in both
clients.

### Surfaces ([#131](https://github.com/colonylabs/cogwork/issues/131), PR [#215](https://github.com/colonylabs/cogwork/pull/215); names per the glossary)

Four surfaces, each owning a disjoint act set the commands enforce (the write split is a
client-surface rule; the daemon sees one `Principal`):

- **Plugins** — membership: install, uninstall, and the setup that follows. Sections: Needs
  Attention, Installed, Catalog. Uninstall shows the still-established-Connection notice.
- **Customize** — contribution settings: the MCP server toggle (the only toggle in the product —
  off is a greyed row with a *Disabled* pill, never a section; grouping is the Engine's conclusion,
  Needs Attention / Ready, never the person's choice) and Operation settings. The four file kinds
  render read-only rows showing what exists and which tree it came from. Kind is a facet and the
  route; place is a union filter over fully-named trees. **The levels are places a file lives, not
  a precedence ladder** — five prototype variants failed treating Scope as a cascade; once levels
  are places, the write-target mode disappears and ADR 0013's direction demotes to a badge on the
  rare row where one identity carries a setting in two places. Grouping is per facet: status for
  Plugins and MCP servers, author for the four file kinds. An MCP server gets a dialog; everything
  else opens as a file. Copy names the audience: User / Everyone / Just me.
- **Connections** — establishment: connect, re-connect, remove. One card per system, no container
  noun. A not-ready card reads *re-connect*, never *removed*; a Connection with no Plugin (GitHub)
  must not look broken.
- **Workspaces** — what the daemon operates over and under on this machine: register, deregister,
  re-bind, the daemon's runtime limits, and Control store restore. None of its five acts touches a
  Scope-held setting. (Named by the 2026-08-26 domain-modeling act; *Engine* was the rejected
  runner-up.) Its UI was built early in the prototype and then removed from PR #215; building it
  for real is implementation work.

In the shipped prototype, the Plugins view sits **inside Customize's pill row** per the
maintainer's direction — responsibility unchanged, but it does not behave like a kind facet (no
place filters it). An implementer wiring real data extends that landed shape rather than building a
separate Plugins route.

No `…` row menu exists — the act list is closed and none of its members is "delete a file".

### The cutover ([#127](https://github.com/colonylabs/cogwork/issues/127), ADR 0018)

Amended by [#332](https://github.com/colonylabs/cogwork/issues/332): the Workspace input is only an
Authoring tree. It has no settings file. `worktrees.setup`, `worktrees.linkPaths`, and `mcpSkills`
move through `register` into the workspace record in the Control store.

By hand: **no importer** (two files load, on one machine), **no compatibility window** (the loader
dies in the same change that lands `register` — a window only creates the drift this work exists to
end), **no rollback** (fix forward). Exactly one ordered pair: the personal rules must be in
`~/.agents/rules/` and reaching Runs **before** the hard-coded path is struck from the engine's
implement skill. Everything else lands in any order.

| Source | Disposition |
|---|---|
| `*.workspace.ts` and their loader | **Retired.** `issueTracker`, `sourceControl`, `linearHistory`, `mcpSkills`, and all of `worktrees` become columns on the workspace record, off the Scope axis. Credentials become Connection references — an env-var token is already a valid establishment source. |
| Engine Operating Instructions | **Kept as is** — engine Authority, ships with the binary, in no tree. |
| `~/.agents/skills` | **Becomes the Settings profile tree.** Referenced where it lies, never copied. |
| Repository `.agents` inputs | **Becomes the Workspace input tree.** |
| Cursor Plugin caches | **Dropped from cogwork's view** — ambient to the harness only. |
| Hard-coded personal rules | **Retired**; the files become `local:user` Rules. |
| Provisioned `~/.cogwork` copies | **Kept, narrowed** to fetched bundles, identity-keyed. |
| External `sync` tool | **Out of scope** — it serves interactive sessions. `sync` stays the only writer to `~/.agents/`; cogwork reads and never writes. |

The Run Plan becomes sole authority over **required** needs, never over what a harness can see:
external CLI Harnesses keep reading their own stores, and nothing ambient can satisfy a required
need. Repo `AGENTS.md` is always layered, and the double read where a Harness rediscovers it is
tolerated.

## Testing Decisions

**What makes a good test here:** it exercises a decided contract at its seam — command in, picture
out; inputs in, Plan or rejection out — and never asserts on internals (which table a row landed
in, which private function ran). The decisions above are behavioral promises; the tests restate
them as tables of cases. Filesystem behavior runs against real temp directories and real SQLite
files, not mocks — several decisions (atomic provision, tree scanning, fail-closed boot) are
precisely about what disk does.

Three seams, highest first:

1. **The daemon management contract.** Every act in ADR 0016's closed list, driven as a command
   through the RPC layer: assert the returned picture, the published `ControlStoreChanged` /
   `WorkspaceChanged` event, and the refuse-versus-accept axis (enumerable-in-memory faults refuse;
   disk-dependent faults accept and surface as diagnostics). Covers the deregister cascade, re-bind
   identity survival, the limits write order, install/uninstall against a temp provision root, and
   last-write-wins convergence. Prior art: the board-fold tests in the shared kernel, which already
   test this event-in, state-out shape.
2. **Run Plan resolution.** Given Control store rows, Authoring-tree contents, and an Operation
   Definition: assert the resolved Plan (members, projected names, embedded trace, Work Context
   split) or the rejection with **every** cause. ADR 0016 already fixed the harness: the engine's
   resolver and the shared kernel's ladder resolver are **tested against the same table** of
   scope-set cases, so one table of cases — the two families, the empty cells, the four conflict
   classes, offer-versus-enable, Authority-qualified duplicates — feeds both.
3. **The Control store boot loop.** Real database files: pending migration triggers the copy then
   migrates; a poisoned store fails closed (daemon serves RPC, dispatch stopped, evidence
   preserved); restore re-seeds; the generated migration module matches its committed SQL.

UI surfaces keep the prototype's existing component tests (PR #215), swapping placeholder fixtures
for the kernel fold and resolver at the AtomRpc seam — no new UI seam is introduced.

## Out of Scope

Ruled out by the map's destination; return only as fresh efforts if the destination is redrawn.

- **Remote backend, authentication, tenancy, and organizations.** Local-only now, hosted-ready at
  the expensive seams; nothing multi-user is built.
- **Remote ownership, team sharing, and cloud synchronization** — including portable Plugin
  installs (no harness synchronizes installs; machine-local until this lands) and portable
  Connections (machine-level, no Scope; cross-machine establishment is the same seam).
- **Marketplace publishing, review, billing, and hosted catalog operations.** With them, everything
  #205 struck: the catalog fetch, digests, status sets, staged updates. Do not restore any of it on
  the argument that third-party install may arrive one day.
- **Remote execution hosts and hosted Connection execution.**
- **Interactive sessions**, and with them any machinery for a required Command (the kind stays in
  the need list; nothing is built).
- **Non-coding Workflow execution**, and contribution needs for non-coding Workflows beyond the
  Granola-to-ticket example.
- **Hook's setting and cross-harness projection** — the kind exists; everything else is deferred.
  Until designed, Hook has no Customize row and no Scope set.
- **`pin`** — closed unresolved and deleted from the glossary
  ([#203](https://github.com/colonylabs/cogwork/issues/203)); nothing in the corpus invites it
  back.
- **Whether a Plugin source belongs in the identity key** — ruled out while every Plugin ships
  with cogwork; the `pluginId`-alone install-record key stands
  ([#205](https://github.com/colonylabs/cogwork/issues/205), out-of-scope half).
- **Named workspace commands as Sandbox Policy subjects** (the retired `Script`) — returns when
  cogwork owns the policy layer.
- **Host-version compatibility declarations for Plugins** — unsolved across the field; only
  matters if Plugins go external.
- **Fixing today's Cursor/provider projection defects** — tracked separately, as are the two
  divergences #130 recorded (the Codex runner's unconditional `danger-full-access`, and the
  executor's insert-before-resolve).
- **Renaming the Private workspace overlay Scope** — a sharp, deliberately unticketed sweep
  (candidates weighed in [#204](https://github.com/colonylabs/cogwork/issues/204)), worth doing
  whenever the UI makes it visible.
- **Reclaiming superseded provisioned bytes** — owned by whoever implements ADR 0014's provision.
  The rule already decided: bytes at a key no install record has ever named may be deleted
  immediately; bytes at a key a record once named wait for the reclaimer.

## Further Notes

### Supersession chain

The Plugin-lifecycle decisions were made, then partially struck, in order:
[#125](https://github.com/colonylabs/cogwork/issues/125) (ADR 0014) →
[#135](https://github.com/colonylabs/cogwork/issues/135) (amendments into 0014) →
[#172](https://github.com/colonylabs/cogwork/issues/172) (ADR 0017) →
[#205](https://github.com/colonylabs/cogwork/issues/205) (amendments to 0014/0016/0017, plus
corrected lines in 0011 and 0018). **Where they conflict, #205 is current.** The invariants that survive the whole chain: install is
machine-local and keyed by `pluginId` alone; a bundle names an env key and the engine holds the
value; the Engine ceiling's three hard postures; Connections are engine-owned with no Scope and a
one-to-one first-party pairing; removal cascades Connection → Plugin, never the reverse.

### Relation to `next-phase.md`

That spec (map [#159](https://github.com/colonylabs/cogwork/issues/159)) listed
"settings-as-data migration" under *Explicitly later*. This document is that item arriving. Its
three-role tracker seam is held exactly as written — ADR 0017 only fixes that a Plugin lands on the
contributions side of it. Its per-workspace policy override ("waits for settings-as-data") now has
its substrate: the permission profile is an Operation setting.

### Sequencing note for ticket authoring

This spec deliberately contains no roadmap — turning it into tickets is the next act. Three
ordering facts worth carrying into that act: the cutover's one ordered pair (personal rules reach
`~/.agents/rules/` before the hard-coded path is struck); ADR 0016's observation that
`SchedulerStats.perWorkspace` stays dishonest until the `*.workspace.ts` loader dies — the file
wins until the cutover lands, so the read model must read the file's value until then; and that
nothing mints a `WorkspaceId` today (the workspace's configured name is the id), so deregister's
cascade semantics are weaker than they read until minting lands — re-registering the same name
would resurrect old run rows and orphaned overlay rows. Minting orders before deregister.

### Decision log

The full reasoning per area, in resolution order on the map:

| Area | Ticket / ADR |
|---|---|
| Workflow / Operation / Run vocabulary | [#128](https://github.com/colonylabs/cogwork/issues/128) |
| Storage research (prior art) | [#129](https://github.com/colonylabs/cogwork/issues/129) · `docs/research/desktop-settings-storage-updates.md` |
| Harness Plugin-model research | [#136](https://github.com/colonylabs/cogwork/issues/136) · `docs/research/agent-capability-product-models.md` |
| Contribution kinds and the Plugin contract | [#132](https://github.com/colonylabs/cogwork/issues/132) · ADR [0011](../adr/0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md) |
| Scopes, precedence, conflicts | [#134](https://github.com/colonylabs/cogwork/issues/134) · ADR [0013](../adr/0013-two-settings-families-with-different-scope-sets.md) |
| Plugin lifecycle | [#125](https://github.com/colonylabs/cogwork/issues/125) · ADR [0014](../adr/0014-plugin-install-is-machine-local-and-the-only-plugin-level-state.md) |
| Run Plan resolution | [#130](https://github.com/colonylabs/cogwork/issues/130) (resolution comment is the record) |
| Plugin trust, permissions, secrets | [#135](https://github.com/colonylabs/cogwork/issues/135) (folded into ADR 0014) |
| Control store and migrations | [#126](https://github.com/colonylabs/cogwork/issues/126) · ADR [0015](../adr/0015-one-control-store-with-engine-owned-migrations.md) |
| Connections | [#172](https://github.com/colonylabs/cogwork/issues/172) · ADR [0017](../adr/0017-connections-are-engine-owned-and-pair-with-one-plugin.md) |
| App and CLI management contract | [#133](https://github.com/colonylabs/cogwork/issues/133) · ADR [0016](../adr/0016-one-management-contract-for-the-app-and-the-cli.md) |
| Migration from today's sources | [#127](https://github.com/colonylabs/cogwork/issues/127) · ADR [0018](../adr/0018-contribution-files-live-in-three-authoring-trees.md) |
| The `local` Authority split | [#204](https://github.com/colonylabs/cogwork/issues/204) · ADR 0011 amendment |
| No Plugin-level on / off; fetch machinery struck | [#205](https://github.com/colonylabs/cogwork/issues/205) · ADR 0014/0016/0017 amendments |
| Plugins & Customize UI | [#131](https://github.com/colonylabs/cogwork/issues/131) · PR [#215](https://github.com/colonylabs/cogwork/pull/215) |
| `pin` | [#203](https://github.com/colonylabs/cogwork/issues/203) (closed unresolved; term deleted) |
| Surface and event names (Workspaces, `ControlStoreChanged`) | domain-modeling act 2026-08-26, recorded on [#133](https://github.com/colonylabs/cogwork/issues/133) and in ADR 0016 |
| Wayfinder map | [#124](https://github.com/colonylabs/cogwork/issues/124) |
