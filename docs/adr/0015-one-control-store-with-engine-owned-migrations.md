# 0015 — One local Control store, with engine-owned migrations

- **Status:** accepted
- **Date:** 2026-08-25
- **Amended:** 2026-08-25 — `drizzle-kit` is adopted as a development tool, see [Amendment](#amendment-2026-08-25--drizzle-kit-is-adopted-as-a-development-tool)

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
