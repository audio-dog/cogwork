# 0015 — One local Control store, with engine-owned migrations

- **Status:** accepted
- **Date:** 2026-08-25
- **Amended:** 2026-08-25 — `drizzle-kit` is adopted as a development tool, see [Amendment](#amendment-2026-08-25--drizzle-kit-is-adopted-as-a-development-tool)
- **Amended:** 2026-08-27 — pre-alpha: no migrations, see [Amendment](#amendment-2026-08-27--pre-alpha-no-migrations-no-cutover-no-backups)
- **Amended:** 2026-09-01 — migrations return as declarative convergence, see [Amendment](#amendment-2026-09-01--migrations-return-as-declarative-convergence)
- **Amended:** 2026-09-10 — run-event retention is bounded without breaking owned transcripts, see [Amendment](#amendment-2026-09-10--run-event-retention-is-bounded-without-breaking-owned-transcripts)

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

## Amendment (2026-09-01) — migrations return as declarative convergence

The previous amendment named its own reversal signal: wanting to keep a store across a schema change.
The signal arrived — more developers are joining, each with a `~/.cogwork/control.db` of their own,
and "delete the store and start again" stops being free the moment it is somebody else's store. What
follows keeps that amendment's schema-is-the-source-of-truth posture and withdraws its replacement
policy. It also overturns the mechanism that amendment predicted, and the reasoning is recorded
below.

**Boot converges the store to the schema.** The exact fingerprint comparison is withdrawn. In its
place, boot computes the difference between the schema the live store actually has and the schema
this build declares, executes the resulting statements itself inside a transaction, then computes the
difference again and requires it to be empty. That empty re-diff is the new boot verification — it
checks the same thing the fingerprint checked, one level up: not "is the DDL text identical" but "is
there anything this build would still change". An empty file is not a special case; creating the
schema is converging from nothing, so the create path and the migrate path become one path.

**The differ is drizzle-kit's, run in-process.** A survey of the alternatives found no other credible
TypeScript implementation: the standalone packages are unmaintained or coupled to the wrong driver,
the ORM synchronizers (TypeORM, Sequelize) are documented data-destroyers on SQLite, Prisma's diff
engine is CLI-only, and Atlas and sqldef are Go binaries. drizzle-kit's SQLite differ is maintained,
tested, and complete — the twelve-step table recreate, foreign keys, partial and expression indexes,
views — and the schema it diffs against is the module this store is already authored in. It is used
**statements-only**: the differ reports what it would run, the engine inspects the statements and
executes them through its own `SqlClient`, and the differ's own apply path and its non-interactive
hints are never trusted (both were verified lossy outside a TTY). Two statements-only entry points
exist — `drizzle-kit/payload/sqlite`'s `pushSchema`, which takes the schema as an in-memory module,
and the public SDK's `push` in explain mode, which carries the full typed hints protocol but loads
the schema from a file. The implementation chooses between them with drizzle's own agent skills
loaded, and records the choice; the decision here is the differ, not the entry point.

**One mechanism, exercised by developers, shipped to users.** The developer loop is: edit
`control-store-schema.ts`, restart the daemon. No command, no generated file to manage, no store to
delete. That same converge step is what a user's store meets after an automatic desktop update — so
the upgrade path users eventually depend on is the path developers run every day, not a separate
mechanism first exercised in the field.

**Why the prior rejections dissolve.** Push was rejected here twice, for three reasons, and each was
about something other than push. *The exact comparison refuses ALTER'd DDL* — true, and withdrawn
with the comparison itself; the empty re-diff accepts any store the differ has nothing left to say
about. *Push keeps no history, so the compatibility check has nothing to read* — convergence needs no
history; a store three releases behind is one diff away from current, which is the property ordered
migration chains go to great lengths to approximate. On a desktop product the chain is the burden:
every migration ever shipped must keep replaying correctly against every store shape that ever
existed, on machines nobody can see. Stateless convergence replaces that with one invariant — any
store, one diff, current schema. *The diff is computed at run time and can never be reviewed in a
pull request* — the reviewed artifact is the schema change itself, which is the source of truth the
diff is a pure function of; what runs on another machine was never going to be the SQL text in a PR,
under any mechanism, because the store it runs against is not knowable from the repository.

**Effect's `Migrator` is not adopted, reversing this ADR's own prediction.** The previous amendment
said migrations return as "`drizzle-kit generate` for the SQL and Effect's `Migrator` to apply it."
That is the ordered-chain model, and it loses to convergence on exactly the ground above. It also
reintroduces everything the schema-as-truth posture removed: generated SQL files as committed
artifacts, snapshot metadata as the generator's baseline, and a bookkeeping table rivaling the schema
module's account of the store.

**Data transforms are the named limit, and their shape is decided now, built never — until needed.**
A differ derives structural change and cannot derive semantic change: a rename looks like a drop and
an add, a backfill is not derivable from two schemas at all. When the first such change lands after a
release, it ships as an ordered, one-shot transform that runs after DDL convergence and is recorded
in a table. No transform machinery exists until that first transform does; before a release it cannot
be needed, because pre-alpha data loss is acceptable.

**Policy until the first release, and the flip after it.** Destructive statements execute without
ceremony. A rename-shaped diff — the one case the differ refuses to resolve non-interactively — moves
the store file aside as a timestamped backup and recreates from schema; the developer loses local
state, never the file. Before the first release this flips, and the flip is part of shipping:
destructive statements and rename-shaped diffs fail closed — daemon up, RPC served, store reported
unavailable, file untouched — until a transform or an explicit resolution ships. Unexpected converge
failures fail closed the same way today; that posture is unchanged.

**drizzle-kit becomes a runtime dependency of the engine, pinned exact.** This reverses "a
development tool that never runs on another machine." The statements-only surface is a few pure
functions over an in-memory schema, but it rides in a ~5MB bundle, and the rc line has already
regressed API behaviour once. The pin is exact rather than tag-following for that reason, and the
empty re-diff bounds the blast radius of a behavioural regression: a differ that starts producing
wrong statements fails the verification at boot instead of leaving a silently wrong store.

**Likely retirements, to be confirmed in implementation.** With the schema module as the runtime
source of truth, `control-store-create.gen.ts` and the `drizzle:schema` / `drizzle:check` scripts
lose their reason to exist — the create statements were only ever the schema in a second notation.
If the packaged app can feed the schema module to the differ directly, they retire.

**What stands.** One SQLite database per machine at `~/.cogwork`, private directory and file. Drizzle
as the query layer over the Effect `SqlClient`, one connection, one write lock. The run ledger's
disposability by policy, and mandatory run-event retention. Fail-closed as the posture for anything
unexpected. And the previous amendment's central claim survives its own reversal: the schema is the
source of truth, and nothing a machine holds outranks it.

**When this reverses.** A transform backlog that makes "one diff away from current" false in
practice, or a differ regression the pin and the re-diff cannot contain, is the signal to revisit —
the fallback is the ordered-chain model this amendment declined, whose ingredients (`drizzle-kit
generate`, Effect's `Migrator.fromRecord`) remain verified and available.

## Amendment (2026-09-10) — run-event retention is bounded without breaking owned transcripts

The required run-event retention existed as a 30-day event cutoff. It deleted individual events from
every Run. That was unsafe for an owned-transcript Session, whose conversation exists only in those
events, and it did not stop a recent event flood from filling the store.

**Retention runs once at boot and removes whole Runs of events.** A Run is eligible only when it is
terminal, has an end time, and belongs to an opaque-handle Session. An eligible Run is pruned when it
ended more than 30 days ago. The remaining eligible event data has a 256 MiB soft budget, measured as
the encoded `data` bytes. If it exceeds that budget, the oldest whole Runs are pruned until it fits.
Running Runs and every owned-transcript Run are exempt. Tracker state is not available at store boot
and does not create another exemption.

**Pruning removes history, not the Run.** The Run row, immutable Run Plan, and Session remain. The Run
reports zero retained events and records `eventsPrunedAtMillis`, so a history reader can distinguish
removed history from a Run that never recorded an event. No folded transcript or other second copy is
created.

**New stores use incremental auto-vacuum.** Boot enables it before creating a new Control store and
requests bounded incremental reclamation after pruning. Existing stores keep their current auto-vacuum mode:
deleted pages can be reused, but boot never runs a blocking full `VACUUM` to retrofit them.
