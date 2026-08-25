# 0014 — Plugin install is machine-local, and the only Plugin-level state

- **Status:** accepted
- **Date:** 2026-08-25

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
- **Setup is establishing the Plugin's required Connections, and nothing else.** After install every
  contribution is off; absence is not a third value. A Plugin's incomplete setup never gates its
  inert contributions — a Plugin only offers, and one whose missing token disabled its own Skills
  would be marking itself required for Operations it does not own. What narrows is the Operation
  Definition's declared needs, at Run Plan resolution.
- **Uninstall deletes every setting at every Scope the uninstaller owns** — Settings profile and
  Private workspace overlay. Committed Workspace input values survive as *dangling*, because that
  file belongs to the repository and possibly to a colleague.
- **An update that drops a contribution deletes its setting too.** A retained row buys a remembered
  choice for the fraction of users who ever roll back and costs a dead row per affected user forever.
- **`localName` is a stable contract.** Identity is immutable, so a renamed contribution is a drop
  plus an add: the old identity goes *dangling*, the new arrives with no setting.
- **The update trigger is an explicit user action**, never the app update — those are separate
  versioning problems. A catalog fetch is detection only and stale-tolerant; a failed fetch reports
  *no updates known*, never an error.
- **The Plugin catalog publishes a computed digest per entry**, plus a status of `active`,
  `deprecated`, or `deleted` with an optional message. One fetch yields every digest. The fetched
  bundle always wins on mismatch, with a diagnostic naming the entry.
- **Partial install is per-contribution.** An unparseable manifest installs nothing, because the
  manifest carries the identity. A malformed pointed-at file yields no contribution, so it is simply
  not a member of the `union-values`, and any setting written for it is *dangling*.
- **Plugins owns membership; Customize owns contribution settings.** Customize may show a Plugin's
  rows, including one that failed to load, and may never write membership or credential state.
- **A bundle names a secret; the engine holds it.** A Plugin declares which credential it needs and
  never carries one. This keeps a bundle publishable and is the only arrangement in which an update
  that widens access can be compared and consented to before it runs.

Offline, therefore: a first install from the catalog needs the network for the bytes, and nothing
else does. Resolution never fetches.

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

## Amendment (2026-08-25) — the Connections surface exists, and a paired install turns its contributions on

This ADR deliberately excluded Connection behaviour and struck four answers it had produced anyway.
[#172](https://github.com/colonylabs/cogwork/issues/172) has now landed, and it changes three things
here. See ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md).

**The third surface is adopted.** This ADR rejected "a third surface for Connections" *while the
Connection set is closed and first-party*. That condition is the reason **for** the surface, not
against it: an Engine port's Connection — GitHub's, Linear's — has no Plugin over it, so Plugin setup
can never be its home. This ADR could not weigh that, having excluded Connection behaviour.

**A paired install turns its contributions on.** "After install every contribution is off" survives
everywhere except one narrow case: establishing a Connection installs the one first-party Plugin that
requires it and turns on **every** one of that Plugin's contributions. A person who connects Linear
and must then find and flip an MCP server has been handed a setup step disguised as a settings screen.
A Plugin with no Connection still installs with everything off.

**The `Readiness` generalization is refused, not deferred.** This ADR expected Connection readiness to
be a second instance of a general `Readiness`. It is not a peer: *MCP server readiness* already
includes "authenticated", so Connection readiness is an **input** to it for a Plugin's MCP server, and
stands alone for an Engine port. `Connection readiness` is its own term and no umbrella is minted.

Unchanged and reused: install stays machine-local; provision stays atomic, which is why an abandoned
browser login leaves the install standing rather than rolling it back; *dangling* is the shape a
workspace binding takes when its Connection is removed.
