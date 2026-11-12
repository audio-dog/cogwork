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
The one thing a Run acts on. An issue tracker supplies it, identified by a branded `WorkItemId` (e.g. a GitHub issue like `#13`, or a Linear identifier like `AUD-1`), or the engine **mints** it from a Trigger event — a Granola note, a Slack message or conversation, a schedule instant, a pull request no issue links, or a fan-out element. An engine-minted item's identity derives from an immutable source identity, never from model output, and no author writes a key; its coordination lives in the Control store (ADR 0033). Each item has a kind, which fixes its Work context.
A tracker item carries a title and, once observed, its roles, claim, and attempts; its pull request is resolved separately by the source control provider, not carried as a tracker property.
_Avoid_: Task, job, ticket (except when naming the tracker's own UI), Trigger event (it names an item; it is not one)

**Link key**:
The stable key tying a work item to its pull request across systems. GitHub numeric work items first match an open PR's GitHub-resolved closing reference (`Closes #N`); all items retain the `ticketSlug(item.id)` branch-prefix fallback (`fel-157-…`, `13-…`). The engine-cut branch remains stable because it derives from the immutable item id rather than the title. A same-repository closing-reference match carries its actual head branch into follow-up.
_Avoid_: PR reference, branch name (the full branch also carries a title slug that can drift)

**Workspace**:
A repo registered with the daemon under a minted `WorkspaceId`: a checkout path bound to an issue tracker and, optionally, a source control provider, plus workflow and operation settings. Checkout path is a re-binding hint, never identity. The unit of isolation and per-repo configuration.
When either Engine port uses GitHub, its `owner/repository` is runtime data derived from the checkout's selected worktree remote (`origin` by default). It is not a second configurable repository.
_Avoid_: Project; not pnpm's or TanStack's "workspace"

**Actor identity**:
Who the daemon acts *as* on a tracker — the authenticated account discovered from the bound **Connection**. It authors the daemon's tracker writes and marks which comments and pull requests are the daemon's own. A workspace stores only the Connection binding; it has no separate actor selector.
Because that account is the person's own, it cannot tell Cogwork's writes from the person's. In a Workflow the **origin record** decides which writes are Cogwork's, never the account.
_Avoid_: Bot id, owner (that's the allowlist), principal (that's an RPC caller)

**Assignee allowlist**:
`issueTracker.assigneeAllowlist` — an optional, non-empty-when-present list of tracker-native identities whose assigned tickets this workspace is *allowed to pick up*. Absent means no gate: every item is eligible, as before. Distinct from the actor identity: this is whose work the daemon may take, not who it acts as. Enforced by the engine's Trigger observation, not here.
_Avoid_: Assignee filter, owner list (it's an allowlist of several), actor

**Bot allowlist**:
`sourceControl.botAllowlist` (with the same fallback field on `issueTracker` the source-control target already borrows) — an optional, non-empty-when-present list of bot logins whose PR feedback is trusted to *wake a follow-up*. Absent means the gate is off: no bot ever wakes one, exactly as before.
**A trusted bot wakes a follow-up only when it opens a new thread on a line of the diff.** A bot's narration of the pull request — a summary comment, a review header, an automation note — is not a finding and wakes nothing, and neither is a reply inside a thread somebody else opened. An entry ending in `:any` drops the shape test and takes every comment that bot writes; it is the escape hatch for a bot that only speaks at pull-request level. Human feedback is unaffected: a person's PR-level comment still wakes a follow-up and can still set `/fresh`.
A listed bot's finding is a wake signal only. It can never set `/fresh` and grants no steering: a trusted-bot finding is actionable context, like a failing check, never an instruction. Distinct from the actor identity (who the daemon acts as) and the assignee allowlist (whose tickets it may pick up).
_Avoid_: Bot filter, trusted authors (humans aren't on it), steering (a bot never steers), *bot comment* as a synonym for *finding* (most of what a bot writes on a PR is neither)

**Follow-up trigger**:
A source-control **Trigger** entry for failing required checks, a **base divergence**, new human feedback, or a trusted bot's finding. Source revisions make the rule structural: a standing state has no new revision, so it cannot wake follow-up again.
**A trigger must be a condition the agent can clear** — either by working or by answering it once. A condition the agent has no power to clear is pull-request state, not a Trigger. A standing `changes-requested` review therefore wakes nothing on its own; its prose and inline comments remain human-feedback occurrences. See engine ADR 0013.
_Avoid_: Follow-up reason; *wake signal* as a synonym (that names a trusted bot's finding in particular); review decision (that's a state a trigger is defined against)

### Configuration

**Control store**:
The daemon's single local database of everything Cogwork itself has been told on this machine — install records, Connection records, settings at every Scope that is not a file, Runtime host bindings, minted Scope identities, daemon runtime limits, Workflows, the coordination of engine-minted Work items and every item's action plans, and the store's own schema metadata. One database per machine, under `~/.cogwork`.
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

**Skill, Rules and Subagent have no setting**: their Authoring tree is their enablement — see *Authoring tree*, and ADR 0018. Hook's row is deferred with the kind itself. A **Connection** is not on this axis at all: it has no Scope (ADR 0017).
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
**Every Plugin ships with Cogwork.** Nothing is fetched and nothing third-party can be added, so uninstall is always reversible, offline. After an install a Plugin's **MCP server** is on, because installing is itself the trust act; its Skills, Rules and Subagents are on disk and therefore active, and have no setting at all. An app update is the only thing that changes a Plugin's files, and it lands at load with nothing to stage, accept or decline. See ADR 0014.
_Avoid_: Capability (retired — there is no umbrella noun), component, marketplace listing, Plugin enablement

**Install record**:
The authority for *this Plugin is installed*, held in the Settings profile. Keyed by `pluginId` alone, so **one resolved identity is installed at a time** — a second would give two contributions the same `<authority>/<kind>/<localName>`, which is the *ambiguous* class. It carries the resolved identity and the owning `Principal`. Reverting is an install at a named resolved identity, not a distinct operation, so no install history is kept.
An app update may change the resolved identity; nothing changes the `pluginId`. The `Plugin source` field and the `revision` field are **deleted** — every Plugin ships with Cogwork so the source had one value, and the revision guarded a two-command staged update that no longer exists. See ADR 0014's 2026-08-26 amendment.
_Avoid_: Plugin (the bundle, not the record), install cache, provisioned path, Plugin state, `pinned` (retired — see **Plugins**), `Plugin source` and `revision` (both retired — see ADR 0014)

**Plugin catalog**:
The one first-party document listing the Plugins on offer. It **ships with Cogwork**, as do the bundles it lists, so it is read from disk and never fetched. Each entry carries a name and a pointer to the bundle. It is also the name of the **Plugins** section holding the Plugins a person has not installed.
**Struck 2026-08-26, and not to be restored:** the computed digest, the `active` / `deprecated` / `deleted` status set, the network fetch and its cache, the stale and never-fetched arms, and the explicit refresh act. All of it served fetching bytes from elsewhere, which Cogwork does not do. Do not re-derive it from prior art or from a future in which third-party install exists; that future gets its own decision. See ADR 0014.
Qualified because bare *catalog* is spent three times — the desktop's **Surface catalog**, the engine's **Model catalog**, and the **Trigger and action catalog**.
_Avoid_: Marketplace, registry, Surface catalog, Model catalog, Trigger and action catalog, index

**Plugins**:
The surface that owns Plugin **membership** — install and uninstall, the whole of it — and the setup that follows an install. It and **Connections** are the only surfaces permitted to change what is installed. Its sections are **Needs Attention**, **Installed**, and **Catalog**. Uninstalling shows a notice naming any **Connection** the Plugin required as still established: removal cascades down the dependency arrow and never up, so Plugins never removes a Connection.
"Permitted" is a **client-surface rule, and the daemon does not enforce it**: it sees one `Principal` and cannot tell which panel called. What holds the split is the act list — membership and settings are different commands, so a surface that calls only settings commands has no branch that could change membership. Do not build a caller-kind check to satisfy this line.
_Avoid_: Marketplace, Customize, Plugin store; `pin` (retired — no harness exposes version pinning to a person); *stage*, *accept* and *decline* an update, and *refresh the catalog* (all four retired — nothing is fetched, so an app update is the only thing that changes a Plugin); and the lowercase plural *plugins*, which means the bundles

**Customize**:
The surface that owns **contribution settings** — an MCP server's on / off — and that renders every other contribution read-only. The kind is the view and the authority is a badge on the row — and for a `local:` row that badge *is* the Authoring tree, so it is shown once, not twice. Since ADR 0018 removed the setting from Skill, Rules and Subagent, their rows show what exists and which tree it came from, and carry no toggle. An MCP server keeps its toggle, and a `local:repo` one is the offer-versus-enable row ADR 0013 owes: *this repository offers this. It is off. You can turn it on.* The MCP server view groups by the Engine's conclusion — **Needs Attention** and **Ready** — never by the person's choice: a server switched off greys out and takes a *Disabled* pill in place, so it is switched back on where it was left. It may show a Plugin-owned row's status, including one that failed to load, and it may **never** write membership or credential state: authority is part of a contribution's immutable identity, so the surface that renders authority is the wrong place to change it. As with **Plugins**, "never" is a client-surface rule the daemon does not enforce.
_Avoid_: Plugins, Settings, preferences

**Connections**:
The surface where a person **connects**, **re-connects**, or removes a system, with one card per system and no container noun over it. It may write Plugin membership, but only this way: **connecting installs the Plugin that requires the Connection.** At most one first-party Plugin requires a given Connection, which is what makes that Plugin derivable. No noun is minted for the act.
_Avoid_: Integration, connector, Customize, Plugins, setup wizard, *paired install* (retired — it never said what was paired with what, and named an act nobody refers to twice)

**Workspaces**:
The surface that owns what the daemon operates over and under on this machine: register, update and deregister a **Workspace**, re-bind its checkout path, set its Operation settings, and set the daemon's runtime limits. `WorkspaceState.Registered` publishes the complete stored registration record. Update replaces its mutable non-path columns without touching Private workspace overlay rows. Named for its dominant subject; Operation settings live with the Workspace whose Runs they govern, while the workspace record's columns and the limits are machine facts (ADR 0016). (Restoring the **Control store**'s pre-migration copy was withdrawn with ADR 0015's 2026-08-27 amendment.)
**Register is the trust act.** Registering admits the repository's Workspace input Authoring tree — see **Scope** and ADR 0018. There is no repository settings file behind this surface: `register` writes the workspace record instead.
_Avoid_: Settings (already on Customize's _Avoid_ line), Engine (the machinery being managed, not a pane), Daemon, Workspace (the singular is the registered repo, not the surface), machine config

**Contribution kind**:
One of the five types a Plugin may bundle and Customize may show: **MCP server, Skill, Subagent, Rules, Hook**. Command is not a kind, and Cogwork does not read `commands/` files (ADR 0037). The test is that a contribution kind is authored by a human as a file and renders as a row in Customize. Everything else an agent receives is engine-owned and appears only as a Run Plan member — Tools, Connections, Middleware, Operating Instructions, Work Context, Sandbox Policy, Harness are all deliberately *not* contribution kinds.
Only the kinds that **execute or connect** carry a setting. **MCP server** has one — on or off, written as a default and nowhere else. **Skill, Rules and Subagent** have none at all: they exist or they do not, and the Authoring tree a file sits in says everything an on / off could say (ADR 0018). **Hook** is deferred — it stays a named kind with its setting question open, because no cross-harness projection has been designed. Everything else about a contribution lives in its file. Turning it on for one Workflow or one Operation is not expressed here; that is **binding**, an Operation setting.
_Avoid_: Capability, Run Plan member (the two lists differ — Rules is a kind but resolves into Instructions; Tools is a member but is never contributed), per-Operation enablement (say binding)

**Connection**:
The established, authenticated binding to one external system, keyed by **system and account** (`linear/acme`, `github/octocat`, `slack/TKHST7M4Z`) — engine-owned, and not a contribution kind. It is never the credential itself: its record lives in the Control store (id, system, account, status) and its secret or source marker in the Credential store, reaching a Run over a channel that is never persisted to the run ledger or event log. Both a Plugin's contributions and the Engine's own ports — the issue tracker, the source control provider — authenticate through one and reference it **by id**. A Plugin may *require* a Connection; it may never define one.
Every **output action** acts through the person's Connection for its app, so a Workflow acts as the person.
**A Connection has no Scope**, and reference is not scoping: it is machine-level, a workspace references one, and a repository can never connect or override one. One grant serves every port on one account. At connect time, the system itself has to accept the credential before anything is written. GitHub and Slack report the account from the accepted credential; a person never types it. Linear keeps its typed account. At run time, the Credential store acquires the current credential from the selected source. A refused connect or re-connect leaves the credential it would have replaced untouched. Removal cascades to each Plugin that requires it and leaves a bound workspace *dangling*; a grant revoked outside Cogwork is a readiness state, not a removal. See ADR 0017.
_Avoid_: Plugin (a Plugin requires a Connection, never contains one), credential (that is the secret it holds), MCP server, contribution kind, provider key (that one buys inference, not access to the work), Integration, connector

**Connection readiness**:
The Engine-owned conclusion that a Connection is established, unrevoked, and usable. It is an **input** to MCP server readiness for a contributed server that requires one, and it stands alone for an Engine port, where it gates that port's Trigger source. Deliberately **not** generalized: there is no `Readiness` umbrella, because the two are not peers — one feeds the other.
_Avoid_: Readiness (unqualified), MCP server readiness, established (one of its inputs)

**Tool**:
A typed function an agent may call during a Run. A Tool may be engine-owned, provider-native, or exposed by an MCP server, but its source remains explicit.
_Avoid_: MCP server (one server may expose many Tools)

**Skill**:
A discoverable package of instructions and supporting resources an agent may use during a Run. It remains distinct from mandatory Operating Instructions.
_Avoid_: Operating-instructions package, MCP server, Plugin, Command (retired — ADR 0037)

**MCP server**:
One configured Model Context Protocol server instance made available to a Run so its Tools, resources, and prompts can be used, identified by a Cogwork-owned `McpServerId`. It retains the verified MCP Registry name/version as provenance when available; runtime `serverInfo` is observed metadata, never the configured identity.
_Avoid_: MCP skill, Tool, Connection, Plugin

**MCP server readiness**:
The Engine-owned conclusion that a configured MCP server is enabled, launchable or reachable, authenticated, protocol-compatible, exposes the expected MCP features, and can be projected by the selected Harness. Its *authenticated* input is **Connection readiness** when the server requires a Connection. Required servers must be ready before a Run Plan is accepted; clients use the same result and reason to show Operation availability.
_Avoid_: Installed, runtime `serverInfo`, UI-only validation

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
_Avoid_: Middleware

**Subagent**:
A named agent definition available for delegation by a parent agent. It remains a distinct Run Plan field even when a Harness projects it as a Tool. A person writes one as `agents/<name>.md` in an **Authoring tree**: YAML frontmatter with a required `name` (lowercase letters, digits, and hyphens, equal to the file name), a required `description`, an optional `tools` list (a YAML list or a comma-separated string), and an optional `metadata.model-level` (a **Model level**; absent means `standard`), then the prompt as the body. A file that does not decode still reaches the Run Plan, with the reason. A vendor `model` value is one such reason; `model: inherit` is not.
_Avoid_: Tool, Harness, Operation

**Sandbox policy**:
The allow, ask, and deny rules governing Tools, file writes, and network access during a Run.
_Avoid_: Middleware, Harness execution boundary

### Workflows

**Workflow**:
A person's reusable automation: one or more **Triggers**, the **Operations** they start, and the **Transitions** that route each Operation's answers, over a **Workspace selection**. The engine owns the routing; agent judgement is what separates one Operation from the next. Workflows compose through what they create — an issue, a pull request, or a comment one Workflow makes can trip another's Trigger.
Each Workflow has its own on / off, which a person sets and which is not part of its document. The daily budget and concurrency limits stay daemon-wide. The coding pipeline is a **Workflow template** like any other; no engine-authored Workflow remains.
_Avoid_: Playbook, automation (Cursor's word for the same idea), pipeline (except in the name of the coding pipeline), run

**Workflow document**:
The one schema-validated definition of a Workflow: its name, Workspace selection, Triggers, and Operations. Every author writes the same document — the editor, a Workflow template, a future agent — through the same command RPCs; the editor is one client, never the contract. It holds references — catalog keys, Workspace ids, Operation ids — never display copies, and it holds neither the Workflow's id nor its on / off, so a document can travel between people. Node ids are author-chosen and never change; a rename changes only the name.
_Avoid_: Workflow definition, Workflow config, draft (nobody keeps a private copy — see **Working copy**), spec

**Working copy**:
A Workflow's one shared, editable document. Every author changes it only through **Workflow edits**, which the daemon applies in arrival order, so no write rests on a stale base. It may be incomplete, never malformed.
_Avoid_: Draft, local copy, unsaved changes

**Workflow edit**:
One typed change to a working copy, naming its target by stable id. A whole document enters only through *create* — a new Workflow, a copy of a template, an agent's first version; every later change, from a person or an agent, is a list of edits applied as one.
_Avoid_: Save, patch, update (the whole-document save it replaced)

**Published revision**:
The revision of a working copy that a person **published**, and the only one the engine runs. Publishing names the revision the person sees and refuses when a newer edit has arrived, so an edit from anyone changes nothing that runs until a person publishes it. Each admission reads the current published revision and each Run records the one it ran; no older revision is kept.
_Avoid_: Version, release, saved Workflow, *source revision* (the source value a Trigger fires on)

**Diagnostic**:
One finding of the Workflow validator, returned as data: a stable code, a location by stable ids, a message, and a class. **Malformed** refuses the whole edit; **incomplete** blocks publish; **advisory** never blocks. Machine state — a Connection or a need that is not ready, a missing Harness — is only ever advisory, and switching a Workflow on has no diagnostic gate. One validator serves every client, and the daemon's answer is final.
_Avoid_: Error, warning, lint, validation failure (an incomplete working copy is not a failure)

**Workspace selection**:
Which Workspaces a Workflow observes and acts in: every Workspace, or a listed set, which may be empty. A field of the document, not a **Scope** — a Scope is where a setting lives, and this is what the Workflow is about. For a tracker or pull request Trigger it is where the Trigger observes; for a Granola or Slack item, which names no Workspace, it is the candidates the agent chooses from, plus *none recognized*.
_Avoid_: Scope, workspace filter, target

**Workflow template**:
A Workflow document that Cogwork ships. Using one is *create* with its document, and the result is the person's own Workflow: an app update never changes that copy, which changes only through what it names — an Operating-instructions package, a catalog entry's code. The Workflow records no template, so a copy is deleted like any other, and nothing installs or switches on by itself.
_Avoid_: Default Workflow (as a kind), preset, blueprint, built-in Workflow

**Trigger and action catalog**:
The engine-owned list of every Trigger entry and action entry a Workflow document may name, read through a query and never held as a constant in a client. Each entry is keyed by its connected app first (`github.create-issue`, `linear.issue-has-label`) and declares what it requires and its **parameters**; a Trigger entry also declares the item kind it yields, which fixes the Work context, and an action entry its target, the item kinds it acts on, and its **agent inputs**. A client that has only the RPC can author every Workflow the editor can.
_Avoid_: Bare *catalog* (spent — see **Plugin catalog**), Plugin catalog, Model catalog, connector list, `connectorOnly` (retired — an entry *requires*, and the catalog hides nothing)

### Triggers

**Trigger**:
A Workflow's start rule: one Trigger entry, its parameter values, its **Trigger filters**, and the Operation it starts. Every Trigger is level-triggered: it fires once for each new **source revision** of a Work item. The parameters and filters on one Trigger must all match; any one Trigger of a Workflow may start it. An issue Trigger matches open issues only: a closed or canceled issue never matches, with or without a filter.
_Avoid_: Event (that is a **Trigger event**), Hook (a contribution kind), webhook, follow-up trigger (the fixed pipeline's wake conditions)

**Trigger filter**:
A catalog entry of kind *filter* that narrows a Trigger to items it holds for (*Issue is not blocked*). A filter belongs to one app and item kind, and a Trigger may name only filters of its own entry's app and item kind. The Trigger source decides it: it lists on each event the filters the item passes, and Trigger observation admits a subscription only when the event passes all of its filters. Before a Run claims an item at its Trigger's start Operation, the source checks the item again: a closed, gone, or unlabelled item is skipped with the reason, with no attempt and no park; an item that only fails a filter waits until it passes.
_Avoid_: Condition (a Trigger entry kind), parameter (an author-set value, not a test of the item), guard

**Condition / occurrence**:
The two kinds of Trigger entry. A **condition** (*Issue has label*) fires for every item that matches, including items that already match at switch-on; its source revision is the moment it became true. An **occurrence** (*New comment from a person*) fires only for events after switch-on, and events while the Workflow is off are skipped, never replayed. An entry's name states its kind.
_Avoid_: State / event, *filter* (that is a **Trigger filter**), *condition* for what a Transition matches (say its answers)

**Parameter**:
An author-set, typed value on a Trigger or an output action — a label, a channel, a schedule time, a review event — with fixed choices or a live list a Connection supplies. Only the author sets one; where the agent must choose, the author asks a **question** and routes on its answer.
_Avoid_: Option (that is a **model option**), *filter* (that is a **Trigger filter**), setting, argument

**Catch-up window**:
An occurrence entry's parameter that bounds how far back its Trigger source reads after the daemon was down. Events older than the window are skipped, and the read model reports them.
_Avoid_: Replay window, backfill

**Quiet period**:
An ambient Slack Trigger's parameter: how long a conversation must stay silent before the Trigger fires, so one Run reads a finished exchange. Beside it, *at most every* bounds how often one conversation fires.
_Avoid_: Debounce, delay, cooldown (that is *at most every*)

**Sweep**:
A schedule Trigger with a selector over Work items that already exist — their source, state, and idle time — that gives each selected item one Run. Each sweep starts a new lineage, and the idle time bounds how fast it can repeat.
_Avoid_: Batch, cron job, scan

**Trigger source**:
The observer of one source — the issue tracker, source control, Granola, Slack, or the clock — that emits Trigger events for its subscriptions. It sees subscriptions (an entry, its parameter values, and its Workspaces), never Workflows, and writes nothing; the engine admits its events and pairs them with Triggers. Receiving events instead of polling is a change inside one source, never a second model.
_Avoid_: Sensor (the self-correction layer's health watcher), connector, listener, webhook

**Trigger event**:
One observation a Trigger source makes: the Work item it names, that item's new source revision, its **cause**, and its time. A redelivered event names a revision already seen and starts nothing.
_Avoid_: Webhook, delivery, notification, Daemon event (the client feed)

**Source revision**:
The value from a source that moves only when its event happens again — a newest comment id, a head SHA, a Granola update time, a Slack `ts`, a scheduled instant. Each Work item carries an observed and a processed source revision and is eligible when the first is ahead and no claim is held, so edits during a Run combine into one next Run. The engine owns revisions; no author writes one.
_Avoid_: Bare *revision* (a Workflow has a **published revision**), version, watermark (a read position, not the authority)

**Origin record**:
The engine's record on each artifact it creates — an issue, a pull request, a comment, a Slack post — naming the Work item and Run behind it. Cogwork writes through the person's account, so the account cannot tell Cogwork's writes from the person's; the origin record does. It decides a Trigger event's **cause** and carries lineage across Workflows, and a Slack post Cogwork made never moves the source revision of the conversation it lands in.
_Avoid_: Bot marker, actor check (the account cannot decide), provenance (the Run Plan's stamp)

### Operations

**Operation**:
One unit of agent work in a Workflow: each Run executes one Operation, with one Work item's context in and one typed **Operation result** out. An Operation has no kind — any registered Harness runs any Operation — and the one thing that varies is its **permission profile**. Triage, implement, and follow-up are the coding pipeline's Operations.
_Avoid_: Lifecycle stage (retired), stage, step, task type, Operation kind

**Permission profile**:
What an Operation may do to files — `read-only`, the default, or `full` — and so the checkout the engine gives it: a scratch directory when no Workspace applies, the Workspace's own checkout for `read-only`, and a branch worktree for the item for `full`. A `full` Run in the person's own checkout cannot be expressed.
_Avoid_: Sandbox policy (the Tool, file, and network rules), Operation kind, checkout mode

**Operation definition**:
An Operation's contract, as its Workflow document states it: its Operating Instructions, permission profile, required needs, **questions**, **agent inputs** and their hints, and whether it answers once or for each finding (**fan-out**). The person — or an agent they work with — authors it. A required need names a concrete identity — an MCP server, a Skill, a Connection — and requiring never narrows what else a Run receives. The engine adds the needs the Operation's Triggers, actions, and resource references imply; the author never writes those.
A required need that cannot be satisfied — including a required Connection or MCP server that is not ready — is a Run Plan rejection, uniform across kinds. Rejection is recorded with its reason, but it is a fact about the machine's readiness, never a failed attempt: it does not move the item toward exhaustion, and it never parks the item waiting for a human. The item waits in view with the reason and is admitted when the need is ready. A failed attempt is work an agent was given and could not do.
_Avoid_: Playbook, run plan, operation settings, Operation kind

**Operation settings**:
The person's default Harness, model, and model options for every Operation, held at the Scopes the **Scope** table allows. They fill whatever an Operation's model choice in its document leaves empty and never outrank it: a default must never outrank a value that names the work. No setting names a user-authored Workflow, because its document already holds what the Workflow and Operation levels held; its permission profile, required needs, and on / off have no override. A Plugin only offers, and can never mark itself required for an Operation it does not own.
_Avoid_: Playbook, operation definition, run plan, target (say default / Workflow / Operation)

**Question**:
What an Operation's author asks the agent to decide, with a closed set of **choices**; the agent's pick is its **answer**, and Transitions route on answers. The engine adds what an author never writes: the `stuck` flag, and — when an action takes its Workspace from the agent — the Workspace the element is about. Each Action entry's Workspace source decides this: an `item-else-agent` action takes the Workspace of an issue or pull request item from the item, and takes it from the agent only when the item has no Workspace; an `agent` action always takes it from the agent.
_Avoid_: Outcome (overloaded — say answer, or Operation result for the whole value), route condition, enum, disposition

**Agent input**:
A field the agent fills in its result for an output action to use — `issue_title`, `pr_body`, `review_comments`. It is a required string, or a list of one engine-defined shape (a review line comment). It is empty when no matched Transition uses it, and refused at decode when a matched Transition needs it and it is empty. Its **hint** is the author's guidance for it, one per field, so two actions that share a field share one value and one hint.
_Avoid_: Output field, template variable, parameter (the author sets that)

**Fan-out**:
An Operation that answers *for each* finding instead of *once*. Its result is a list of **elements**, up to an engine cap, each with its own summary, answers, and agent inputs; each element becomes a child Work item that the engine routes by itself, and an empty list means there is nothing to do. The engine does the split; the author writes only the cardinality.
_Avoid_: Split, map, batch, loop

**Transition**:
What follows one combination of an Operation's answers: the **output actions** to perform and at most one **hand-off**. A Transition is identified by the answers it matches, and the engine owns the routing. Every combination must reach a Transition that does something — *Stop* is how an author says "nothing" — or the document cannot be published; when several Transitions match, their actions join, and together they may name only one hand-off. A failed Run follows the engine's own failure path — retry, then exhaustion, then a park — on which an author cannot route yet.
_Avoid_: Route (the prototype's word), edge, branch, workflow step, condition (a Trigger entry kind), Operation

**Hand-off**:
A Transition passing its Work item to another Operation of the same Workflow. A Transition has at most one, because a Work item holds one Claim; the next Operation reads the item again at its own admission and also receives the previous Operation's result. An Operation never hands off to itself, and every hand-off is a **hop**.
_Avoid_: Route, next step, *hand off to a person* (the older sense — say **park**), Trigger (the other way to start an Operation, through an artifact)

**Output action**:
One write a Workflow makes on a shared system — create an issue, open a pull request, post a review, reply in Slack, add a label — named on a Transition by its action entry and parameter values. The engine performs every output action; an agent never writes to a shared system itself. Each acts through the person's **Connection** for its app, so a Workflow acts as the person, within what the person published.
_Avoid_: Tool (an agent calls that during a Run), side effect, step

**Action plan**:
The frozen, typed list of writes that one element's matched Transitions produce, recorded before the first write: each step's action entry, parameters, agent inputs, target, and write key. The engine runs it in a fixed order — approval, then writes in document order, then *Notify me*, then the hand-off or *Stop* — and a write key makes a repeated step do nothing. A failed write never runs the agent again: a retryable one is tried again later, and a permanent one parks the item with `write-failed`, whose handback runs the rest of the plan.
_Avoid_: Run Plan (the resolved input of one Run), outbox, script, batch

**Operating instructions**:
Reusable guidance an agent must follow when performing an operation, resolved separately from the work-specific facts supplied for one run. For a Workflow Operation they are the **Operating-instructions package** it names, if any, and its inline instruction, with the engine's short framing and the Operation's questions and hints in the same layer — last and highest, above every Rule.
_Avoid_: Skill, playbook skill, prompt, work context

**Work context**:
The work-specific facts supplied to a run, in one frozen shape for each item kind: an issue's body and comments; a pull request's description, review comments, checks, and changed files, but never its diff; a Granola transcript; a Slack message or conversation with its thread; a schedule tick's fire times. It also records which Trigger fired and when, and the artifacts this item's lineage already created. After a hand-off, the next Operation gets the item read again plus the previous Operation's result. No source has options: one shape per kind.
**The engine supplies them; the agent never fetches its own brief.** The work item's prose — and, for follow-up, its pull request's description and review comments — is read once, at admission, and frozen into the Run Plan, so a Run starts with its brief and a tracker MCP server is at most optional context. A steer posted mid-Run reaches the next round, not this one. See ADR 0030.
_Avoid_: Operating instructions, prompt template, workflow settings

**Resource reference**:
A typed pointer from frozen Work Context prose to one resource in an external system, such as a Figma frame, derived by the Engine at admission. Each one makes a ready MCP server that **reads** its system a required need of that Run. A server only declares which systems it reads, so the requirement stays the Engine's and no Plugin marks itself required.
_Avoid_: Link, attachment, design spec, conditional need

The relationship is:

```text
Workflow                         (id and on / off live outside the document)
└── Workflow document            (working copy → published revision)
    ├── Workspace selection
    ├── Triggers
    │   └── Trigger entry + parameters → start Operation
    └── Operations
        └── Operation
            ├── Operation Definition
            │   ├── Operating Instructions
            │   ├── permission profile
            │   ├── required needs
            │   └── questions, agent inputs, cardinality
            ├── model choice     (empty parts filled by Operation Settings)
            └── Transitions      (the answers each matches)
                ├── output actions
                └── hand-off     (at most one)

Trigger event → Work item → selected Operation + Work Context
    → Run Plan
      ├── Harness Adapter
      ├── Instructions        (Operating Instructions + resolved Rules)
      ├── Tools
      ├── Skills
      ├── MCP
      ├── Subagents
      ├── Hooks
      ├── Middleware
      ├── Sandbox (Workspace, Policy)
      ├── Structured Output
      ├── Persistence
      ├── Connections
      └── Provenance
    → Run
    → Operation result → Action plan → output actions
```

**Priority**:
One of `urgent`, `high`, `medium`, `low` — a four-level scale (`priorityRank`, highest first) that orders work *within* an operation and nowhere else. Operation is always the primary sort key, so a low-priority follow-up still runs before an urgent implementation; priority only breaks ties between items selected for the same operation, and stable tracker order breaks ties between items of the same priority. Every observed item carries a resolved priority. Each adapter reads its own tracker's field and maps it onto this scale (`resolvePriority`, case-insensitive); anything absent, blank, or unrecognized becomes the `defaultPriority`, `medium`. Priority orders work — it never gates eligibility — so a value we can't read must never drop an item; it just lands in the middle.
For GitHub, `issueTracker.priority.field` is the stable numeric ID of an organization single-select issue field. Clients fetch the compatible catalog through the workspace's bound Connection and store a selection; they never ask a person to type GitHub coordinates. The adapter reads that ID from the issue-field values included with each listed issue. For Linear, priority is native and needs no configuration.
_Avoid_: Operation priority (that's the fixed operation order), severity, weight, rank (alone — `priorityRank` is the ordering, priority is the value)

**Triage role**:
A label value a coding Workflow's Triggers can match and its Transitions can add, such as `needs-triage` or `ready-for-agent`. The engine gives the value no built-in meaning.
_Avoid_: Status, state, label (when you mean the role's meaning)

**Requirements digest**:
The requirement details triage resolves from a work item's linked artifacts — final copy, design node links, decisions made in chat threads — and inlines into its proposal, so the work item becomes a self-contained brief. Context acquisition is triage's job, done once; an implement Run consults an external system only where the digest points at it. See ADR 0029.
_Avoid_: Brief (the whole item and thread — the digest is the part triage adds), work context (the engine-supplied facts, not tracker content), triage proposal (the digest rides in it)

**Review requirements**:
The judgment reviews a work item's shape demands, named by triage in its proposal and honored by the implement Run. Selection, never exemption: the security review runs on every diff regardless of what triage named. See ADRs 0027 and 0029.
_Avoid_: Review policy, gate (the local gate is checks, not reviews), required needs (the Operation definition's contract, not per-item flags)

**Blocked / blocker / blocking**:
An item is *blocked* when its issue tracker reports one or more open **blockers** — upstream items that must close before it can be worked — and it is *blocking* the items downstream of it. Blocking is the issue tracker's own dependency relation (GitHub issue dependencies today; Linear blocking relations when its adapter reads them), read per adapter. A blocked item is held out of the implementation operation until its blockers close, then becomes eligible on its own — no human acts. Neither eligible, claimed, nor needs-human.
_Avoid_: Depends-on (the inverse framing); needs-info / ready-for-human (those are needs-human — a person clears them); stuck / exhausted / stalled (failure outcomes, not dependencies).

### Human touchpoints

**Human touchpoint**:
A point where a Workflow reaches the person instead of a shared system: the Cogwork action entries *Notify me*, *Wait for my approval*, and *Hand to me*, and the parks the engine makes by itself. An author routes to them like any output action, and every client shows them on the **Board**. Human gates are the author's choice; the engine adds no approval gate of its own.
_Avoid_: Human-in-the-loop step, checkpoint, gate (the engine has no approval guard)

**Park**:
The engine holding a Work item for the person, with a **park reason**, until a person acts: approves, rejects, chooses an answer, or hands it back. Any client may send those commands as the Principal; each names what it acts on — a plan digest, a parked attempt — and refuses when that is no longer current. A Workflow Run never gets them as Tools.
_Avoid_: Needs-human (the fixed pipeline's narrower set), blocked (open dependencies), pause, hold

**Park reason**:
Why a Work item is parked, as a tagged set: `stuck`, `exhausted`, `hop-cap`, `missing-operation` (a hand-off to an Operation the current published revision lacks), `write-failed`, `draft-outcome-unknown` (a Slack draft might exist, so Cogwork will not try it again), `no-workspace-recognized`, `awaiting-approval`, and `handed-to-you` (the *Hand to me* action). `stuck`, `exhausted`, and `hop-cap` are failures; `awaiting-approval`, `draft-outcome-unknown`, `no-workspace-recognized`, and `handed-to-you` are not, and move no failure counter.
_Avoid_: Needs-human reason (its two values become labels a Workflow adds), halt reason, error

**Approval**:
A person's consent to one frozen action plan, named by the plan's digest. *Wait for my approval* on any matched Transition holds the element's whole plan behind it. The person approves (the plan runs verbatim), edits agent-input text and approves the new digest, rejects (as *Stop*), or hands back with a note; a new source revision withdraws the plan and admits the item again.
_Avoid_: Approve (the fixed pipeline's triage button, which **Choose an answer** replaces), review (a pull request review is an output action), confirmation

**Choose an answer**:
The command a person uses on a `handed-to-you` park: they choose the parked element's answers and write any empty agent input the matched Transitions need, and the engine builds and runs the plan as if the agent had answered. It names the parked attempt and refuses when that attempt is not current.
_Avoid_: Approve (that names a plan, not an answer), reclassify

**Notification**:
The record *Notify me* makes of one element — its summary, the item, the matched answers, and the artifacts its plan created — kept on the Board until dismissed. It does not park the item, and it lives in the disposable Run ledger. The desktop may also raise it as an OS notification; the daemon never does.
_Avoid_: Alert, park, Daemon event (the client feed)

### Coordination

**Claim**:
A coordination record marking an item as being worked: `by`, `claimedAtMillis`, an optional operation, and its **lineage**. Persisted in the Control store for every item, tracker items included (ADR 0036), so it survives a daemon restart; crash recovery releases one a stopped daemon left behind.
_Avoid_: Lock, lease, reservation

**Refused claim**:
A claim the coordination authority will not accept, such as a claim on an item whose source revision was never observed. Distinct from a *contended* claim (`claim-held`), which the scheduler avoids by offering only unclaimed admissions. A refused claim is not *exhausted*: no run started, so there is no attempt record and no `RunStatus`.
_Avoid_: Contended claim, stale claim (one we release), exhausted (a run that gave up after trying)

**Attempt record**:
A coordination record of one finished operation attempt on an item: its Operation — keyed by Workflow and Operation, not by lifecycle stage — its outcome (`succeeded` / `failed` / `abandoned`), its time, and its **lineage**. Persisted in the item's coordination authority, as a **Claim** is.
_Avoid_: Run — a run is the local execution; an attempt is the durable outcome

**Handback record**:
A coordination record of a person returning a parked item to the control plane: `by` and `atMillis`. Persisted in the item's coordination authority, as a **Claim** is. The failure counters — exhaustion, stall, crash loop, and the **hop** cap — count only what happened after the newest handback, so a handback discounts an item's failure history without erasing it. The inverse of a **park**: the control plane parks an item for a person when it gives up, and a person hands it back. A second handback moves the line forward.
For a Workflow item a handback resumes the Operation that parked — or, after a `write-failed` park, runs the rest of the action plan — and the resumed Run receives the person's note when the handback carries one.
_Avoid_: Retry (the control plane's own automatic re-attempt of a *retryable* failure — a handback is a person acting, not the engine), reset, unpark, pardon

**Lineage**:
The chain of Runs that one person's act or one source event started: a root, and for each Claim and Attempt record its parent, held in the item's own coordination authority. A hand-off, a fan-out child, and an event whose **cause** is Cogwork's own write keep the lineage; an event a person caused, a schedule tick, and a sweep start a new root.
_Avoid_: Trace, thread, history, Session (one Harness conversation)

**Hop**:
One step that extends a lineage — a hand-off, a fan-out child, a Workflow start that inherits a lineage, or a Run admitted on a source revision the lineage itself caused, such as a follow-up push that CI then fails. The **hop cap** for each lineage is engine policy and a failure counter: reaching it parks the item with `hop-cap`.
_Avoid_: Cycle, depth, round

**Round summary**:
What a follow-up round tells the reviewer, posted by the engine to the pull request under the actor identity with the coordination marker attached. The one control-plane write that lands on the pull request rather than the issue tracker; the marker is what keeps it out of the human-feedback signal, and it stays the engine's to attach.
**A round speaks to answer a question, never to narrate a state.** A round that pushed always posts. A round that pushed nothing returns a `speak` decision and posts only when it declines or answers something a person or a trusted bot asked — a nit it judged wrong, a finding it judged a false positive — so the asker learns why and does not raise it twice. A round that nobody asked anything of stays silent. Its summary still reaches the coordination comment either way, so a silent round is traceable.
_Avoid_: Round comment, agent note (that's free-text operator prose), coordination detail (that lives on the tracker and carries the reason an item parked)

### Credentials

**Credential store**:
The daemon's credential source for Connections: stored API keys, environment-variable references, OAuth token pairs, and GitHub CLI source markers keyed by system and account. At run time it **acquires** the current GitHub CLI token for the Connection's fixed account and holds successful acquisitions in memory for ten minutes; the token is never persisted. Slack's user token and rotating refresh token are one stored OAuth credential. A seam: the backing layer is a `0600` file today, an OS keychain on desktop, a per-user database row on a hosted server. Unlike the run ledger it is **not** disposable — losing it logs the daemon out — and it is never committed to the repo. Linear, GitHub, Granola, and Slack acquire credentials through it. It holds the secret half of a **Connection**, whose non-secret record lives in the Control store.
_Avoid_: Run ledger (that one is disposable), config (the non-secret `client_id` lives in config, not here), keychain (only one possible backing layer).

### Runs

**Run plan**:
The immutable, engine-validated resolution of one Operation and its Work Context. Its members, named after TanStack AI: Harness Adapter, Instructions, Messages, Work Context, Tools, Skills, MCP, Subagents, Hooks, Middleware, Sandbox (optional Workspace and Policy), Structured Output, Persistence, Connections, and Provenance. Messages contain the resolved user turn. Instructions stay separate. Work Context freezes the admitting snapshot's coordination facts and the work item's prose — its body and comment thread, read through the issue-tracker port at admission — beside the work-item reference (ADR 0030).
Run Plan members are **not** the same list as contribution kinds. Rules is a kind but not a member — it resolves into Instructions. Tools, Connections, and Middleware are members but never contributions.
Every plan carries a mandatory **provenance stamp**: a Plugin item's declared version where it has one, a content revision where it does not. No contribution carries its own version — no platform in the field versions the capabilities inside a bundle. The plan is accepted before dispatch and never changed by runtime observations.
_Avoid_: Run manifest, resolved stage, harness request, operation settings

**Run**:
One execution of one run plan by one harness, captured with its events, outcome, usage, and timings. The run records what was projected and observed without changing its plan.
A Run is `declined` when the Harness finished its work but the Engine refused the requested pull request because the pushed head was missing or not ahead of its base. The decline is an Engine outcome, records a failed coordination attempt, and releases the claim for normal retry or a park. In a Workflow the same refusal is the precondition of *Open a pull request*, checked when the engine builds the action plan.
_Avoid_: Attempt (the durable coordination form), job. Do not confuse with the harness's `RUN_STARTED` / `RUN_FINISHED` stream events, which are moments inside a run.

**Run ledger**:
The daemon's local store of runs, their immutable Run Plans, and their events — in-memory, or a region of the Control store on disk. A Run and its Plan are accepted together before dispatch, keyed by Run ID. It also holds run history, harness sessions, and token usage. It does not hold the scheduler's daily usage, and losing it is safe because coordination lives in the Control store outside the ledger's region and stays authoritative.
_Avoid_: Source of truth, database, backlog, Control store (the ledger is one disposable region of it).

**Run event**:
One persisted, sequenced entry in a run's stream — an encoded harness event stored with a `seq` and timestamp.
_Avoid_: Log line, message

**Run activity**:
A live envelope broadcast while a run is in flight: run identity (run id / sequence / timestamp), the correlation ids for grouping, and the one whole harness event. What the watch stream carries. The same shape is rebuilt when a settled run's persisted events are replayed for the run drill-in, so live and history read identically.
_Avoid_: Run event (the persisted form), notification

**Session**:
A first-class entity with its own `SessionId`, grouping the runs that make up one conversation — a run points at it by foreign key (`RunRecord.session`), and runs on the same branch share one while their selected harness remains unchanged. Every session is permanently owned by the harness that created it and can be resumed only by that harness; model, model-option, operation, and instruction changes do not affect compatibility. A fresh start always mints a new session. It comes in two kinds. An **owned-transcript** session is the provider runner's: the whole conversation lives in our run ledger, so its transcript folds straight from the events and no handle is kept. An **opaque-handle** session is a CLI harness's: the harness keeps its own history and hands back an opaque `handle` (e.g. Cursor's session id) we store to resume it — `null` until the harness emits one. The kind is not a guess: each harness runner declares its `SessionKind` beside its name, and the session store mints the matching one. The session is minted when the run is inserted, before the harness has said anything (see engine ADR 0002), so a run always names a session even before it can be resumed. A Workflow Run resumes a Session for one of three reasons, in this order: a pending action plan, a hand-back, or a schema-mismatch **Refused result** of the previous attempt for the same item and Operation. The third resumes only when the refused attempt's Session belongs to the selected Harness and can resume (an owned transcript, or an opaque handle that is not `null`); otherwise the Run mints a new Session.
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

**Exhausted / stuck**:
The two failure outcomes that stop spending tokens after work starts. A Run is *exhausted* after three consecutive failed attempts for one Workflow Operation. An agent is *stuck* when its result reports it cannot proceed; the item parks at once with the summary. A new qualifying source revision can clear the park as a handback. Both are distinct from *blocked*, which is unresolved dependencies before an attempt.
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
The controlled model and option choices one Harness offers: checked-in managed data shipped by that Harness's package, never a runtime observation (ADR 0024). Generated catalogs record the CLI version they were generated against; manually managed catalogs need no invented generator version. Provenance has one value, `managed`. An unsupported option is absent, and a saved choice missing from the current catalog is stale rather than free-form input.
Composite native model ids also publish their normalized selections as the validity oracle for clients that must disable sparse option combinations.
Clients read every registered Harness's catalog through `GetHarnessCatalogs`. That query reads managed data only and never waits on Harness readiness.
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

**Model level**:
The named capability a role or operation asks of its model — `light`, `standard`, or `deep` — instead of a vendor model name. `light` is the cheapest capable model on whatever Harness runs it; `standard` is the Run's own model or the tool's default, rendered as omission where the tool inherits by omitting; `deep` is the reasoning escalation, named and unused. The level is the only model vocabulary a role definition or instruction may use; the mapping to a Harness-native value lives with whoever projects the role (the sync toolkit today, whose tier of the same three words this names, the Harness adapter once Subagents project). See ADR 0028.
_Avoid_: Tier (sync's word for its rendering mechanism), pinned model, vendor alias (`sonnet`, `haiku` — those are one Harness's native values), `fast` / `default` / `powerful` (sync's retired tier names), level (bare — that word belongs to where an Operation setting is written)

**Harness readiness**:
An observation of one Harness's installation, compatible version, and selected authentication binding on the current Runtime host. It can block a Run when negative but never guarantees that a later launch will succeed, and it never selects a fallback Harness or authentication mode.
`GetHarnessReadiness` reads the daemon's cached observations. Probe completion publishes the replacement cache through `HarnessesChanged`; neither read path runs a probe.
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
The tagged, Effect-Schema-defined value an operation returns through the harness stream. For a Workflow Operation the engine derives the schema from the published Operation, with no unions and no optional fields: a summary, the `stuck` flag, and one element — or, for a **fan-out**, a list of elements — each holding its answers, its agent inputs, and, when an action takes its Workspace from the agent (see **Question**), a Workspace. One engine module accepts the result from the final `structured-output.complete` Harness event, or gives a **Refused result**. After a schema-mismatch refusal, the next attempt resumes the refused attempt's **Session**, and its work request is the refusal's agent text: send the result again and do no other work unless an issue needs it. That resumed Run is a usual attempt, so the attempt limit still applies. A refusal of another kind does not resume the Session.
_Avoid_: Footer, sentinel, disposition line, text protocol

**Refused result**:
The typed reason the engine does not accept an **Operation result**. Its kinds are: the result does not match the schema (each issue's path and message), the action plan refuses it (the plan's message), pull request readiness declines it (the readiness reason), and the Harness stream fails before it gives a result. Each kind has two renderings. The agent text tells the next attempt what to change, through the `previous-result-issues` Run Plan resource. The person text is plain language for the attempt record and the `Exhausted` park reason that Attention shows; it never holds an Effect `Cause` dump. A refused result is a failed attempt, so three in a row make the item *exhausted*.
_Avoid_: Refused claim (a claim coordination will not accept), decode issues (only one kind), error string

**Operating-instructions package**:
The Operation-owned instruction document and supporting resources carrying its mandatory Operating Instructions. It is supplied explicitly to every Harness through an instruction-specific content and resource path; `SKILL.md` is reserved for real Skills. The engine ships the default packages, an Operation in a Workflow document names one by name, and a Workspace may replace it whole with an operator-authored package in its private overlay tree (`~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/`); a replacement that is present but has no readable, non-empty `INSTRUCTIONS.md` fails the Run rather than falling back. Either source stays mandatory, last and highest in the instruction ladder, and is never a contribution (ADR 0019).
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
The status-facing shapes of a classified work item — eligible-to-run, currently-claimed, blocked on open dependencies, parked for a person, and an approved pull request waiting for a person to merge it. Narrowed views of a work item, not new entities. The first four carry an optional **PR summary** when the source control provider resolved a pull request for the item; an item with no PR omits it. A ready-to-merge item carries a required PR summary and is neither eligible, claimed, blocked, nor needs-human. A needs-human item also carries the halt reason and, when triage self-halted it, the **inline triage proposal** — the agent's proposal/question text, re-derived from the tracker on every reconcile so a surface can render the question in place without reading the comment thread. It is `null` when nothing self-halted the item (for example, an exhaustion park).
_Avoid_: Reusing "work item" for these narrowed views

**Inline triage proposal**:
The agent's triage proposal/question text carried on a self-halted item's read model, lifted off the separate conversational tracker comment that still holds the human-facing copy. Present only when triage parked the item; re-derived from the tracker on reconcile, so it survives a daemon restart with no local state.
_Avoid_: Coordination detail (that carries the reason an item parked, not the proposal), proposal comment (the tracker comment this is lifted from)

**PR summary**:
The read-model view of a classified item's pull request, resolved by the source control provider from the item's link key: the PR number, a deep-link URL, its checks and review status, its mergeable / base-divergence signal, and a wait-time signal (the PR's last-activity instant, from which a consumer reads how long it has been waiting). Present only on items that have a PR. Shaped richly enough to host a later in-app review panel; the review and merge actions themselves stay on GitHub, reachable through the URL.
_Avoid_: Observed PR (the engine-internal form the provider reads, which also carries follow-up coordination state), PR state (too vague)

### Client RPC

**Query RPC / command RPC**:
The two kinds of RPC a client sends the daemon. A *query* reads daemon state and changes nothing. A *command* changes daemon state or behavior — cancel a Run, edit or publish a Workflow, or pause the scheduler. The split follows CQS/CQRS and gives the trust boundary one place to guard commands more strictly than queries. `DaemonQueries` and `DaemonCommands` are the two groups; `DaemonRpcs` is their merge.
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
