# 0015 — One local Control store, with engine-owned migrations

- **Status:** accepted
- **Date:** 2026-08-25
- **Amended:** 2026-08-25 — `drizzle-kit` is adopted as a development tool, see [Amendment](#amendment-2026-08-25--drizzle-kit-is-adopted-as-a-development-tool)
- **Amended:** 2026-08-27 — Effect's `Migrator` owns the loop, see [Amendment](#amendment-2026-08-27--effects-migrator-owns-the-loop-and-a-legacy-ledger-is-imported)

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

## Amendment (2026-08-27) — Effect's `Migrator` owns the loop, and a legacy ledger is imported

This ADR decided that the engine owns the migration loop and that Effect's `unstable/sql/Migrator`
is "not adopted". The first half stands in intent — the loop is still the engine's, and Drizzle's
runtime `migrate()` is still never called. The second half is withdrawn, and two mechanisms change.

**Effect's `Migrator` is adopted.** The rejection rested on one sentence: "the `unstable/sql`
namespace has no SQLite client, so it is not a drop-in". `@effect/sql-sqlite-node` now exists at the
version this workspace pins, is backed by `node:sqlite`, needs no native dependency, defaults to WAL
and a busy timeout, and issues `BEGIN IMMEDIATE` for every transaction. The sentence is no longer
true, and with it goes the reason.

What `Migrator` does correctly is what the hand-written loop had to assert for itself. It reads the
applied history **inside** `sql.withTransaction`, so under `BEGIN IMMEDIATE`. It inserts the pending
rows before running them and reads a unique-constraint conflict as *migrations already running*,
which is a second guard against a concurrent daemon. And `Migrator.fromRecord` takes migrations as
code, so there is no directory read at run time and nothing to survive packaging.

**Drizzle's runtime `migrate()` stays rejected, re-verified on `1.0.0-rc.4`.** The original evidence
was read from `rc.2`, so it was read again. All three defects are unchanged. `migrateSync` reads
`SELECT … FROM __drizzle_migrations` outside the transaction and then opens a deferred `` sql`BEGIN` ``
(`sqlite-core/async/session.js`), so two racing daemon starts can both migrate.
`getMigrationsToRun` matches on **name only** while writing a `hash` column that is never compared
(`migrator.utils.js`). `readMigrationFiles` does a runtime `readdirSync` (`migrator.js`). The
rejection is about `drizzle-orm`'s migrator, never about `drizzle-kit`.

**What the engine still owns**, because `Migrator` does not: the pre-migration copy through
`VACUUM INTO`, taken only when a migration is pending and the store already holds something; run-event
retention, run before the copy so the copy is bounded; the schema fingerprint; the check that no
applied migration is one this build does not ship; and the fail-closed status. Which migrations a
store boots with is a parameter of the boot layer, defaulting to the shipped set — the incremental
path is otherwise untestable while only one migration exists.

**The migration `hash` is gone.** `Migrator`'s table carries an id, a name, and a timestamp. Two
checks replace the hash and are stronger than it was: any applied id this build does not ship fails
closed, and the schema fingerprint is compared exactly. The hash was also a footgun — it covered the
raw bytes of the `.sql` file, so reformatting a committed migration would have marked every store on
every machine incompatible and stopped dispatch.

**A legacy `runs.db` is imported, not renamed.** Its tables were created by a bootstrap that predates
`drizzle-kit`, and two of its columns arrived by `ALTER TABLE`, so its DDL text can never match what
a migration produces. Adopting the file forced two things this ADR did not want: `IF NOT EXISTS`
hand-edited into generated SQL so the first migration could run over existing tables, and a schema
check taught to forgive whatever shape an old store happened to have. Copying the rows into a freshly
migrated store leaves the generated SQL untouched and lets the check stay an exact comparison, which
is the right strictness for a store that fails closed. The retired value `blocked` is translated to
`exhausted` on the way in. The old file is kept as `runs.db.imported-<millis>`; nothing is deleted.

**The hand-edit hole this ADR claimed to close was open.** A check that regenerates the module and
fails on a difference does not close it, because the module is generated *from* the SQL — an edit to
the SQL flows through and the check passes. `drizzle-kit check` does not catch it either; it compares
snapshots, not SQL against the schema. Both were confirmed by editing a generated migration and
running each. What closes it now is that there is no longer a reason to edit generated SQL: the
legacy path does not need `IF NOT EXISTS`, hand-written SQL has a sanctioned home in
`drizzle-kit generate --custom`, and the shipped module is produced by `drizzle-orm`'s own
`readMigrationFiles` rather than a local parser. The local parser was the concrete cost of not doing
this: it split on `;` instead of `--> statement-breakpoint`, which would have shredded the first
migration to contain a semicolon inside a statement — SQLite's table-rebuild recipe, the exact case
the previous amendment adopted `drizzle-kit` to get right.

**One store, one connection.** Drizzle's Effect driver runs on the same `SqlClient`, so the boot loop
and the run ledger share one connection and therefore one write lock, rather than opening the file
twice in one process.

**Pins.** `drizzle-kit` follows the `rc` tag and supplies `generate`, `check`, and its agent skills.
`drizzle-orm` is pinned to `1.0.0-rc.5-169397b` rather than the `rc` tag, because `rc.4` calls
`Schema.TaggedErrorClass` from its Effect driver — a name that exists only on Effect's beta line —
so `drizzle-orm/effect-sqlite-node` cannot be imported on the rc line at all. Move to the release
that carries that fix. `effect` moved to `4.0.0-rc.112` with it.
