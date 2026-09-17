# Contracts (shared kernel)

The Effect schemas that define the orchestration domain's shared vocabulary. Every other
orchestration context (`engine`, `cli`, `cursor-acp`) speaks these terms; this package owns them.
Definitions here are the source of truth — other contexts reference them rather than redefine.

## Language

### Work

**Issue tracker**:
The external system that is authoritative for backlog work — its items, their human-visible roles, and the coordination markers written back onto them. Configured per workspace; GitHub Issues and Linear are the adapters today. Renamed from "work source": once pull requests moved to their own port (the source control provider), what remained was purely the tracker.
_Avoid_: Work source, backlog, control-plane database, internal store

**Source control provider**:
The port that answers what trusted pull request belongs to each observed work item and what that PR's state is (checks, reviews, mergeable / base divergence, human comments, draft status). It resolves the PR by the item's link key. A coordination comment is not required for observation. A draft pull request remains linked but cannot trigger follow-up. Its narrow writes open a pull request and post the daemon's marked round summary. Coordination stays on the issue tracker; push and rebase stay with the agent. Chosen per workspace independently of the tracker; GitHub is the only provider today, and a GitHub issue tracker doubles as its own provider by default.
_Avoid_: Forge, code host, work source, git client (the HTTP client is a lower-level detail)

**Work item**:
A single unit of backlog work observed from an issue tracker, identified by a branded `WorkItemId` (e.g. a GitHub issue like `#13`, or a Linear identifier like `AUD-1`). Carries a title and, once observed, its roles, claim, and attempts; its pull request is resolved separately by the source control provider, not carried as a tracker property.
_Avoid_: Task, job, ticket (except when naming the tracker's own UI)

**Link key**:
The stable key tying a work item to its pull request across systems. GitHub numeric work items first match an open PR's GitHub-resolved closing reference (`Closes #N`); all items retain the `ticketSlug(item.id)` branch-prefix fallback (`fel-157-…`, `13-…`). The engine-cut branch remains stable because it derives from the immutable item id rather than the title. A same-repository closing-reference match carries its actual head branch into follow-up.
_Avoid_: PR reference, branch name (the full branch also carries a title slug that can drift)

**Workspace**:
A repo registered with the daemon under a minted `WorkspaceId`: a checkout path bound to an issue tracker and, optionally, a source control provider, plus workflow and operation settings. Checkout path is a re-binding hint, never identity. The unit of isolation and per-repo configuration.
When either Engine port uses GitHub, its `owner/repository` is runtime data derived from the checkout's selected worktree remote (`origin` by default). It is not a second configurable repository.
_Avoid_: Project; not pnpm's or TanStack's "workspace"

**Actor identity**:
Who the daemon acts *as* on a tracker — the authenticated account discovered from the bound **Connection**. It stamps claims and coordination comments and marks which comments and pull requests are the daemon's own. A workspace stores only the Connection binding; it has no separate actor selector.
_Avoid_: Bot id, owner (that's the allowlist), principal (that's an RPC caller)

**Assignee allowlist**:
`issueTracker.assigneeAllowlist` — an optional, non-empty-when-present list of tracker-native identities whose assigned tickets this workspace is *allowed to pick up*. Absent means no gate: every item is eligible, as before. Distinct from the actor identity: this is whose work the daemon may take, not who it acts as. Enforced in the engine's classification, not here.
_Avoid_: Assignee filter, owner list (it's an allowlist of several), actor

**Bot allowlist**:
`sourceControl.botAllowlist` (with the same fallback field on `issueTracker` the source-control target already borrows) — an optional, non-empty-when-present list of bot logins whose PR comments are trusted to *wake a follow-up*. Absent means the gate is off: no bot comment ever wakes one, exactly as before. A listed bot's comment is a wake signal only — it triggers a follow-up but does not reset the no-progress counter and can never set `/fresh`, so a stall still hands off to a human. It grants no steering: a trusted-bot finding is actionable context, like a failing check, never an instruction. Distinct from the actor identity (who the daemon acts as) and the assignee allowlist (whose tickets it may pick up).
_Avoid_: Bot filter, trusted authors (humans aren't on it), steering (a bot never steers)

### Configuration

**Control store**:
The daemon's single local database of everything Cogwork itself has been told on this machine — install records, Connection records, settings at every Scope that is not a file, Runtime host bindings, minted Scope identities, daemon runtime limits, and the store's own schema metadata. One database per machine, under `~/.cogwork`.
**It fails closed.** Unlike the Credential store it holds no secrets, and unlike the Run ledger it is not disposable — it is the authority the Engine resolves a Run Plan from, so a store it cannot open or trust stops dispatch rather than degrading it. The Run ledger's rows live here too, and stay disposable by policy rather than by sitting in a separate file. See ADR 0015.
_Avoid_: Settings store (it holds identities and bindings, not only settings), Run ledger (that one is disposable), Credential store (that one is secret), Settings profile (a Scope, not a store), database, config

**Settings profile**:
The principal-owned configuration source for installed plugins, connections, and defaults shared across workspaces and agent activity.
**Installing a Plugin writes here and nowhere else** — by elimination, since the Workspace input may not enable executable behaviour, the Runtime host holds no contributions, and the overlay is per-workspace while an install is not. "Shared across workspaces" is not shared across machines: nothing synchronizes a Settings profile today, so an install is machine-local in practice and no design may assume otherwise.
_Avoid_: User settings, global config, portable install

**Runtime host**:
The execution environment that binds portable configuration to machine-specific checkout paths, installed harnesses, and local credential storage.
_Avoid_: Device, machine config, workspace

**Workspace input**:
The committed contribution Scope represented solely by a registered repository's `.agents/` Authoring tree. It has no settings file. Workspace bindings, including worktree setup, linked paths, and MCP skills, live in the Control store and enter through `register`.
_Avoid_: Repo settings, private workspace overlay

**Private workspace overlay**:
Principal-owned configuration scoped to one workspace but stored outside its repository, for repo-specific customization that must not be committed.
_Avoid_: User-level repo input, workspace input, global config

**Authoring tree**:
The directory a person authors contribution files in. One per Scope that can hold contributions: `~/.agents/` for the **Settings profile**, `<repo>/.agents/` for the **Workspace input**, and `~/.cogwork/workspaces/<WorkspaceId>/` for the **Private workspace overlay**. The Runtime host has none. **The three trees are at fixed locations and a person cannot add or move one**; the only thing a person points Cogwork at is a workspace. Cogwork **scans** these trees, and what it finds is a contribution whose Authority names the tree it sat in — `local:user`, `local:repo`, or `local:private` — with no install, no manifest, and no record. `~/.agents/skills` is shared with the harnesses on purpose: Codex reads it at its user layer and Cursor uses it as its global skill directory, so a Skill placed there serves Runs and interactive sessions alike.
Distinct from the **provision root**, `~/.cogwork/`, which takes only bundle bytes, identity-keyed, written by the Engine and authored by nobody — including the bytes of a Plugin installed by establishing a **Connection**. Files a person wrote themselves, and a bundle they downloaded and unpacked, both land in a tree and carry a `local:` Authority — never a Plugin. Two trees may hold the same local name. They are **two identities**, because the tree is in the Authority; both reach the Harness and Cogwork reconciles nothing. See ADR 0018, and ADR 0011 for the split that makes them two.
_Avoid_: Provision root (the other one), config home, skill store, install cache, Scope (the tree belongs to a Scope; it is not one)

**Authority**:
Where a contribution's bytes came from — `plugin:<pluginId>`, `engine`, or `local:<tree>`, the tree being `user`, `repo`, or `private`. Part of a contribution's identity and immutable, carried into the Run Plan as provenance. Every contribution is identified as `<authority>/<kind>/<localName>`.
**`local` carries a qualifier for the same reason `plugin` does.** Unqualified, the MCP server you wrote and the one a cloned repository shipped share an identity — and an on / off is per identity, so one switch would govern both, which is the act ADR 0013's scope set exists to refuse. Each value names one **Authoring tree**, and `local:` stays a prefix test for *a file a person put here*. Codex reaches the same two words for the same two trees, `SkillScope::User` and `SkillScope::Repo`; `private` is named here because Codex has no such place. See ADR 0011.
**Authority and Scope stay orthogonal.** Authority is where the bytes came from; Scope is where the setting configuring it lives. An id never changes when a setting moves — a repo-tree MCP server is `local:repo` whether its switch sits at the Settings profile or the Private workspace overlay, and the four kinds with no setting have nothing that could move. The qualifiers deliberately do not repeat the Scope names. In Customize, the kind is the view and the authority is a badge on the row.
_Avoid_: Scope, source, owner, namespace, bare `local` (say which tree), `local:workspace` (collides with **Workspace input**, whose own _Avoid_ line already guards that confusion)

**Scope**:
Where a setting lives, and — for the three that hold contributions — where the contribution files live. Four of them: **Settings profile** (principal), **Runtime host** (machine), **Workspace input** (repo, committed), **Private workspace overlay** (principal-owned, per-workspace, uncommitted). Mutable, and never part of a contribution's identity.
**Not every Scope may hold every setting**, and the two settings families take different sets:

| Setting | Scopes that may hold it |
|---|---|
| A **contribution**'s on / off — MCP server | Settings profile · Private workspace overlay |
| An **Operation setting** | Settings profile · Private workspace overlay — plus Runtime host for `harness` only |

**Skill, Rules, Command and Subagent have no setting**: their Authoring tree is their enablement — see *Authoring tree*, and ADR 0018. Hook's row is deferred with the kind itself. A **Connection** is not on this axis at all: it has no Scope (ADR 0017).
The Runtime host holds machine facts — checkout paths, installed harnesses, credential storage location — not contributions, so it is the one Scope with no Authoring tree. The Workspace input is excluded from Operation settings because a repository you cloned must not choose the model you pay for, and from switching an MCP server on because it must not start a process on your machine — it may still *ship* the file, and `register` is the trust act that admits it. The excluded cells are empty by decision, not by omission.
There is **no collective noun** over either family; say `contribution` or `Operation setting`. Every candidate umbrella collided with a term already in this glossary.
_Avoid_: Authority, level, tier, target (an invented axis name — say default / Workflow / Operation)

**Resolution**:
How settings combine across Scopes, declared as a triple of **(scope set, operator, direction)** — both which Scopes may contribute *and* how they combine. Operators: `override-scalar`, `append-sources`, `union-values`, `constrain`.
Composing the **set** of contributions across Scopes is a `union-values`, never a merge. Identity carries Authority, so two contributions sharing a local name are two different things and Cogwork never reconciles them — true for `local` as well, since ADR 0011 put the Authoring tree in the Authority. Only a *single* identity with settings at more than one Scope resolves, by `override-scalar` down the direction below.
Direction, low to high: **Settings profile → Runtime host → Workspace input → Private workspace overlay**. No kind inverts it; trust is carried by the scope set instead, which is why a repository may hold a Hook file but may never turn one on.
_Avoid_: Merge (only one of the operators), precedence (only one axis of three), override, `merge-by-key` (retired — nothing field-merges across Scopes)

**Plugin**:
A first-party install-and-setup bundle. Its manifest **points at files** rather than inlining definitions, and declares which Connections it requires. **At most one first-party Plugin may require a given Connection**, so "the Plugin that requires Linear" names exactly one bundle and is derivable from that declaration alone — no field states the relation anywhere. `version` is optional — a Plugin is identified by its declared version or, absent one, by content revision. Each contribution has a type-specific identity qualified by the Plugin id; its human-owned settings and Engine-observed status remain separate.
A Plugin is **a collection of contributions and nothing more**: it contributes no behaviour of its own, so **there is no human-written Plugin on / off**. A Plugin's files are on disk or they are not, and `install` and `uninstall` are how a person writes that — the same rule as an **Authoring tree**, where authoring or deleting a file writes it. Where a Plugin-level "off" ever appears it is Engine-observed status, never a setting.
**Every Plugin ships with Cogwork.** Nothing is fetched and nothing third-party can be added, so uninstall is always reversible, offline. After an install a Plugin's **MCP server** is on, because installing is itself the trust act; its Skills, Rules, Commands and Subagents are on disk and therefore active, and have no setting at all. An app update is the only thing that changes a Plugin's files, and it lands at load with nothing to stage, accept or decline. See ADR 0014.
_Avoid_: Capability (retired — there is no umbrella noun), component, marketplace listing, Plugin enablement

**Install record**:
The authority for *this Plugin is installed*, held in the Settings profile. Keyed by `pluginId` alone, so **one resolved identity is installed at a time** — a second would give two contributions the same `<authority>/<kind>/<localName>`, which is the *ambiguous* class. It carries the resolved identity and the owning `Principal`. Reverting is an install at a named resolved identity, not a distinct operation, so no install history is kept.
An app update may change the resolved identity; nothing changes the `pluginId`. The `Plugin source` field and the `revision` field are **deleted** — every Plugin ships with Cogwork so the source had one value, and the revision guarded a two-command staged update that no longer exists. See ADR 0014's 2026-08-26 amendment.
_Avoid_: Plugin (the bundle, not the record), install cache, provisioned path, Plugin state, `pinned` (retired — see **Plugins**), `Plugin source` and `revision` (both retired — see ADR 0014)

**Plugin catalog**:
The one first-party document listing the Plugins on offer. It **ships with Cogwork**, as do the bundles it lists, so it is read from disk and never fetched. Each entry carries a name and a pointer to the bundle. It is also the name of the **Plugins** section holding the Plugins a person has not installed.
**Struck 2026-08-26, and not to be restored:** the computed digest, the `active` / `deprecated` / `deleted` status set, the network fetch and its cache, the stale and never-fetched arms, and the explicit refresh act. All of it served fetching bytes from elsewhere, which Cogwork does not do. Do not re-derive it from prior art or from a future in which third-party install exists; that future gets its own decision. See ADR 0014.
Qualified because bare *catalog* is spent twice — the desktop's **Surface catalog** and the engine's **Model catalog**.
_Avoid_: Marketplace, registry, Surface catalog, Model catalog, index

**Plugins**:
The surface that owns Plugin **membership** — install and uninstall, the whole of it — and the setup that follows an install. It and **Connections** are the only surfaces permitted to change what is installed. Its sections are **Needs Attention**, **Installed**, and **Catalog**. Uninstalling shows a notice naming any **Connection** the Plugin required as still established: removal cascades down the dependency arrow and never up, so Plugins never removes a Connection.
"Permitted" is a **client-surface rule, and the daemon does not enforce it**: it sees one `Principal` and cannot tell which panel called. What holds the split is the act list — membership and settings are different commands, so a surface that calls only settings commands has no branch that could change membership. Do not build a caller-kind check to satisfy this line.
_Avoid_: Marketplace, Customize, Plugin store; `pin` (retired — no harness exposes version pinning to a person); *stage*, *accept* and *decline* an update, and *refresh the catalog* (all four retired — nothing is fetched, so an app update is the only thing that changes a Plugin); and the lowercase plural *plugins*, which means the bundles

**Customize**:
The surface that owns **contribution settings** — an MCP server's on / off — and that renders every other contribution read-only. The kind is the view and the authority is a badge on the row — and for a `local:` row that badge *is* the Authoring tree, so it is shown once, not twice. Since ADR 0018 removed the setting from Skill, Rules, Command and Subagent, their rows show what exists and which tree it came from, and carry no toggle. An MCP server keeps its toggle, and a `local:repo` one is the offer-versus-enable row ADR 0013 owes: *this repository offers this. It is off. You can turn it on.* The MCP server view groups by the Engine's conclusion — **Needs Attention** and **Ready** — never by the person's choice: a server switched off greys out and takes a *Disabled* pill in place, so it is switched back on where it was left. It may show a Plugin-owned row's status, including one that failed to load, and it may **never** write membership or credential state: authority is part of a contribution's immutable identity, so the surface that renders authority is the wrong place to change it. As with **Plugins**, "never" is a client-surface rule the daemon does not enforce.
_Avoid_: Plugins, Settings, preferences

**Connections**:
The surface where a person **connects**, **re-connects**, or removes a system, with one card per system and no container noun over it. It may write Plugin membership, but only this way: **connecting installs the Plugin that requires the Connection.** At most one first-party Plugin requires a given Connection, which is what makes that Plugin derivable. No noun is minted for the act.
_Avoid_: Integration, connector, Customize, Plugins, setup wizard, *paired install* (retired — it never said what was paired with what, and named an act nobody refers to twice)

**Workspaces**:
The surface that owns what the daemon operates over and under on this machine: register, update and deregister a **Workspace**, re-bind its checkout path, set its Operation settings, and set the daemon's runtime limits. `WorkspaceState.Registered` publishes the complete stored registration record. Update replaces its mutable non-path columns without touching Private workspace overlay rows. Named for its dominant subject; Operation settings live with the Workspace whose Runs they govern, while the workspace record's columns and the limits are machine facts (ADR 0016). (Restoring the **Control store**'s pre-migration copy was withdrawn with ADR 0015's 2026-08-27 amendment.)
**Register is the trust act.** Registering admits the repository's Workspace input Authoring tree — see **Scope** and ADR 0018. There is no repository settings file behind this surface: `register` writes the workspace record instead.
_Avoid_: Settings (already on Customize's _Avoid_ line), Engine (the machinery being managed, not a pane), Daemon, Workspace (the singular is the registered repo, not the surface), machine config

**Contribution kind**:
One of the six types a Plugin may bundle and Customize may show: **MCP server, Skill, Subagent, Rules, Command, Hook**. The test is that a contribution kind is authored by a human as a file and renders as a row in Customize. Everything else an agent receives is engine-owned and appears only as a Run Plan member — Tools, Connections, Middleware, Operating Instructions, Work Context, Sandbox Policy, Harness are all deliberately *not* contribution kinds.
Only the kinds that **execute or connect** carry a setting. **MCP server** has one — on or off, written as a default and nowhere else. **Skill, Rules, Command and Subagent** have none at all: they exist or they do not, and the Authoring tree a file sits in says everything an on / off could say (ADR 0018). **Hook** is deferred — it stays a named kind with its setting question open, because no cross-harness projection has been designed. Everything else about a contribution lives in its file. Turning it on for one Workflow or one Operation is not expressed here; that is **binding**, an Operation setting.
_Avoid_: Capability, Run Plan member (the two lists differ — Rules is a kind but resolves into Instructions; Tools is a member but is never contributed), per-Operation enablement (say binding)

**Connection**:
The established, authenticated binding to one external system, keyed by **system and account** (`linear/acme`, `github/octocat`) — engine-owned, and not a contribution kind. It is never the credential itself: its record lives in the Control store (id, system, account, status) and its secret or source marker in the Credential store, reaching a Run over a channel that is never persisted to the run ledger or event log. Both a Plugin's contributions and the Engine's own ports — the issue tracker, the source control provider — authenticate through one and reference it **by id**. A Plugin may *require* a Connection; it may never define one.
**A Connection has no Scope**, and reference is not scoping: it is machine-level, a workspace references one, and a repository can never connect or override one. One grant serves every port on one account. At connect time, the system itself has to accept the credential before anything is written. GitHub reports the account from the accepted credential; a person never types it. Linear keeps its typed account. At run time, the Credential store acquires the current credential from the selected source. A refused connect or re-connect leaves the credential it would have replaced untouched. Removal cascades to each Plugin that requires it and leaves a bound workspace *dangling*; a grant revoked outside Cogwork is a readiness state, not a removal. See ADR 0017.
_Avoid_: Plugin (a Plugin requires a Connection, never contains one), credential (that is the secret it holds), MCP server, contribution kind, provider key (that one buys inference, not access to the work), Integration, connector

**Connection readiness**:
The Engine-owned conclusion that a Connection is established, unrevoked, and usable. It is an **input** to MCP server readiness for a contributed server that requires one, and it stands alone for an Engine port, where it gates the reconcile heartbeat. Deliberately **not** generalized: there is no `Readiness` umbrella, because the two are not peers — one feeds the other.
_Avoid_: Readiness (unqualified), MCP server readiness, established (one of its inputs)

**Tool**:
A typed function an agent may call during a Run. A Tool may be engine-owned, provider-native, or exposed by an MCP server, but its source remains explicit.
_Avoid_: MCP server (one server may expose many Tools), Command

**Skill**:
A discoverable package of instructions and supporting resources an agent may use during a Run. It remains distinct from mandatory Operating Instructions.
_Avoid_: Operating-instructions package, MCP server, Plugin

**MCP server**:
One configured Model Context Protocol server instance made available to a Run so its Tools, resources, and prompts can be used, identified by a Cogwork-owned `McpServerId`. It retains the verified MCP Registry name/version as provenance when available; runtime `serverInfo` is observed metadata, never the configured identity.
_Avoid_: MCP skill, Tool, Connection, Plugin

**MCP server readiness**:
The Engine-owned conclusion that a configured MCP server is enabled, launchable or reachable, authenticated, protocol-compatible, exposes the expected MCP features, and can be projected by the selected Harness. Its *authenticated* input is **Connection readiness** when the server requires a Connection. Required servers must be ready before a Run Plan is accepted; clients use the same result and reason to show Operation availability.
_Avoid_: Installed, runtime `serverInfo`, UI-only validation

**Command**:
A user-invocable prompt template, in the Claude Code sense — identity, description, argument contract, and a template body, and nothing else. Harness, model, effort, and tool restrictions are deliberately omitted: a Command has no runtime to carry them into until interactive sessions land. Not a shell entry point.
_Avoid_: Script (retired), Tool, Operation, shell command

**Rules**:
Reusable advisory guidance contributed at any scope, authored as markdown with frontmatter carrying glob-based path scoping and an always-apply flag. A contribution kind that is *not* a Run Plan member — Rules resolve into Instructions.
Rules are advisory and can never satisfy a required need. They are **not** guaranteed to leave Operating Instructions unweakened: the Engine collects Rules and does not read them — it decides on / off, whether the globs match, and where in the ladder — so what a model does with the text is the author's business, not an Engine gate (ADR 0018). Instruction precedence, general to specific: global Rules → repo `AGENTS.md` → repo Rules → private-overlay Rules → Operating Instructions, last and highest.
The frontmatter shape is a considered borrow from Cursor and Claude Code, which arrived at it independently — not a standard. `AGENTS.md` specifies a filename and closest-wins and nothing more.
_Avoid_: Operating Instructions (those are mandatory and engine-authored), Skill, prompt

**Middleware**:
An engine-owned interceptor around the model loop lifecycle, portable across owned-runtime Runs and distinct from Hooks interpreted by an external Harness. **Engine-only, and not a contribution kind** — a Plugin-shipped Middleware would run code inside the model loop, crossing ADR 0006's data-not-code line.
_Avoid_: Hook, Operating Instructions, contribution kind

**Hook**:
A Harness-native lifecycle extension projected only when the selected Harness supports it. A Hook does not become Middleware merely because both react to lifecycle events.
_Avoid_: Middleware, Command

**Subagent**:
A named agent definition available for delegation by a parent agent. It remains a distinct Run Plan field even when a Harness projects it as a Tool.
_Avoid_: Tool, Harness, Operation

**Sandbox policy**:
The allow, ask, and deny rules governing Tools, file writes, and network access during a Run.
_Avoid_: Middleware, Harness execution boundary

### Workflows and operations

**Workflow**:
A reusable end-to-end automation made of operations and the transitions between them. Cogwork owns the graph today; user-authored composition may come later without changing the concept.
_Avoid_: Playbook, pipeline, run

**Operation**:
One selectable kind of agent work within a workflow, such as triage, implementation, follow-up, or verify. A run executes one operation.
_Avoid_: Lifecycle stage, stage, step, task type

**Transition**:
The routing relationship that selects what follows an operation from its outcome and current external state.
_Avoid_: Operation, workflow step

**Operation definition**:
The engine-authored contract for one operation: its behavior, defaults, required needs, Operating Instructions, and possible outcomes. A required need that cannot be satisfied — including a required Connection or MCP server that is not ready — is a Run Plan rejection, uniform across kinds. Rejection is a recorded failure with a reason; it never parks the item waiting for a human.
_Avoid_: Playbook, run plan, operation settings

**Operation settings**:
The scoped choices that configure an operation: on / off, Harness, model, effort, permission profile, and the contributions **bound** to the Operation Definition's declared needs. Settings bind; the Definition declares what is required; a Plugin only offers, and can never mark itself required for an Operation it does not own.
Each may be written three ways — as a **default**, for one **Workflow**, or for one **Operation** — and the most specific of the three wins before Scope is consulted. A default must never outrank a value that names the work.
An Operation Definition may lock a setting against override. That lock **is** Engine policy, not a second mechanism: it constrains rather than overwrites, and refuses with its source named.
_Avoid_: Playbook, operation definition, run plan, target (say default / Workflow / Operation)

**Operating instructions**:
Reusable guidance an agent must follow when performing an operation, resolved separately from the work-specific facts supplied for one run.
_Avoid_: Skill, playbook skill, prompt, work context

**Work context**:
The work-specific facts supplied to a run, such as a work item's body and comments or a pull request's checks and reviews.
_Avoid_: Operating instructions, prompt template, workflow settings

The relationship is:

```text
Workflow
├── Operations and transitions
│   └── Operation
│       ├── Operation Definition
│       │   ├── Operating Instructions
│       │   └── required needs
│       └── Operation Settings
│           └── bound contributions
│
└── selected Operation + Work Context
    → Run Plan
      ├── Harness Adapter
      ├── Instructions        (Operating Instructions + resolved Rules)
      ├── Tools
      ├── Skills
      ├── MCP
      ├── Subagents
      ├── Commands
      ├── Hooks
      ├── Middleware
      ├── Sandbox (Workspace, Policy)
      ├── Structured Output
      ├── Persistence
      ├── Connections
      └── Provenance
    → Run
```

**Priority**:
One of `urgent`, `high`, `medium`, `low` — a four-level scale (`priorityRank`, highest first) that orders work *within* an operation and nowhere else. Operation is always the primary sort key, so a low-priority follow-up still runs before an urgent implementation; priority only breaks ties between items selected for the same operation, and stable tracker order breaks ties between items of the same priority. Every observed item carries a resolved priority. Each adapter reads its own tracker's field and maps it onto this scale (`resolvePriority`, case-insensitive); anything absent, blank, or unrecognized becomes the `defaultPriority`, `medium`. Priority orders work — it never gates eligibility — so a value we can't read must never drop an item; it just lands in the middle.
For GitHub, `issueTracker.priority.field` is the stable numeric ID of an organization single-select issue field. Clients fetch the compatible catalog through the workspace's bound Connection and store a selection; they never ask a person to type GitHub coordinates. The adapter reads that ID from the issue-field values included with each listed issue. For Linear, priority is native and needs no configuration.
_Avoid_: Operation priority (that's the fixed operation order), severity, weight, rank (alone — `priorityRank` is the ordering, priority is the value)

**Triage role**:
A human-visible label expressing an item's triage outcome: `needs-triage`, `ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`. Roles drive classification; operations drive execution.
_Avoid_: Status, state, label (when you mean the role's meaning)

**Blocked / blocker / blocking**:
An item is *blocked* when its issue tracker reports one or more open **blockers** — upstream items that must close before it can be worked — and it is *blocking* the items downstream of it. Blocking is the issue tracker's own dependency relation (GitHub issue dependencies today; Linear blocking relations when its adapter reads them), read per adapter. A blocked item is held out of the implementation operation until its blockers close, then becomes eligible on its own — no human acts. Neither eligible, claimed, nor needs-human.
_Avoid_: Depends-on (the inverse framing); needs-info / ready-for-human (those are needs-human — a person clears them); stuck / exhausted / stalled (failure outcomes, not dependencies).

**Needs-human reason**:
Why triage parked an item for a person: `needs-info` (waiting on the reporter) or `ready-for-human` (needs a human implementer). A needs-human item is neither eligible, claimed, nor blocked. Where a role parks it, a person clears it by changing the role; where a **failure counter** parks it — exhaustion, stall, or crash loop — changing the role is not enough, and the person **hands the item back**.
_Avoid_: Block reason (blocking now means open dependencies), error, failure.

### Coordination

**Claim**:
A coordination record marking an item as being worked: `by`, `claimedAtMillis`, and an optional operation. Persisted onto the issue tracker (a label plus a marker), so it survives a daemon restart.
_Avoid_: Lock, lease, reservation

**Refused claim**:
A claim the issue tracker will not accept — a write the credential is not permitted to make, such as creating the claim label in a team that forbids it. Distinct from a *contended* claim, which cannot happen: classify only ever offers unclaimed work. A refusal the port reports as permanent (`IssueTrackerError.retryable === false`) is one every retry gets the same answer to; absent that field a refusal is worth polling again. A refused claim is not *exhausted*: no run started, so there is no attempt record and no `RunStatus`. What the engine does about one is the executor's, in the engine glossary.
_Avoid_: Contended claim, stale claim (one we release), exhausted (a run that gave up after trying)

**Attempt record**:
A coordination record of one finished operation attempt on an item: its operation, outcome (`succeeded` / `failed` / `abandoned`), and time. Persisted on the issue tracker.
_Avoid_: Run — a run is the local execution; an attempt is the durable outcome

**Handback record**:
A coordination record of a person returning a parked item to the control plane: `by` and `atMillis`. Persisted on the issue tracker. The three failure counters — exhaustion, stall, and crash loop — count only what happened after the newest handback, so a handback discounts an item's failure history without erasing it. The inverse of a hand-off: the control plane hands an item off to a person when it gives up, and a person hands it back. A second handback moves the line forward.
_Avoid_: Retry (the control plane's own automatic re-attempt of a *retryable* failure — a handback is a person acting, not the engine), reset, unpark, pardon

### Credentials

**Credential store**:
The daemon's credential source for Connections: stored API keys, environment-variable references, OAuth token pairs, and GitHub CLI source markers keyed by system and account. At run time it **acquires** the current GitHub CLI token for the Connection's fixed account and holds successful acquisitions in memory for ten minutes; the token is never persisted. A seam: the backing layer is a `0600` file today, an OS keychain on desktop, a per-user database row on a hosted server. Unlike the run ledger it is **not** disposable — losing it logs the daemon out — and it is never committed to the repo. Both Linear and GitHub acquire credentials through it. It holds the secret half of a **Connection**, whose non-secret record lives in the Control store.
_Avoid_: Run ledger (that one is disposable), config (the non-secret `client_id` lives in config, not here), keychain (only one possible backing layer).

### Runs

**Run plan**:
The immutable, engine-validated resolution of one Operation and its Work Context. Its members, named after TanStack AI: Harness Adapter, Instructions, Messages, Work Context, Tools, Skills, MCP, Subagents, Commands, Hooks, Middleware, Sandbox (Workspace and Policy), Structured Output, Persistence, Connections, and Provenance. Messages contain the resolved user turn. Instructions stay separate. Work Context freezes the admitting snapshot's coordination facts and keeps the work-item reference for live prose reads.
Run Plan members are **not** the same list as contribution kinds. Rules is a kind but not a member — it resolves into Instructions. Tools, Connections, and Middleware are members but never contributions.
Every plan carries a mandatory **provenance stamp**: a Plugin item's declared version where it has one, a content revision where it does not. No contribution carries its own version — no platform in the field versions the capabilities inside a bundle. The plan is accepted before dispatch and never changed by runtime observations.
_Avoid_: Run manifest, resolved stage, harness request, operation settings

**Run**:
One execution of one run plan by one harness, captured with its events, outcome, usage, and timings. The run records what was projected and observed without changing its plan.
A terminal run records `claimDisposition: hold` when a factual gate decline intentionally keeps the current claim. Recovery ignores that hold once a newer claim supersedes the run.
_Avoid_: Attempt (the durable, issue-tracker form), job. Do not confuse with the harness's `RUN_STARTED` / `RUN_FINISHED` stream events, which are moments inside a run.

**Run ledger**:
The daemon's local store of runs, their immutable Run Plans, and their events — in-memory, or a region of the Control store on disk. A Run and its Plan are accepted together before dispatch, keyed by Run ID. It also holds run history, harness sessions, and token usage. It does not hold the scheduler's daily usage, and losing it is safe because the issue tracker stays authoritative for coordination.
_Avoid_: Source of truth, database, backlog, Control store (the ledger is one disposable region of it). Not the GitHub coordination comment, whose anchor marker is also called a "ledger".

**Run event**:
One persisted, sequenced entry in a run's stream — an encoded harness event stored with a `seq` and timestamp.
_Avoid_: Log line, message

**Run activity**:
A live envelope broadcast while a run is in flight: run identity (run id / sequence / timestamp), the correlation ids for grouping, and the one whole harness event. What the watch stream carries. The same shape is rebuilt when a settled run's persisted events are replayed for the run drill-in, so live and history read identically.
_Avoid_: Run event (the persisted form), notification

**Session**:
A first-class entity with its own `SessionId`, grouping the runs that make up one conversation — a run points at it by foreign key (`RunRecord.session`), and runs on the same branch share one while their selected harness remains unchanged. Every session is permanently owned by the harness that created it and can be resumed only by that harness; model, effort, operation, and instruction changes do not affect compatibility. A fresh start always mints a new session. It comes in two kinds. An **owned-transcript** session is the provider runner's: the whole conversation lives in our run ledger, so its transcript folds straight from the events and no handle is kept. An **opaque-handle** session is a CLI harness's: the harness keeps its own history and hands back an opaque `handle` (e.g. Cursor's session id) we store to resume it — `null` until the harness emits one. The kind is not a guess: each harness runner declares its `SessionKind` beside its name, and the session store mints the matching one. The session is minted when the run is inserted, before the harness has said anything (see engine ADR 0002), so a run always names a session even before it can be resumed.
_Avoid_: Run, connection, handle (that's one field of the opaque-handle kind, not the session itself)

**Session resume**:
A new Run and new native invocation that continue an existing Session. Cogwork sends the Session's `SessionId` as TanStack `threadId`; an opaque native handle, when present, goes only into the adapter's native `modelOptions.sessionId`. A resume never continues the old Run.
_Avoid_: Retry (why the new Run started), replacement Run (one recovery reason), Run takeover (continuation of the same invocation)

**Retry**:
The control plane starting another Run after a retryable failure. The new Run can resume the failed Run's Session, but retry describes failure policy, not conversation identity.
_Avoid_: Session resume, replacement Run, Run takeover

**Replacement Run**:
The new Run started after an interrupted or crashed Run. It can resume the same Session, but it starts a new native invocation with a continuation Message that treats the prepared Worktree as ground truth.
_Avoid_: Retry (interruption and crash are not attempts), Run takeover

**Run takeover**:
A successor driver adopting the same live native invocation and continuing the same Run after driver loss. It requires an exact delivery log, persistent native status, durable cancellation, distributed locking and fencing, and scheduled reaping. Cogwork does not enable it.
_Avoid_: Session resume, retry, replacement Run, human attach

**Harness switch**:
A run selecting a different harness from the branch's latest session. It begins a new session with the full operating instructions while preserving the worktree, branch, code progress, claim, and historical run records; only conversation continuity is discarded. Switching back never resurrects an older session from that harness.
_Avoid_: Session migration, session transfer, cross-harness resume

**Exhausted / stalled / stuck**:
The three failure outcomes — how the control plane stops spending tokens on an item after it has already tried. A run is *exhausted* when it gives up after too many failed attempts or a non-retryable error: the terminal `RunStatus`, which escalates the item to `ready-for-human`. A follow-up is *stalled* when it hits the no-progress limit without the checks going green or a human replying. An agent is *stuck* when its own output reports it cannot proceed — a non-retryable cause that feeds exhaustion. All three are distinct from *blocked*, which is about unresolved dependencies before any attempt.
_Avoid_: Blocked (dependencies now), failed (the single, still-retryable attempt status).

**Interrupted / crashed**:
The two restart outcomes, distinct from the failure outcomes above: neither is an **attempt record**, and neither advances an item toward *exhausted*. A run is *interrupted* when the daemon stops it gracefully during a drain. A run is *crashed* when startup finds it still `running` because the daemon died ungracefully. Recovery starts a replacement Run that resumes the Session; it never takes over the prior native invocation. A small per-item cap on consecutive crashes tips the item to *exhausted*, so a poison-pill item cannot restart forever. Both keep their **claim** across the restart; Session resume is machine-local, since the Session lives only in this daemon's Run ledger.
_Avoid_: Failed (a real, still-retryable attempt), exhausted (the terminal failure outcome), stale claim (one we release — a resumable run's claim is not stale).

### Harness contract

**Harness**:
A coding agent (Cursor, Claude Code, …) the control plane drives to do work in a checkout, identified by a branded `HarnessName`. A harness bundles its own model access and tools.
_Avoid_: Model, provider, target (that word belongs to sync)

**Harness-owned authentication**:
The credentials an external CLI harness owns and resolves from its host installation, such as a Codex CLI `codex login`. Cogwork selects and launches the harness but does not copy, store, refresh, or fall back from those credentials.
_Avoid_: Provider key, Cogwork login, harness fallback

**Harness option catalog**:
The controlled model and option choices one Harness offers: checked-in generated data shipped by that Harness's package, stamped with the package version and the CLI version it was generated against — never a runtime observation (ADR 0024). An unsupported option is absent, and a saved choice missing from the current catalog is stale rather than free-form input.
_Avoid_: Model catalog, settings, arbitrary option, probed catalog

**Option descriptor**:
The declaration on one catalog model of one selectable axis: a select with its permitted values, or a boolean. Descriptors are what clients render and what validation checks; a model with no descriptors is opaque and offers only itself.
_Avoid_: Setting (that is the saved choice), flag, capability

**Canonical option id**:
The shared name for an option axis more than one Harness has: `effort`, `speed`, `context`. Only the axis name unifies — each catalog keeps its own native value list. A Harness-specific axis keeps its own id.
_Avoid_: reasoningEffort, fastMode, per-Harness synonyms for a shared axis

**Model options**:
The saved option selections (`id` → value pairs) of one Operation, stored and cleared atomically with its model: options mean nothing apart from the model they modify. Each Harness translates them to its native form at dispatch. Replaces the retired standalone effort setting.
_Avoid_: Effort setting (retired), model suffix, traits (the desktop menu, not the data)

**Harness readiness**:
An observation of one Harness's installation, compatible version, and selected authentication binding on the current Runtime host. It can block a Run when negative but never guarantees that a later launch will succeed, and it never selects a fallback Harness or authentication mode.
_Avoid_: Health check, launch guarantee, availability fallback

**Harness state**:
The single conclusion **Harness readiness** folds to for a person: ready, not installed, unsupported version, not signed in, unavailable, or unknown. The engine folds it once, so every client shows the same answer instead of re-deriving one from the four observed axes. Its `NotSignedIn` case carries the **Harness sign-in** command when the Harness declares one.
_Avoid_: Status, health, readiness (that is the observation this folds)

**Harness sign-in**:
The one command that establishes a Harness's own login — `codex login`, `claude auth login` — declared by the adapter that owns that Harness. Cogwork never runs it and never stores what it produces: the credential is **harness-owned**, so this is something a person is shown, not something the product does. Absent for a Harness that verifies its login during the native launch instead.
_Avoid_: Login flow, credential prompt, authenticate action

**Harness preflight**:
The authoritative per-Run check that one registered Harness can execute the accepted Run Plan with its selected catalog values, authentication binding, policy, Workspace projection, required MCP servers, and Sandbox provider. It validates the Plan as frozen and never re-resolves settings.
_Avoid_: Readiness, Run Plan resolution, fallback

**Harness capability profile**:
The runner-declared facts that let clients and preflight describe intentional native inequalities without guessing from a Harness name. They cover authentication bindings, Session affinity, option and structured-output support, policy fidelity, usage quality, readiness diagnostics, journal and takeover support, and file-event fidelity. File events are `terminal-only`, `best-effort`, or `absent`; the label reports delivery quality, not whether a Run changed files.
_Avoid_: Feature flag, fallback policy, durability activation

**Harness execution boundary**:
The sandbox, approval mode, and native tools an external CLI harness enforces inside its agent loop. Cogwork chooses that boundary when it launches the harness, but its owned-tool policy cannot intercept native shell or file operations inside Cursor or Codex. An unattended harness must use a non-interactive approval mode and remain bounded to its worktree; full host access is not an unattended default.
_Avoid_: Owned tool policy, provider sandbox, fallback

**Harness request**:
The projection of an accepted Run Plan handed to one Harness: checkout path, work request, model and effort, Session reference, Instructions, Tools, Skills, MCP, and other supported fields. Secret material rides a channel that is never persisted or logged, not a plain field.
_Avoid_: Run plan (the complete engine-owned input), prompt, job

**Operation result**:
The tagged, Effect-Schema-defined value an operation returns through the harness stream. The shared kernel owns each operation's schema: triage returns exactly one `TriageStageResult` tagged `triage`, containing a terminal triage role (never the input-only `needs-triage`) and a non-empty, trimmed proposal; implement returns `opened-pr`, `stuck`, or `ready-for-pr`, whose pull request title and body the Engine uses after its gate passes; follow-up returns a `FollowUpStageResult` tagged `follow-up`, with `pushed`, `noop`, or `stuck` plus a non-empty, trimmed summary. Prose remains ordinary streamed output and is never parsed as an operation result.
_Avoid_: Footer, sentinel, disposition line, text protocol

**Operating-instructions package**:
The Operation-owned instruction document and supporting resources carrying its mandatory Operating Instructions. It is supplied explicitly to every Harness through an instruction-specific content and resource path; `SKILL.md` is reserved for real Skills. The engine ships the default package, and a Workspace may replace it whole with an operator-authored package in its private overlay tree (`~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/`); a replacement that is present but has no readable, non-empty `INSTRUCTIONS.md` fails the Run rather than falling back. Either source stays mandatory, last and highest in the instruction ladder, and is never a contribution (ADR 0019).
_Avoid_: Skill, `SKILL.md`, playbook skill, MCP server

**Harness event**:
The whole AG-UI event a harness run streams, carried inside a stable envelope rather than curated down to a fixed set of fields. A handful of fields are named because our folds and clients read them (text delta, tool call id/name, result, session id, usage, finish reason); every other key the harness emits — tool-call input, reasoning deltas, correlation ids, per-turn cost, and AG-UI fields we don't name yet — rides along instead of being dropped at decode. The engine persists these as run events and republishes them as run activity. Supported external file changes use the shared `sandbox.file.diff` custom event before persistence, so owned and external Runs feed the same client contract. The provider runner emits AG-UI natively; cursor-acp maps its ACP stream best-effort.
_Avoid_: Message, token, curated event (the point is that it is not curated)

**Correlation ids**:
The stable ids a client uses to thread streamed deltas back into one message or one tool call — `threadId`, `messageId`, `toolCallId` — lifted out of the harness event into the run-activity envelope so a consumer can group activity without re-parsing the whole payload. Distinct from our `RunId`, which identifies the local execution, not a span inside it.
_Avoid_: Run id (that's the execution), message id alone (there are several)

### Daemon status (read models)

**Daemon status**:
The snapshot the daemon reports over RPC: health, uptime, scheduler stats, per-workspace info, and load failures.
_Avoid_: State, health check

**Actionable / claimed / blocked / needs-human / ready-to-merge item**:
The status-facing shapes of a classified work item — eligible-to-run, currently-claimed, blocked on open dependencies, parked for a person, and an approved pull request waiting for a person to merge it. Narrowed views of a work item, not new entities. The first four carry an optional **PR summary** when the source control provider resolved a pull request for the item; an item with no PR omits it. A ready-to-merge item carries a required PR summary and is neither eligible, claimed, blocked, nor needs-human. A needs-human item also carries the halt reason and, when triage self-halted it, the **inline triage proposal** — the agent's proposal/question text, re-derived from the tracker on every reconcile so a surface can render the question in place without reading the comment thread. It is `null` when nothing self-halted the item (for example, an exhaustion hand-off).
_Avoid_: Reusing "work item" for these narrowed views

**Inline triage proposal**:
The agent's triage proposal/question text carried on a self-halted item's read model, lifted off the separate conversational tracker comment that still holds the human-facing copy. Present only when triage parked the item; re-derived from the tracker on reconcile, so it survives a daemon restart with no local state.
_Avoid_: Coordination detail (that carries hand-off explanations, not the proposal), proposal comment (the tracker comment this is lifted from)

**PR summary**:
The read-model view of a classified item's pull request, resolved by the source control provider from the item's link key: the PR number, a deep-link URL, its checks and review status, its mergeable / base-divergence signal, and a wait-time signal (the PR's last-activity instant, from which a consumer reads how long it has been waiting). Present only on items that have a PR. Shaped richly enough to host a later in-app review panel; the review and merge actions themselves stay on GitHub, reachable through the URL.
_Avoid_: Observed PR (the engine-internal form the provider reads, which also carries follow-up coordination state), PR state (too vague)

### Client RPC

**Query RPC / command RPC**:
The two kinds of RPC a client sends the daemon. A *query* reads daemon state and changes nothing. A *command* is an imperative that changes daemon state or behavior — cancel a run, reclassify a work item, pause the scheduler. The split follows CQS/CQRS and gives the trust boundary one place to guard commands more strictly than queries. `DaemonQueries` and `DaemonCommands` are the two groups; `DaemonRpcs` is their merge, what the daemon serves and a client generates against. The command group holds `CancelRun`, `Reclassify`, `SetScheduling`, and `SetDaemonLimit` today, and fills in further with the settings and Plugin management slice.
_Avoid_: Write RPC (too narrow — a command may change behavior, like pausing the scheduler, not only write data), mutation, getter

**Principal**:
The caller behind an RPC, injected into every handler's context by one `RpcMiddleware` so no handler assumes there is no caller. A fixed local owner today — the daemon is single-user — but the seam is where a real identity lands later, and where commands get guarded more strictly than queries. A token can ride along as a request header (`authTokenHeader`); it's unread today. The Principal is server-side context, never a serialized field on a read model.
_Avoid_: User, account, session (the harness's conversation handle), token (the credential, not the caller)

**Daemon event**:
The unit a client watches on the daemon's live feed — a tagged envelope over everything a client view must react to: a harness event on a run (run activity), a work item's classification change or removal, a run summary change, a workspace's state change, the whole Control store picture, and a scheduler change. The subscription self-seeds — it opens by replaying the current state as ordinary events — so one subscription per client is the whole story; the client fans out its own views. Each seed is complete: derived state folds from the newest subscription's seed, and anything the seed does not re-state is gone. `RunActivity` is live-only on `WatchEvents`. `SeedEnd` is a subscription-control event: it carries a delivery fact, not a domain fact, and changes no derived state. The watch endpoint emits it after the seed and before the live tail; the daemon event bus never carries it.
_Avoid_: Run activity (now one kind of daemon event), notification, log line

**Board**:
The view a client folds from the daemon event stream — the current items, running runs, and workspace and scheduler state. The fold is authored once, beside the daemon event; each client runs it locally, and folding the stream from its seed yields the same picture the status query reports.
_Avoid_: Dashboard, mission control (the product surface, not this view), status (the query is `GetStatus`; the board is the folded, live form)
