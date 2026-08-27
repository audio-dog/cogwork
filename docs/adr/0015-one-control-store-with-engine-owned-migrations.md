# 0015 — One local Control store, with engine-owned migrations

- **Status:** accepted
- **Date:** 2026-08-25
- **Amended:** 2026-08-25 — `drizzle-kit` is adopted as a development tool, see [Amendment](#amendment-2026-08-25--drizzle-kit-is-adopted-as-a-development-tool)
- **Amended:** 2026-08-27 — pre-alpha: no migrations, see [Amendment](#amendment-2026-08-27--pre-alpha-no-migrations-no-cutover-no-backups)

## Context

ADR 0013 enumerated the settings a person can write. ADR 0014 made the install record the authority
for *this Plugin is installed* and machine-local. Neither said where those records physically live,
how they migrate across an automatic desktop update, or what happens when a migration fails.

[#126](https://github.com/colonylabs/cogwork/issues/126) asked for that. Its research artifact
(`docs/research/desktop-settings-storage-updates.md`, from
[#129](https://github.com/colonylabs/cogwork/issues/129)) recommended Electron's `userData`
directory, Drizzle's migrator driven by generated SQL files, and a `SecretStore` port beside the
settings store. An AFK grilling session worked the ticket across seven rounds; three of those
recommendations did not survive it, and a fourth decision — the one this ADR leads with — reversed
the session itself.

## Decision

**One SQLite database on a machine: the Control store.** It holds the durable, authoritative records
— install records, settings at every Scope that is not a file, Runtime host bindings, minted Scope
identities, and store metadata — and it also holds the run history that was previously a separate
`runs.db`. One file, one migration history, one backup, one lock.

**It lives at `~/.cogwork`, not Electron's `userData`.** The daemon is hosted by the CLI as well as
by the desktop app. A headless daemon over SSH has no `userData` directory, and the Runtime host is
the same host either way.

**The engine owns the migration loop. Drizzle stays the query layer and its `migrate()` is never
called.** Boot acquires the lock with `BEGIN IMMEDIATE`, checks compatibility, copies the database
through `VACUUM INTO` when and only when a migration is pending, migrates, validates, and only then
starts dispatch.

**A migration is a TypeScript module** exporting an integer id and its statements — not an unpacked
`.sql` tree, and `drizzle-kit` is not adopted as a generator. *(Amended — `drizzle-kit` is adopted,
as a development tool that never runs on a user's machine; the module stays the shipped artifact.)*

**Failure is closed.** On any failure in that sequence the daemon starts, serves RPC, reports the
store unavailable through `DaemonHealth`, and dispatches nothing. The failed database is preserved as
evidence and never auto-deleted; restoring is a person's act.

**Disposability is a policy in the adapter, not a property of a file.** Run-event writes keep
swallow-and-continue; every write to an authoritative record raises and carries an expected revision
for stale-write detection.

**Retention on run events is mandatory, not optional.** The pre-migration copy is on the boot path,
so unbounded run history becomes a startup cost.

**No `SecretStore` and no Connection record.** The Credential store already names the first and
already carries the seam the research proposed. *Connection* is marked *provisional, do not design
against*; [#172](https://github.com/colonylabs/cogwork/issues/172) owns it.

## Considered Options

**Two databases — a settings store beside `runs.db`.** This is what the grilling session concluded,
and it was overruled. Its argument was failure isolation: the Control store must fail closed, the run
ledger must never stop the daemon, and one migration history gives a disposable store a veto over the
product. That argument is real but it is answerable in code — the write policy moves to the adapter,
and every migration failing closed is defensible for run history too, because a failed migration
means a shipped bug.

What is not answerable in code is the precedent. Codex runs **four** SQLite databases in `~/.codex`
(`goals_1`, `logs_2`, `memories_1`, `queue_1`), each with its own migration history and a generation
number in its filename. Once two databases are normal the fourth is free, and the split cannot be
un-split later: a second store means a second remote seam when hosting arrives, and any question
spanning both — *which Runs used this Plugin version* — becomes app-level correlation forever rather
than a join. A structural cost that compounds outweighs a failure policy that can be enforced at the
port.

The cost accepted: "delete `runs.db`" retires as recovery advice, replaced by a command that drops
and recreates the run tables only.

**Drizzle's migrator.** Rejected on the installed code, not on taste. In `drizzle-orm@1.0.0-rc.2`,
`SQLiteSyncDialect.migrate` reads the applied history with a plain `SELECT` *outside* the transaction
and then opens a deferred `` sql`BEGIN` ``, so two racing daemon starts can both migrate.
`getMigrationsToRun` matches on **name only** while writing a `hash` column that is never compared.
`readMigrationFiles` does a runtime `readdirSync`, which does not survive packaging. Every check the
research asks for has to be written anyway; owning the loop is cheaper than owning the loop *and*
working around a migrator.

**Effect's `unstable/sql/Migrator`.** Not adopted. It ships in `effect@4.0.0-rc.110` and does model
the desired behaviour, but the `unstable/sql` namespace has no SQLite client, so it is not a drop-in
and would be a second migrator besides.

**Electron `userData`.** Rejected — see above. The research's recommendation assumed the desktop app
is the only host.

## Consequences

- The **Run ledger** is no longer a file. It is a region of the Control store that keeps its
  disposable semantics by policy. Its glossary entry changes accordingly.
- `~/.cogwork/runs.db` becomes the wrong filename, and renaming it is itself a migration step.
- Because the Control store now spans both families, a foreign key between a run row and a settings
  row becomes possible. Nothing needs one today —
  [#130](https://github.com/colonylabs/cogwork/issues/130) embeds provenance in the Run Plan rather
  than referencing it — and wanting one is the signal to revisit this ADR.
- One store-wide revision was considered and cut: its only consumer went to
  [#133](https://github.com/colonylabs/cogwork/issues/133), and a counter every write must touch is a
  contention point invented for a consumer that does not exist. Stale-write detection stays per-row.

## Amendment (2026-08-25) — `drizzle-kit` is adopted as a development tool

This ADR declared that a migration is a TypeScript module and that `drizzle-kit` is not adopted as a
generator. The first half stands. The second is reversed.

**The rejection conflated two tools.** `drizzle-orm`'s runtime `migrate()` is rejected on the code
evidence above, and that rejection is unchanged — it is never called. `drizzle-kit` is a
development-time CLI that never runs on a user's machine, and none of that evidence touches it.

**`drizzle-kit push` against the developer's own database.** Drizzle documents push as "rapid
prototyping in local development" and explicitly not for production deployments, which is the same
split this ADR draws: a development database is disposable, so push is correct against it. It is
wrong on a user's laptop for reasons that are not about Drizzle at all — there is no CLI and no
person there, the diff would be computed at run time and so could never be reviewed in a pull
request, and the Control store is the authority for *this Plugin is installed* rather than something
a person can delete and recreate. Push also keeps no history, so there would be nothing for the
compatibility check to read, and an automatic desktop update is exactly the case that check exists
for.

**`drizzle-kit generate` produces the SQL that ships.** Once push has settled a schema, generate
emits the statements. Hand-writing them afterwards is transcription of a change the tool already
made, with a chance to get it wrong — and SQLite's table-rebuild recipe for a type or constraint
change is precisely where hand-written SQL corrupts a store that is not disposable. Push's
documented blind spot is a second reason generate owns the shipped artifact: push does not detect
changes to `.where()`, `.on()`, `.using()`, or `.op()` on an existing index.

**What is committed, and what ships.** drizzle-kit's migration folder — its `.sql` output and the
snapshot metadata it needs to compute the next diff — is committed, because without that metadata
the next `generate` has no baseline. The TypeScript module is generated from that SQL and committed
beside it. **Only the module ships.** `drizzle-kit`, the `.sql` tree, and the metadata stay in the
repository and never reach a user's machine.

The module is generated rather than inlined by a build step because there is no build:
`packages/engine` exports `./src/index.ts` with no `build` script, and `apps/cli` starts through
`tsx`. A check that regenerates the module and fails on any difference closes the hand-edit hole
that two committed representations would otherwise leave open.

Nothing about the boot loop changes. The engine still owns it, still reads an array of statements,
still never calls Drizzle's `migrate()`, and still does no filesystem read at run time.

Full reasoning: [#126](https://github.com/colonylabs/cogwork/issues/126). Research:
`docs/research/desktop-settings-storage-updates.md` on `research/desktop-settings-storage`.

## Amendment (2026-08-25) — the daemon's runtime limits are a record kind

This ADR listed the record kinds the Control store holds. It did not include the daemon's own
scheduler limits, because at the time nobody had asked where they live. ADR
[0016](./0016-one-management-contract-for-the-app-and-the-cli.md) asked, and the answer widens the
list rather than changing anything already decided.

**Global concurrency, per-workspace concurrency, and the daily budget are durable rows.** They are
machine-local state cogwork writes and is authoritative for, which is this ADR's own membership test
for the store. Today they have three rival authorities — a CLI flag at boot, `SetSchedulerConfig`
writing an in-memory `Ref` that dies with the process, and `WorkspaceConfig.concurrency` — and the
desktop's Settings → Engine rows silently revert on every restart.

They are **not** on the Scope axis. A Scope answers *which of several rival values wins*, and one
machine holds one value; the per-workspace form is a different key, not a competing Scope. ADR 0013
is unchanged.

**The `Ref` becomes a cache with one writer.** It is seeded from the store on the boot path and moved
only by the *set a limit* act. The write order is forced and getting it backwards fails silently:
write the row and raise on failure, then update the `Ref`, then publish. Moving the `Ref` first
leaves a running daemon obeying a number that vanishes on restart — the same class of wrongness as
the defect this fixes. Because re-seeding is part of the boot path, a snapshot restore reaches it for
free.

Scheduling running / paused is **not** one of these. It is a live control that resets to paused at
every launch by design, so that spawning a daemon never silently spends budget.

The four process arguments — socket, config home, ledger path, credentials path — stay flags. A
daemon cannot read the location of its own store out of that store.

## Amendment (2026-08-25) — the Control store gains a Connection record

This ADR decided "no `SecretStore` and no Connection record", noting that *Connection* was marked
*provisional, do not design against* and that [#172](https://github.com/colonylabs/cogwork/issues/172)
owned it.

That ticket defines the term, and the record is now needed. **The Control store holds a Connection
record — id, system, account, status — and the Credential store keeps holding the secret.** No
`SecretStore` is added, so half of this ADR's decision stands as written.

Two reasons. A workspace references a Connection **by id**, so that id must exist outside a secret
store whose backing layer becomes an OS keychain that can neither list records nor carry a status. And
this ADR makes the Control store the authority the Engine resolves a Run Plan from, while a Run Plan
requires Connections — so their existence and readiness must be resolvable from it. The closed field
list widens by one table. See ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md).

## Amendment (2026-08-27) — pre-alpha: no migrations, no cutover, no backups

This ADR was written as though cogwork had users. It does not. There is one person on one machine,
that machine's store holds nothing anyone would miss, and there has never been a released version to
move anyone from. Read under that fact, most of what this ADR decided is machinery defending a
population of zero, and the decisions below are withdrawn.

**There is no migration loop, and no migration history.** "The engine owns the migration loop" is
withdrawn, along with the choice of what drives it — a migration is no longer a TypeScript module of
statements, `drizzle-kit generate` no longer runs, and Effect's `Migrator` is not adopted after all.
A store is *created* from the schema and *replaced* when the schema moves. Boot opens the store,
creates the schema if the file is empty, and otherwise compares the schema it found against the one
this build would create; a mismatch reports unavailable and names the file to delete. The comparison
is exact because both sides run the same statements.

This is what this ADR's previous amendment already argued, one inference short. It said `push` is
correct against a development database and wrong "on a user's laptop… there is no CLI and no person
there". There is a person there. `drizzle-kit export` produces the create statements that ship.

`push` is *not* adopted, for a reason that is about this ADR's own schema check rather than about
push: it reaches a schema by `ALTER TABLE`, so the DDL text and column order it leaves differ from
what the create statements produce, and an exact comparison refuses the result. Keeping a local
store across a schema change and checking the schema exactly cannot both be had; the check is worth
more here, because the store is disposable and the wrong-schema diagnosis is not.

**Withdrawn with it:** the pre-migration copy through `VACUUM INTO` — it preserved a user's data
against a failed migration, and there are no migrations and no users, while every copy it took stayed
on disk forever with no command to restore one. The compatibility check on applied migration ids, and
its mirror for shipped ids a store's history would skip. The `authoritative_records` table,
`writeAuthoritative`, and the expected-revision write: no caller, and *authoritative record* is a noun
no `CONTEXT.md` glossary carries. The revision-and-stale-write pattern lands with
[#219](https://github.com/colonylabs/cogwork/issues/219)'s typed table, which wants three named
columns rather than an opaque blob.

**And no legacy cutover.** This ADR's Consequences said `~/.cogwork/runs.db` becomes the wrong
filename and that renaming it is itself a migration step. Withdrawn: the store does not adopt,
rename, import, or read it. Two attempts preceded this and both cost more than the history was worth.
Renaming forced `IF NOT EXISTS` into generated SQL and a schema check taught to forgive whatever
shape an old store had. Copying the rows instead made boot `ATTACH` a file the daemon does not own —
a `runs.db` whose `runs` was a view over a recursive CTE passed the table check and had its rows
inserted while boot reported healthy, which was demonstrated rather than argued.

**What stands.** One SQLite database per machine, at `~/.cogwork`, holding the durable records and the
run history that was `runs.db` — one file, one lock, one backup story when there is one to have. The
directory is private and so is the file. `drizzle-kit` stays adopted as a development tool that never
runs on another machine, now for `export` and `push` rather than `generate`, and its agent skills are
adopted through the workspace's `@tanstack/intent` protocol. Drizzle stays the query layer, over its
Effect driver on the store's own `SqlClient`, so the boot path and the run ledger share one connection
and one write lock. Disposability stays a policy in the adapter: run-event writes swallow and
continue, and retention stays mandatory — not to bound a copy that no longer exists, but because an
unattended run ledger reached 149 MB on the author's own machine. Failure stays closed: the daemon
starts, serves RPC, reports the store unavailable, dispatches nothing, and leaves the file untouched
as evidence.

**When this reverses.** The first time a second machine has a store worth keeping, migrations come
back — `drizzle-kit generate` for the SQL and Effect's `Migrator` to apply it, which was verified to
work and rejected here only for want of a reason. Wanting to keep a store across a schema change is
the signal to revisit this amendment.

**Pins.** `drizzle-kit` follows the `rc` tag. `drizzle-orm` is pinned to `1.0.0-rc.5-169397b` rather
than the `rc` tag, because `rc.4` calls `Schema.TaggedErrorClass` from its Effect driver — a name that
exists only on Effect's beta line — so `drizzle-orm/effect-sqlite-node` cannot be imported on the rc
line at all. Move to the release carrying that fix. `effect` moved to `4.0.0-rc.112` with it.
