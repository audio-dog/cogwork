# 0016 — One management contract for the app and the CLI

- **Status:** accepted
- **Date:** 2026-08-25

## Context

ADR [0015](./0015-one-control-store-with-engine-owned-migrations.md) put every durable thing Cogwork has been told on this machine in one Control store the engine owns, and deliberately stopped short of the verbs: install, uninstall and update are the port's transaction boundaries, and *everything else a person can do is one row* whose verbs "live in the service above". This is that service.

Three other decisions handed work here by name. [#130](https://github.com/colonylabs/cogwork/issues/130) left the queued-Run question open — "whether one is introduced, and what an edit does to the surfaces, is #133's". [#135](https://github.com/colonylabs/cogwork/issues/135) left "how an update path expresses an attributable accept". ADR 0015 left snapshot restore as "a command a person invokes, which puts its surface with #133".

Meanwhile the shipped surface has no contract at all. Three authorities claim the daemon's scheduler numbers — a CLI flag at boot, `SetSchedulerConfig` writing a `Ref` that dies with the process, and `WorkspaceConfig.concurrency` — and the desktop's Settings → Engine rows silently revert on every restart. Nothing said which commands exist, what a client learns without asking, or what an edit does to work already moving.

## Decision

### Nine acts, five subjects, and the list is closed

| Subject | Acts |
|---|---|
| A Plugin, keyed by `pluginId` | install · uninstall |
| `(contribution identity, Scope)` | set or clear a contribution's on / off |
| `(Operation setting, level, Scope)` | set or clear an Operation setting |
| A workspace | register · deregister · re-bind the checkout path |
| The daemon's runtime limits | set a limit |
| The Control store | restore the pre-migration copy |

Three things are deliberately absent. **`pin`** has a verb and a field and no semantics — [#203](https://github.com/colonylabs/cogwork/issues/203) owns it, and giving it a command here would design a surface for a concept nobody has defined. **Connection** is marked provisional in the glossary with an *Avoid* line naming scoping, binding, granting and resolving; this contract specifies no Connection act. **Minting a Scope identity** is not an act: `PrincipalId` is a constant, `HostId` is minted at the store's first open, `WorkspaceId` is minted by register, and the overlay key is a pair of two identities that already exist. Four candidate commands, zero survivors.

`CancelRun`, `Reclassify` and `SetScheduling` are neighbours in the same RPC group, not members of this contract. All three change what the daemon is *doing now* rather than what it is *configured to be*, and none survives a restart by design. `DaemonCommands` is a CQS split — a guard boundary for authorization — not a subject boundary.

### The settings picture is one whole value, carried on two members

Everything the Control store owns rides one new `DaemonEvent` member — `ControlStoreChanged`, named by the domain-modeling act of 2026-08-26 (the family is `<Noun>Changed` carrying the new whole value, and the glossary noun for what it carries is **Control store**; `SettingsChanged` and `ConfigChanged` are both refuted by that entry's own *Avoid* line) — published whole: the install records, their loaded contributions and load failures, and every settings row at both Principal-owned Scopes. The committed Workspace input's decoded offers and its diagnostics ride `WorkspaceState.Registered`, because they are the repository's and are recomputed on the reconcile tick.

The carrier split follows the authority split. ADR 0015 inherited the storage research's rule that a committed file is canonical and SQLite "may cache an index or never a competing value"; putting the file's values on the store's member would manufacture exactly the competing copy that rule forbids.

*Rejected:* engine-computed effective values per workspace, and a per-workspace query opened per surface. Both make the daemon own a display concern, and the second multiplies subscriptions the self-seeding stream already covers.

### Rows, not effective values

The picture carries raw settings rows. The resolver that renders the current ladder is authored once in the shared kernel beside the board fold, and each client runs it locally — the same shape the board already has.

The cost is named rather than hidden: there are now two resolvers, the engine's (which builds a Run Plan and embeds its trace) and the kernel's (which renders the current ladder), and they must agree on ADR [0013](./0013-two-settings-families-with-different-scope-sets.md)'s scope-set rule. They are tested against the same table.

### A write refuses what is enumerable in memory and accepts what depends on disk

One axis decides every validation question. A command **refuses** when the fault is checkable against engine-authored data the daemon already holds — an unknown Operation setting, a level that does not exist, a contribution kind that cannot be enabled at the named Scope. A command **accepts** when the answer depends on machine state read from disk, and reports the result as a diagnostic on the picture instead.

The Scope case never reaches validation: ADR 0013's empty cells are made unrepresentable in the payload schema, so a Hook cannot be enabled at the Workspace input because there is no way to say it.

*Rejected:* refuse everything, which makes the daemon stat the filesystem inside a write transaction; and accept everything, which turns a typo into a diagnostic the person has to go and find.

### Deregister cascades all three, and re-bind never touches identity

Deregister deletes the workspace record, its Runtime host binding, and every Private workspace overlay row keyed by its `WorkspaceId`, in one transaction. This answers the `NO ACTION` foreign key ADR 0015 left as a forcing function. It does **not** delete Run history: those rows are the disposable ledger region, they carry no foreign key to a settings row, and losing a workspace should not erase what it did.

Re-bind writes the checkout-path record alone. Identity survives a move, which is why ADR 0013 keeps folder path and git remote as re-binding hints rather than as identity.

*Rejected:* a soft-delete tombstone (nothing reads it — an install is machine-local and a re-register is cheap), and deregister-as-two-acts (leaves a workspace no Run can use between them).

### There is no queued Run

Nothing is admitted or resolved and left waiting. "Queued" stays the Feed's word for an `Eligible` item the scheduler has not picked. A settings edit therefore needs no invalidation, because nothing was resolved to invalidate: the next tick simply resolves differently.

This is a decision that *prevents* machinery. A durable queue is the substrate of steer/queue, which `docs/agents/product.md` places after mission control and the owned runtime.

*Rejected:* a queued Run an edit invalidates (needs a rule for what the person sees when their own edit un-queues work), and a queued Run frozen at admission (extends #130's immutability a step earlier for a state nobody asked for).

### The daemon's runtime limits are not on the Scope axis

A Scope exists to answer *which of several rival values wins*. A daily budget has one value on one machine and no rival, so putting it at a Scope enrols it in a resolution with one candidate — a ladder, a resolver arm and a surface section serving a set of one. The per-workspace form is a different **key**, not a competing Scope.

So: **no ADR 0013 amendment.** These are one durable row per limit, one authority, and ADR 0015 gains the record kind — see its amendment.

## Consequences

- The `DaemonCommands` group grows from four RPCs to seventeen. Its CQS split, and ADR [0005](./0005-trust-boundary-is-authentication-not-payload-redaction.md)'s amendment scoping future guarding to commands-versus-queries, absorb that without change.
- Every act has a CLI form. Choosing a database over a file is what creates that obligation: Codex ships no `config` subcommand because a person edits `~/.codex/config.toml` by hand, and nobody hand-edits a SQLite store. The CLI groups by subject, not by client surface.
- **Plugins** and **Customize** own their write split as a *client-surface* rule. The daemon sees one `Principal` and cannot tell which panel called; what enforces the split is that membership and settings are different commands, so a surface calling only settings commands has no branch that could change membership.
- Last write wins between the app and the CLI, deliberately. Every command returns the new picture and publishes the same value, so a stale panel is corrected within one event. The stated harm in the storage research was *silently* overwriting a newer value; the publication removes the silence, and there is no colleague to surprise — cogwork runs single-user and local.
- `SchedulerStats.perWorkspace` must carry each workspace's **effective** limit beside its in-flight count. Until [#127](https://github.com/colonylabs/cogwork/issues/127) retires `WorkspaceConfig.concurrency`, the file wins, and the row's honesty depends on that read model rather than on the cutover.
- The surface that owns workspace registration, the daemon limits and restore is named **Workspaces** (domain-modeling act, 2026-08-26; this line originally recorded only the boundary — neither Plugins nor Customize, and `Settings` sits on Customize's *Avoid* line). Named for its dominant subject; the limits and restore belong beside registration because none of the five acts touches a Scope-held setting. **Engine** was the runner-up — the desktop's placeholder label for the limits section — rejected because it names the machinery being managed, not a pane, and collides with the engine context and the desktop's *Engine supervisor* / *Engine toggle*.

## Amendment (2026-08-25) — Connection acts exist, so the count is three survivors, not zero

This ADR listed four candidate commands and kept none, and its reason for dropping **Connection** was
that the term was provisional with an *Avoid* line naming scoping, binding, granting and resolving.

ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md) settles the term the same
day. A Connection is now engine-owned, keyed by system and account, with a record in the Control store
and real acts on a **Connections** surface: **establish**, **re-connect**, and **remove**. So this
contract owes three commands it deliberately did not specify, and the "four candidates, zero
survivors" tally reads only against the state of the glossary at the time.

Nothing else here changes. Minting a Scope identity is still not an act, and the CLI-and-app
parity rule this ADR fixes applies to the three Connection commands unchanged —
including that **remove** carries the *dangling* warning naming the affected workspaces, because a
warning a person cannot see is not parity.

## Amendment (2026-08-26) — `pin`'s absence is permanent, not pending

The Decision recorded `pin` as deliberately absent because it "has a verb and a field and no
semantics" and [#203](https://github.com/colonylabs/cogwork/issues/203) owned defining it. #203 is
closed **unresolved**: the question was ruled out of scope rather than answered, and the verb on
**Plugins** and the `pinned` field on the **Install record** are deleted from the glossary.

Two reasons, neither of which this contract could have supplied. No coding harness exposes version
pinning to a person — Claude Code's `version` gates the author and its source `sha` is an install
address, Cursor consumes `version` nowhere, Codex uses it as a path segment. And Plugin install sits
outside the current requirements while every Plugin is a first-party pack that ships with Cogwork, so
a control for declining updates to a separately-installed bundle has nothing to act on.

The act list is unchanged — the absence was already correct, and it stops being provisional. The
"four candidates, zero survivors" tally is unaffected: `pin` was never a survivor.


## Amendment (2026-08-26) — the four update acts are struck, leaving install and uninstall

[#205](https://github.com/colonylabs/cogwork/issues/205) struck the Plugin catalog fetch and the
staged-update ceremony. See ADR
[0014](./0014-plugin-install-is-machine-local-and-the-only-plugin-level-state.md)'s 2026-08-26
amendment.

Every Plugin and the catalog document ship with Cogwork, so nothing is fetched and an app update is
the only thing that changes a Plugin's files. Four of this contract's six Plugin acts had nothing to
act on and are deleted: **stage an update**, **accept a staged update**, **decline a staged update**,
and **refresh the Plugin catalog**. The subject keeps **install** and **uninstall**, which is ADR
0014's own "install and uninstall are the whole of it" — a sentence this act list had contradicted
since the day it was written.

The count in the Decision heading falls from thirteen to nine, and to twelve with the three Connection
acts the 2026-08-25 amendment above owes. The `pin` amendment is unaffected: it was never a survivor,
and its argument — "a control for declining updates to a separately-installed bundle has nothing to
act on" — is the argument that removes these four.

This ADR's **last write wins** rule now holds without qualification. The one case that needed more —
an accept naming the resolved identity a stage had just created — no longer exists, so the **Install
record**'s `revision` field goes with it: it was there for stale-write detection across that two-command
round trip, and `install` and `uninstall` are each one command.
[#135](https://github.com/colonylabs/cogwork/issues/135)'s handoff to this ADR — "how an update path
expresses an attributable accept" — is answered by there being no update path. An app update needs no
attribution, because updating the app is the act.

An app update lands at **load**: Cogwork re-reads disk at Run assembly, so the next Run gets what is
there and a Run in flight keeps what it was given. That is a rule, not a command, and the act list
stays closed.

## Amendment (2026-09-04) — a workspace record can be updated without deregistration

[#457](https://github.com/colonylabs/cogwork/issues/457) adds **update** to the workspace acts. The
closed list now reads **register · update · deregister · re-bind the checkout path**.

`WorkspaceState.Registered` carries the complete stored registration record. This keeps the
Control-store-owned columns on the existing self-seeding workspace stream without adding a query or
projecting effective settings. The record contains Connection references, never credentials.

Update replaces every mutable non-path column in one transaction. `WorkspaceId` is the command key
and cannot change. Checkout path remains exclusive to re-bind. Private workspace overlay rows are
outside the transaction and remain unchanged. The next reconciliation and Run read the updated
registry value. The app and CLI use the same schema-decoded command, and last write still wins.

## Amendment (2026-09-04) — Harness enablement is a management act

A Harness has one machine-local **enable** or **disable** act keyed by its registered name. Absence
means enabled. The act changes admission only: a disabled Harness is not offered for a new Operation
selection and new or resumed Runs are refused before claim. Existing selections remain stored, no
fallback Harness is selected, and a Run already accepted continues. Readiness, Sessions,
credentials, and Connections are unchanged.

The daemon returns and publishes the whole Control store picture, then refreshes Workspace
availability. The CLI and desktop Providers surface expose the same act. An unknown Harness is
refused because the registered names are enumerable in memory.
