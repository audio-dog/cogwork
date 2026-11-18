# Configuration: settings and Resolution

Part of the [Contracts (shared kernel)](CONTEXT.md) glossary.

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
