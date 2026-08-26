# 0016 — One management contract for the app and the CLI

- **Status:** accepted
- **Date:** 2026-08-25

## Context

ADR [0015](./0015-one-control-store-with-engine-owned-migrations.md) put every durable thing Cogwork has been told on this machine in one Control store the engine owns, and deliberately stopped short of the verbs: install, uninstall and update are the port's transaction boundaries, and *everything else a person can do is one row* whose verbs "live in the service above". This is that service.

Three other decisions handed work here by name. [#130](https://github.com/colonylabs/cogwork/issues/130) left the queued-Run question open — "whether one is introduced, and what an edit does to the surfaces, is #133's". [#135](https://github.com/colonylabs/cogwork/issues/135) left "how an update path expresses an attributable accept". ADR 0015 left snapshot restore as "a command a person invokes, which puts its surface with #133".

Meanwhile the shipped surface has no contract at all. Three authorities claim the daemon's scheduler numbers — a CLI flag at boot, `SetSchedulerConfig` writing a `Ref` that dies with the process, and `WorkspaceConfig.concurrency` — and the desktop's Settings → Engine rows silently revert on every restart. Nothing said which commands exist, what a client learns without asking, or what an edit does to work already moving.

## Decision

### Thirteen acts, five subjects, and the list is closed

| Subject | Acts |
|---|---|
| A Plugin, keyed by `pluginId` | install · stage an update · accept a staged update · decline a staged update · uninstall · refresh the Plugin catalog |
| `(contribution identity, Scope)` | set or clear a contribution's on / off |
| `(Operation setting, level, Scope)` | set or clear an Operation setting |
| A workspace | register · deregister · re-bind the checkout path |
| The daemon's runtime limits | set a limit |
| The Control store | restore the pre-migration copy |

Staging and accepting are two commands rather than one flag: a resolved identity comes into existence only at staging, so an accept that names it is necessarily the second round trip. That pair is what makes an accept attributable without an interactive prompt, and one pair serves both clients.

Three things are deliberately absent. **`pin`** has a verb and a field and no semantics — [#203](https://github.com/colonylabs/cogwork/issues/203) owns it, and giving it a command here would design a surface for a concept nobody has defined. *(Amended 2026-08-26 — #203 is closed unresolved: `pin` was ruled out of scope and the verb and the field are deleted, so this absence is now permanent rather than pending. No coding harness exposes version pinning to a person, and Plugin install sits outside the current requirements while every Plugin is a first-party pack shipping with Cogwork.)* **Connection** is marked provisional in the glossary with an *Avoid* line naming scoping, binding, granting and resolving; this contract specifies no Connection act. **Minting a Scope identity** is not an act: `PrincipalId` is a constant, `HostId` is minted at the store's first open, `WorkspaceId` is minted by register, and the overlay key is a pair of two identities that already exist. Four candidate commands, zero survivors.

`CancelRun`, `Reclassify` and `SetScheduling` are neighbours in the same RPC group, not members of this contract. All three change what the daemon is *doing now* rather than what it is *configured to be*, and none survives a restart by design. `DaemonCommands` is a CQS split — a guard boundary for authorization — not a subject boundary.

### The settings picture is one whole value, carried on two members

Everything the Control store owns rides one new `DaemonEvent` member, published whole: the install records, their loaded contributions and load failures, and every settings row at both Principal-owned Scopes. The committed Workspace input's decoded offers and its diagnostics ride `WorkspaceState.Registered`, because they are the repository's and are recomputed on the reconcile tick.

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
- The surface that owns workspace registration, the daemon limits and restore has **no name**. It is neither Plugins nor Customize, and `Settings` sits on Customize's *Avoid* line. Naming it is a domain-modeling act and is not performed here.
