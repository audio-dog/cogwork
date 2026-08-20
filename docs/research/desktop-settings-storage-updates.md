# Local desktop settings storage, updates, and migrations

Resolves [Research local desktop settings storage, updates, and migrations](https://github.com/colonylabs/cogwork/issues/129), part of [Wayfinder: unify settings, Plugins, and agent capabilities](https://github.com/colonylabs/cogwork/issues/124).

## Question

What local persistence and migration patterns best fit an auto-updating Electron application whose settings must be schema-validated, transaction-safe, CLI-accessible, and replaceable by a remote adapter later?

## Recommendation

Use a hybrid with one authority for each kind of data:

- Store Cogwork-managed settings, installed Plugin state, capability selections, Connections metadata, source registrations, revisions, and provenance in one local SQLite database.
- Keep checked-in repository inputs and user-owned declarative files as external, versioned input sources. Resolve them into effective settings; do not copy them into another runtime authority or silently rewrite them.
- Store secret references with settings, but store secret values behind a separate `SecretStore` port.
- Give the engine a domain-level `SettingsStore` port. The desktop app and CLI call the same engine service over the existing transport. They do not open or mutate SQLite independently.
- Continue with Drizzle over the built-in `node:sqlite` driver. Generate committed SQL migrations during development and run them programmatically at application startup. Use Effect for service composition, scoped resource ownership, schema decoding, typed migration failures, and change publication.

This is not “SQLite instead of declarative config.” SQLite is the canonical store for data Cogwork owns; declarative files are canonical for inputs owned by a user or repository. The resolver is the only place that combines them.

## Why this fits Cogwork now

Electron defines `userData` as the conventional location for application configuration and user data. It recommends an app-specific subdirectory because Chromium also writes into that directory ([Electron `app.getPath`](https://www.electronjs.org/docs/latest/api/app#appgetpathname)). The database should therefore live under a stable Cogwork data directory beneath `userData`, not inside the application bundle. The CLI and headless host need a platform-neutral path resolver that selects the same directory; Electron main supplies `userData`, while a headless composition uses the equivalent operating-system path.

Cogwork already uses Drizzle `1.0.0-rc.2` with `node:sqlite` for its run ledger. Drizzle officially supports passing a `DatabaseSync` client to its `node:sqlite` driver ([Drizzle Node SQLite](https://orm.drizzle.team/docs/sqlite/connect-node-sqlite)). Electron 43 embeds Node 24, so Cogwork can use `node:sqlite` without adding an Electron-ABI-specific native addon ([Electron 43 stack](https://www.electronjs.org/blog/electron-43-0), [Node SQLite](https://nodejs.org/api/sqlite.html)). This matters because third-party native Node modules otherwise need rebuilding against Electron's ABI on every relevant Electron upgrade ([Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/)). Node 24 still marks `node:sqlite` as active development even though it is enabled without a flag ([Node 24 SQLite](https://r2.nodejs.org/dist/v24.11.0/docs/api/sqlite.html)); pin and test the Electron/Node/Drizzle combination on every application update instead of treating the driver API as stable.

The current ledger bootstrap uses `CREATE TABLE IF NOT EXISTS`, ad hoc `ALTER TABLE`, and data rewrites during `open()`. That is acceptable for a disposable ledger, but it is not a safe template for durable settings. Durable settings need an ordered migration history, an explicit compatibility check, a pre-migration backup, and a boot failure if migration fails.

## Options compared

| Option | Strengths | Failure modes | Fit |
|---|---|---|---|
| SQLite only | Atomic multi-record changes; constraints; queryable provenance; cross-process locking; ordered migrations; consistent backup | Opaque to Git; easy to accidentally make SQL the domain interface; schema upgrades complicate binary rollback | Best for Cogwork-owned mutable state, not repository-owned inputs |
| Versioned JSON/YAML files only | Human-readable; diffable; easy to check in, copy, and repair; natural for repository ownership | A read-modify-write can lose a concurrent update; no transaction across files; awkward indexing and relationships; migrations rewrite user files; temp-file rename protects replacement but not a multi-file unit | Best for externally owned inputs and interchange, not the app's mutable authority |
| Hybrid | Preserves ownership and provenance while giving app-managed state database guarantees | Requires an explicit resolver and clear ownership rules | Best overall |

SQLite gives transactions an all-or-nothing result even across a crash or power loss ([SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)). It also coordinates separate connections with file locks. WAL mode allows readers and a writer to proceed concurrently, but SQLite still permits only one writer at a time and WAL must stay on one host ([SQLite WAL](https://www.sqlite.org/wal.html)). Those limits are appropriate for a local desktop control plane.

The hybrid must not become two mutable stores for the same record. Every source needs an owner and source kind:

- **Cogwork-managed**: canonical row in SQLite.
- **Checked-in repository input**: canonical file in the repository; SQLite may cache an index or last diagnostic, never a competing value.
- **Private workspace input**: canonical user-owned declarative file or a Cogwork-managed row, chosen explicitly when created. Do not mirror it both ways.
- **Imported legacy input**: read once into a selected canonical destination, then record provenance and stop reading the legacy source after cutover.

Every declarative file format should have a top-level format version and stable source identity. Decode old supported versions into the current domain model without rewriting checked-in files. Unsupported future versions fail with a source diagnostic. Effect Schema is designed to validate and transform unknown encoded data at boundaries; its source exposes separate decode and encode representations rather than treating a TypeScript type as runtime validation ([Effect Schema source](https://github.com/Effect-TS/effect/blob/66114151c2b4640bf773f2b3456ce70d679422f6/packages/effect/src/Schema.ts)).

## Access and concurrency model

Make the daemon-hosted engine the single logical writer.

```text
Desktop renderer ─┐
                  ├─ typed RPC ─ Settings service ─ SettingsStore ─ SQLite
CLI ──────────────┘                         └─────── SecretStore
```

This gives app and CLI parity at the service contract rather than at the database-driver level. It also means a later hosted implementation can replace the local service or store adapter without teaching every client SQL. A headless CLI invocation may host the same engine composition when no desktop daemon exists, but startup must acquire the same application/maintenance lock before opening for writes.

Use WAL for normal operation, a bounded busy timeout, foreign keys, and transactions for every command that changes more than one row. `node:sqlite` exposes a connection timeout for lock contention ([Node SQLite `DatabaseSync`](https://nodejs.org/api/sqlite.html#class-databasesync)). Treat a timeout as a typed “settings store busy” failure; do not retry an unbounded write. SQLite supports many readers but only one write transaction, and `BEGIN IMMEDIATE` either reserves that writer or returns `SQLITE_BUSY` ([SQLite transactions](https://www.sqlite.org/lang_transaction.html)).

Do not copy, replace, unlink, or rename an open database. In WAL mode the `-wal` file is part of the persistent database state; separating it can lose committed transactions or corrupt the database ([SQLite WAL file](https://www.sqlite.org/wal.html#the_wal_file), [SQLite corruption guidance](https://www.sqlite.org/howtocorrupt.html)). Backups must use SQLite's backup API or `VACUUM INTO`, not a raw filesystem copy of a live database. The online backup API produces a consistent snapshot while allowing bounded concurrent use ([SQLite Backup API](https://www.sqlite.org/backup.html)); Node exposes it as `sqlite.backup()` ([Node SQLite backup](https://nodejs.org/api/sqlite.html#sqlitebackupsourceDb-path-options)).

Settings writes should carry an expected revision. Locally, compare and increment it in the same transaction. This prevents stale app panels or CLI invocations from silently overwriting a newer value and supplies the optimistic-concurrency shape a future remote adapter will need.

## Application updates and data migrations

Treat these as independent version axes:

1. **Application version**: the signed Electron binary delivered by `electron-updater`.
2. **Settings schema version**: the ordered SQLite migration level understood by the engine.
3. **Declarative input format version**: the wire format of each file source or export.
4. **Plugin version and Plugin manifest version**: the installed bundle and the contract used to describe it.

Electron's updater downloads an update and applies it on `quitAndInstall()` or the next application start; on macOS, automatic updates require a signed application ([Electron `autoUpdater`](https://www.electronjs.org/docs/latest/api/auto-updater/)). With electron-builder, `electron-updater` reads generated update metadata from the packaged resources ([electron-builder auto update](https://www.electron.build/docs/features/auto-update/)). These mechanisms replace application files. They do not migrate or roll back user data.

Run settings migrations before the daemon begins scheduling work:

1. Stop or do not start the daemon, and acquire the application maintenance lock.
2. Open the database and inspect its migration history plus a Cogwork metadata row containing the last writer application version and minimum compatible reader version.
3. Refuse to open a database newer than the running application's supported schema. Never let an older binary “best effort” a newer database.
4. Create a consistent pre-migration backup with the SQLite backup API. Retain it until the new application completes at least one healthy startup.
5. Apply all pending forward migrations in one transaction where SQLite permits. Migration files are immutable application resources committed with the code.
6. Run `foreign_key_check` and at least `quick_check`; `integrity_check` is available for recovery diagnostics ([SQLite integrity pragmas](https://www.sqlite.org/pragma.html#pragma_integrity_check)).
7. Commit the new schema metadata, release maintenance mode, and start the daemon.
8. If any step fails, do not start agents. Roll back the transaction. Preserve the failed database and diagnostics; restore the pre-migration backup to a new path and replace only after all connections are closed.

Drizzle Kit supports a code-first flow that generates SQL migration files and records applied migrations in `__drizzle_migrations` ([Drizzle migrations](https://orm.drizzle.team/docs/migrations), [Drizzle migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate)). Use Kit only at development time. Bundle the generated SQL and call Drizzle's programmatic migrator from the engine boot path. Do not run `drizzle-kit push` in a shipped app: it derives changes from current schema instead of executing the reviewed, ordered history that recovery and support need.

A database transaction protects against a partially applied migration. It does not make every logical transformation correct and does not make an older binary compatible with a newer schema. Therefore:

- Prefer additive, expand-then-contract migrations when practical.
- Make migrations forward-only and deterministic. Never edit a released migration.
- Test every supported old schema fixture to the current version and test interruption/failure paths.
- Do not promise automatic data downgrade. A binary rollback is safe only if the older binary explicitly supports the current schema, or if Cogwork restores the matching pre-upgrade snapshot and accepts loss of post-upgrade settings edits.
- Record a migration attempt and result outside the database log as well, so a database that cannot open still has actionable diagnostics.

Effect's SQL migrator is useful evidence for the desired behavior: it loads numbered migrations, records completed IDs, rejects duplicates, detects a concurrent migration, and runs pending work through `SqlClient.withTransaction` ([Effect Migrator source](https://github.com/Effect-TS/effect/blob/66114151c2b4640bf773f2b3456ce70d679422f6/packages/effect/src/unstable/sql/Migrator.ts), [Effect SqlClient source](https://github.com/Effect-TS/effect/blob/66114151c2b4640bf773f2b3456ce70d679422f6/packages/effect/src/unstable/sql/SqlClient.ts)). Cogwork should not run both Drizzle and Effect migration histories. Keep Drizzle as the SQL and migration tool while it remains the query layer; reproduce the same typed lock/failure behavior at the Effect service boundary.

## Secrets

Do not put plaintext OAuth tokens, API keys, or MCP credentials in the settings database or declarative files. Store a stable secret reference and non-secret Connection metadata in settings; resolve the value only when the engine assembles a capability.

Electron `safeStorage` encrypts strings with operating-system facilities, but it is a main-process API rather than a complete credential vault. Its guarantees vary by platform, and Linux can fall back to a `basic_text` backend; the asynchronous API reports key rotation and temporary unavailability ([Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)). Consequently, define a `SecretStore` port rather than coupling domain services to `safeStorage`:

- Desktop composition may encrypt stored blobs through Electron main or use a native credential-store adapter.
- Headless/CI composition may use environment variables or another explicit adapter.
- The renderer and agents never receive broad secret-store access.
- Backups and exports omit secret values by construction.

This also avoids making the future remote settings store responsible for moving local machine secrets. Remote records can continue to hold references whose resolver belongs to a Runtime Host.

## Future remote-store seam

The expensive seam is the domain contract, not the database library. Define storage operations in the engine's ubiquitous language: list sources, install a Plugin, update a scoped capability selection, register a Workspace, resolve a Connection, compare a revision, and subscribe to committed changes. Do not expose tables, SQL fragments, filesystem paths, or a generic key-value API to app features.

Each durable record should already carry:

- A stable opaque ID independent of a local path or database rowid.
- An explicit owner/principal and target scope.
- Source kind and provenance.
- Revision plus created/updated timestamps.
- Schema or manifest version where the record crosses a boundary.

The local adapter may implement these operations with one SQLite transaction. A future remote adapter will add authentication, authorization, tenancy, network retries, and synchronization; those concerns should remain visible rather than hidden behind an unrealistically database-shaped interface. Effect `Context.Service` and `Layer` make the local store, remote store, and test store replaceable at composition boundaries while keeping typed failures in the service contract ([Effect Context source](https://github.com/Effect-TS/effect/blob/66114151c2b4640bf773f2b3456ce70d679422f6/packages/effect/src/Context.ts), [Effect Layer source](https://github.com/Effect-TS/effect/blob/66114151c2b4640bf773f2b3456ce70d679422f6/packages/effect/src/Layer.ts)).

After every successful local transaction, the service should publish a revisioned settings-changed event. App views invalidate from that event; the resolver can rebuild the effective capability set for the next run. Filesystem watching remains limited to external declarative sources and produces the same source-changed event after a successful schema decode.

## Decisions this research supports

- Choose the hybrid: SQLite for Cogwork-owned mutable settings; declarative files for repository and user-owned inputs.
- Keep one engine-owned settings service and one logical writer. Desktop and CLI are clients.
- Use Drizzle plus built-in `node:sqlite`; avoid another native SQLite dependency and avoid a second ORM/migrator.
- Bundle immutable forward migrations; back up, migrate, validate, then start the daemon.
- Fail closed on a migration or compatibility error. Never dispatch agents with partially resolved or stale settings.
- Separate secret storage from settings storage.
- Design the store around stable domain operations, ownership, provenance, and revisions so a remote adapter can replace the local one later.

## Remaining decisions

This research does not settle the table layout, exact settings service methods, declarative file syntax, operating-system data path outside Electron, or which desktop secret adapter to ship first. Those belong in the architecture and capability-model decision tickets after the domain names and precedence rules are settled.
