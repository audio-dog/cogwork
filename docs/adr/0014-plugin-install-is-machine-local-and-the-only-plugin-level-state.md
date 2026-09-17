# 0014 — Plugin install is machine-local, and the only Plugin-level state

- **Status:** accepted
- **Date:** 2026-08-25
- **Amended:** 2026-08-26 — [the answer is still no, and the fetch machinery is
  struck](#amendment-2026-08-26--the-answer-is-still-no-and-the-fetch-machinery-is-struck)

## Context

ADR 0011 gave a Plugin a manifest that points at files, an optional `version` with a mandatory
provenance stamp, and a Connection-requirements field. ADR 0013 enumerated the settings a person can
write and found five of six contribution kinds have exactly one. Neither said what happens between
discovery and removal.

The planning ticket asked for eight lifecycle phases — discovery, install, setup, enablement, update,
pinning, disablement, removal — plus catalog and local-source identities, dependency resolution,
offline behaviour, per-scope enablement, and partial failure. Working it produced two findings before
any of that could be answered.

**Four of the phases do not exist.** *Per-scope enablement* was settled by ADR 0013 and had nothing
left. *Dependency resolution* was ruled out by ADR 0011 — no inter-Plugin dependencies — leaving only
Connection requirements. *Disablement* decomposes into turning each contribution off and uninstalling,
because a Plugin contributes no behaviour of its own to disable. And a *Plugin-level on / off* has no
cause: the one prior-art trigger for a bundle-level disabled state is an unsatisfied inter-bundle
dependency, which cannot arise here.

**The remaining questions were answered by reading disk, not by reasoning.** Every plugin bundle
under `~/.codex/plugins/`, `~/.cursor/plugins/`, and `~/.claude/plugins/` holds the same small set of
files — a manifest, an `.mcp.json`, `skills/<name>/SKILL.md`, assets — and no secrets. What appears
instead is env-var *names* (`"Authorization": "Bearer ${SNOWFLAKE_PAT_TOKEN}"`) and public OAuth
client ids. Tokens sit in one file per harness outside every bundle. None of the three synchronizes
installed plugins between machines.

That last fact mattered most. The session had assumed an install is portable and then spent four
answers on the re-binding problem the assumption created.

## Decision

**An install is machine-local, and installing is the only Plugin-level state a person writes.**

- **The install record is the authority**, held in the Settings profile and keyed by `pluginId`
  alone, so one resolved identity is installed at a time. Nothing synchronizes a Settings profile
  today, so an install is machine-local in practice and no design may assume otherwise. Cross-machine
  ownership stays in map [#124](https://github.com/colonylabs/cogwork/issues/124)'s fog.
- **A Plugin references files; it never copies them into the record.** Placing a bundle's files on a
  host is engine ADR 0007's existing `provision`, and needs no new noun.
- **Provision is atomic** — write elsewhere, swap into the identity-keyed path — so a half-written
  bundle is unrepresentable rather than handled, and startup has nothing to reconcile.
- **There is no human-written Plugin on / off.** Install and uninstall are the whole of it.
- **Setup is establishing the Plugin's required Connections, and nothing else.** After install a
  Plugin's MCP server is **on**, and its Skills, Rules, Commands and Subagents are on disk and
  therefore active — see the 2026-08-26 amendment, which replaces this ADR's original "after install
  every contribution is off". A Plugin's incomplete setup never gates its contributions: incomplete
  setup is a *readiness* state, never an on / off. A Plugin only offers, and one whose missing token
  disabled its own Skills would be marking itself required for Operations it does not own. What
  narrows is the Operation Definition's declared needs, at Run Plan resolution.
- **Uninstall deletes every setting at every Scope the uninstaller owns** — Settings profile and
  Private workspace overlay. Committed Workspace input values survive as *dangling*, because that
  file belongs to the repository and possibly to a colleague.
- **An update that drops a contribution deletes its setting too.** A retained row buys a remembered
  choice for the fraction of users who ever roll back and costs a dead row per affected user forever.
- **`localName` is a stable contract.** Identity is immutable, so a renamed contribution is a drop
  plus an add: the old identity goes *dangling*, the new arrives with no setting.
- **A Plugin's files change without a person's act, and the change lands at load.** One thing
  changes them: an app update, which replaces the bundles that ship with Cogwork. Cogwork re-reads
  what is on disk. There is nothing to stage, accept, or decline. This **reverses** this ADR's
  original "the update trigger is an explicit user action, never the app update" — see the 2026-08-26
  amendment, which strikes the catalog fetch, the computed digest, and the catalog status set.
- **Partial install is per-contribution.** An unparseable manifest installs nothing, because the
  manifest carries the identity. A malformed pointed-at file yields no contribution, so it is simply
  not a member of the `union-values`, and any setting written for it is *dangling*.
- **Plugins owns membership; Customize owns contribution settings.** Customize may show a Plugin's
  rows, including one that failed to load, and may never write membership or credential state.
- **A bundle names a secret; the engine holds it.** A Plugin declares which credential it needs and
  never carries one. A bundle names an env key and the engine supplies the value; a bare `${NAME}`
  with no reference behind it is inadmissible, so a shell-sourced secret is unrepresentable in the
  schema rather than forbidden by instruction.

Offline, therefore: entirely. The **Plugin catalog** and every bundle ship with the app, so no step
in this lifecycle touches the network.

## Considered Options

- **A portable install record, re-bound per host.** Rejected — this was the session's own premise and
  no harness does it. It invented a status (*installed, not available here*), a re-binding flow, and a
  split between the record and its bytes, all to serve a synchronization mechanism that does not
  exist. Cross-machine ownership is fog, not a design input.
- **Install succeeds only once the bytes land.** Rejected as the mirror error: without a portable
  record there is no second machine to disagree about, so the two events do not need separating.
- **A Plugin-level on / off as set membership** — Plugin off removes its contributions from the union
  while preserving each stored setting. Coherent, and rejected: nothing needs the middle state, and
  ADR 0013's rule against speculative mechanisms applies.
- **Copy a catalog bundle at install, reference a local path in place.** Rejected: it contradicts
  ADR 0011's file-pointing manifest and buys two code paths for one term.
- **Retaining a dropped contribution's setting for revert's sake.** Rejected on cost at scale. The
  benefit accrues at the margin; the cruft accrues per user.
- **An entry-level version in the catalog.** Rejected: an authored value can disagree with the bundle,
  which is a documented failure in Claude Code, where the manifest value silently wins. A computed
  digest cannot disagree, only go stale.
- **Absence as the only catalog signal, with one free-text notice.** Rejected in favour of the MCP
  Registry's three states, so a Plugin and an MCP server report the same way and a withdrawal is
  distinguishable from a broken document.
- **A completeness marker checked on read**, which is what Cursor does — a zero-byte `.cache-complete`
  in every plugin folder. Not adopted: a marker is a guard every future reader must remember. Recorded
  as a **borrow** we deviate from, not a convergence.
- **A rename or alias map in the manifest.** Rejected: that is migration machinery, and nothing is
  publicly released, so a breaking change costs a migration of zero installs.
- **Version ranges and a resolver.** Rejected: ranges exist to serve bundle-to-bundle dependencies,
  which ADR 0011 ruled out.
- **A third surface for Connections.** Rejected while the Connection set is closed and first-party.

## Consequences

- Storage ([#126](https://github.com/colonylabs/cogwork/issues/126)) gets a closed field list and a
  single-key install record, and no install-history table.
- Customize ([#131](https://github.com/colonylabs/cogwork/issues/131)) gains a third row state beside
  ADR 0013's offer-versus-enable one: *this Plugin ships this Hook; it failed to load; here is the
  file.*
- An update must not touch an in-flight Run. Provision keyed by resolved identity makes that
  structural: an update writes a different key rather than mutating one.
- ADR 0013's reason for embedding the resolution trace in every Run Plan is this event — the stores
  no longer hold at read time what they held at dispatch the moment a Plugin updates.
- **Connection behaviour is deliberately not decided here.** Its glossary entry stays provisional and
  keeps its *Avoid* line. Establishment, health, re-grant and revocation wait on
  [#172](https://github.com/colonylabs/cogwork/issues/172); update-time consent and permission
  summaries are [#135](https://github.com/colonylabs/cogwork/issues/135)'s. The planning session
  answered four Connection questions anyway; those answers are struck.
- **Generalizing `MCP server readiness` to a `Readiness` term is deferred** for the same reason: its
  second instance would be Connection readiness, and the concept is undefined until #172 lands. One
  instance is a hypothetical seam.
- Whether a Plugin may name a Connection the Engine has never seen is #172's. The lifecycle path is
  invariant either way — install proceeds, a load-time diagnostic names the unrecognised id, and the
  refusal lands at Run Plan resolution — so only whether setup can ever complete differs.
- Declaring which host versions a Plugin supports remains unsolved across the field and stays in fog.

Full reasoning: [#125](https://github.com/colonylabs/cogwork/issues/125). Research:
`docs/research/plugin-and-connector-versioning.md`. On-disk prior art:
`~/.codex/plugins/`, `~/.cursor/plugins/`, `~/.claude/plugins/`.

## Amendment (2026-08-25) — the Connections surface exists, and establishing one installs a Plugin

This ADR deliberately excluded Connection behaviour and struck four answers it had produced anyway.
[#172](https://github.com/colonylabs/cogwork/issues/172) has now landed, and it changes three things
here. See ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md).

**The third surface is adopted.** This ADR rejected "a third surface for Connections" *while the
Connection set is closed and first-party*. That condition is the reason **for** the surface, not
against it: an Engine port's Connection — GitHub's, Linear's — has no Plugin over it, so Plugin setup
can never be its home. This ADR could not weigh that, having excluded Connection behaviour.

**Establishing a Connection installs the Plugin that requires it.** A person who connects Linear and
must then find and flip an MCP server has been handed a setup step disguised as a settings screen.
This amendment originally carved a narrow exception out of "after install every contribution is off";
the 2026-08-26 amendment below deletes that sentence, so establishment and a plain install reach the
same state with no exception to state. The term *paired install* is struck — see that amendment.

**The `Readiness` generalization is refused, not deferred.** This ADR expected Connection readiness to
be a second instance of a general `Readiness`. It is not a peer: *MCP server readiness* already
includes "authenticated", so Connection readiness is an **input** to it for a Plugin's MCP server, and
stands alone for an Engine port. `Connection readiness` is its own term and no umbrella is minted.

Unchanged and reused: install stays machine-local; provision stays atomic, which is why an abandoned
browser login leaves the install standing rather than rolling it back; *dangling* is the shape a
workspace binding takes when its Connection is removed.


## Amendment (2026-08-26) — the answer is still no, and the fetch machinery is struck

[#205](https://github.com/colonylabs/cogwork/issues/205) asked this ADR's "a Plugin-level on / off has
no cause" against Codex, whose `~/.codex/config.toml` carries `[plugins."browser@openai-bundled"]
enabled = true`. The answer holds. **This ADR's stated reason for it does not**, and two of its
mechanisms are struck outright.

### The reason was wrong; the conclusion was right

This ADR said the one prior-art trigger for a bundle-level disabled state is an unsatisfied
inter-bundle dependency. That is false about the field. `browser@openai-bundled` has no dependency to
be unsatisfied. It is a first-party pack shipped with the harness, carrying a person-written boolean —
the exact case Cogwork is in.

The real reason is a model difference, recorded as a **deliberate divergence**. A Codex plugin is an
application with a server behind it, which cannot be removed once bundled, so Codex needs a second
word for *off*. A Cursor plugin is a collection of contributable files, which is the model Cogwork
follows. **A file that is not on disk is already off.** So `uninstall` removes the bundle's files, and
presence on disk is the state.

This makes one rule cover the whole product. ADR
[0018](./0018-contribution-files-live-in-three-authoring-trees.md) already says presence is enablement
for a file in an **Authoring tree**. The same holds for a Plugin's files in the provision root.
Authoring or deleting a file is how a person writes presence for bytes they wrote; `install` and
`uninstall` are how a person writes presence for bytes they did not. No on / off at either level.

### After install, a Plugin's MCP server is on

"After install every contribution is off" was written before ADR 0018 deleted the setting from Skill,
Rules, Command and Subagent. It is now false twice over, and is replaced by:

- A Plugin's **Skills, Rules, Commands and Subagents** are on disk, so they are active. They have no
  setting to be off in.
- A Plugin's **MCP server** is **on**. Installing the Plugin *is* the trust act, so a second act to
  arm it is a setup step disguised as a settings screen. Where it cannot run yet — an unestablished
  **Connection**, most often — that is `MCP server readiness`, not an on / off.

**The default follows the Authority, not the kind.** A `local:repo` MCP server still starts **off**,
because ADR [0013](./0013-two-settings-families-with-different-scope-sets.md)'s "a repository may
offer but never enable" is a rule about the default. You installed the Plugin; you only cloned the
repository.

The MCP server's on / off is now the only contribution setting in the product. It is a **row state**,
not a section: an off server greys out and takes a *Disabled* pill in place, so it is switched back on
where it was left. The view groups by the Engine's conclusion — **Needs Attention** and **Ready** —
and never by the person's choice.

### The catalog fetch and the update ceremony are struck

Every Plugin and the **Plugin catalog** document ship with Cogwork. Nothing is fetched, so the
machinery built for fetching has no caller and is deleted rather than kept:

- the catalog network fetch, its cache, its stale-tolerance, and *no updates known*;
- the **computed digest** per entry and "the fetched bundle always wins on mismatch";
- the `active` / `deprecated` / `deleted` status set, and with it
  [#135](https://github.com/colonylabs/cogwork/issues/135)'s "catalog status bounds resolution";
- the staged-update ceremony — stage, accept, decline — and with it #135's "install grants nothing so
  consent belongs to update". Consenting to a bundle that arrived with an app you already chose to
  update is theatre.

This is [#203](https://github.com/colonylabs/cogwork/issues/203)'s argument, which ADR
[0016](./0016-one-management-contract-for-the-app-and-the-cli.md) already carries in writing: "a
control for declining updates to a separately-installed bundle has nothing to act on." A staged-update
ceremony is that control with more steps.

**Recorded so it is not re-derived.** The struck mechanisms were not wrong; they were architecture for
an installable world Cogwork is not in. Do not restore any of them on the argument that third-party
install may arrive one day. If it arrives, it gets a fresh decision against whatever sources exist
then.

Two of #135's four decisions are untouched by the Plugin changes, because neither depends on where
bytes come from: the **Engine ceiling** and **a bundle names an env key while the engine supplies the
value**. ADR 0025 later narrows the ceiling's worktree-confinement requirement to Read only.

### Two acts, and a rule at load

ADR 0016's six Plugin acts become **two**: `install` and `uninstall`. That is this ADR's own headline
sentence — "install and uninstall are the whole of it" — which the act list had contradicted.

An app update is the only thing that changes a Plugin's files, and it needs no act. Cogwork re-reads
disk at Run assembly, so the next Run gets what is there and a Run in flight keeps what it was given.
This ADR's existing rules survive with the trigger changed: a dropped contribution still has its
setting deleted, and `localName` is still a stable contract.

### The Plugin source field is deleted

**Plugin source** had two members: a catalog entry, or a local path. Nothing reaches the local path.
A person's own contribution files, and a bundle they downloaded and unpacked, both land in an
**Authoring tree** at its fixed location and carry a `local:` Authority — not a Plugin. Cogwork does not
install them, does not fetch them, and does not let a person name new tree locations; the only thing a
person points Cogwork at is a workspace.

One member is left — *ships with Cogwork* — so the field carries no information and leaves the
**Install record**, taking with it "a source that changes under a stable name needs an explicit act".
The record's key is unchanged: `pluginId` alone, which #205 already ruled settled.

### Uninstall leaves the Connection standing

#205 tested ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md)'s cascade
direction and confirmed it. Uninstalling a Plugin never removes its **Connection**, because that
Connection may also authenticate an Engine port with no Plugin over it — uninstalling a tools bundle
must not stop the daemon reconciling. The Plugins surface shows a notice naming the Connection as
still established, and never offers to remove it: **Connections** remains the only surface that writes
Connection state.

Full reasoning: [#205](https://github.com/colonylabs/cogwork/issues/205).
