# Control store convergence — implementation plan

Executes the 2026-09-01 amendment to
[ADR 0015](../adr/0015-one-control-store-with-engine-owned-migrations.md): boot converges
`~/.cogwork/control.db` to `packages/engine/src/control-store-schema.ts` using drizzle-kit's differ
statements-only, replacing the exact-fingerprint compare-and-refuse. Read the amendment first; this
plan is the *how*, the ADR is the *what and why*, and where they disagree the ADR wins.

Before writing code: invoke `/effect-ts`, read `docs/agent-patterns/effect-control-flow.md` and
`docs/agent-patterns/effect-test-layers.md`, and load the drizzle agent skills
(`pnpm dlx @tanstack/intent@latest list` → `drizzle-kit#drizzle`, `#drizzle-push`, `#drizzle-hints`,
`#drizzle-responses-and-errors`). The skills ship inside the installed `drizzle-kit` package
(`drizzle-kit skills` writes local copies; they are git-ignored).

## Step 1 — settle the entry point (spike, throwaway)

Two statements-only surfaces exist in `drizzle-kit@1.0.0-rc.4`. Pick one; record the choice and the
reason in the PR description.

- **`drizzle-kit/payload/sqlite` → `pushSchema(imports, client)`**: takes the schema as an
  already-imported module (no file loading, no jiti — packaging-safe), introspects through a
  three-method `{query, run, batch}` client, returns `{sqlStatements, hints, apply}`. Never call
  `apply`. Known edges, all verified: a rename-shaped diff (same-kind create + delete in one diff)
  throws `Internal error: resolver(...) was called without a HintsHandler`; the `hints` array is
  lossy non-interactively (destructive statements can appear with no hint) so `sqlStatements` is the
  only gate; `generateDrizzleJson` calls `process.exit(1)` on schema validation errors.
- **SDK `push({...})` in explain mode**: the public, skill-documented surface; returns the typed
  envelope (`ok` with `statements` + `hints`, `missing_hints` with the full
  rename/`confirm_data_loss` resolution protocol, typed `error` codes). Known edges: loads the schema
  from a file path via jiti (needs an asar-unpacked compiled schema file in the packaged app), and
  rc.4 has a type/runtime mismatch on `hints` (runtime wants a JSON string; the misleading failure is
  `missing_required_params_error: ["dialect","schema"]`).

Spike acceptance: from a plain Node 22 process, diff a live SQLite file against the schema module and
get statements for (a) fresh create, (b) added column, (c) added table, (d) column type change (must
produce the table-recreate dance), (e) a rename-shaped edit (must surface detectably — thrown error
or `missing_hints` — not silent drop-and-add). Decide only on what the spike shows.

## Step 2 — the converge step in `control-store.ts`

Replace `schemaFingerprint` / `expectedSchemaFingerprint` / the compare in `boot`
(`packages/engine/src/control-store.ts:562-622`) with:

1. Build the entry point's client over the existing Effect `SqlClient` (wrap sync effects per
   `effect-process-edges.md` if the surface demands promises).
2. Diff. Empty statements → done (idempotent boot, the common case).
3. Inspect statements (pre-alpha: log them; the classification exists so the release flip is a
   policy change, not a rewrite).
4. Execute through the store's own `SqlClient` inside a transaction. Note: `PRAGMA foreign_keys` is
   a no-op inside a transaction — if recreate statements arrive with the pragma, execute the pragma
   outside and the rest within, matching what drizzle's own apply does.
5. Re-diff. Non-empty → converge failed → the existing fail-closed `unavailable` path, statements
   in the error for diagnosis.

Pre-alpha fallback: a rename-shaped diff (however the chosen entry point surfaces it) renames the
store file to a timestamped sibling and converges a fresh file from nothing. Never delete; the
backup is the evidence. All other converge errors: fail closed, file untouched (existing
`bootControlStoreLayer` behavior).

`seedDaemonLimits` and `retainRunEvents` stay after convergence, unchanged.

## Step 3 — retire the generated create statements (confirm first)

If the packaged app can hand the schema module to the differ (step 1 proves this for the payload
surface; the SDK surface instead needs an unpacked schema file):

- Delete `control-store-create.gen.ts`, `scripts/generate-control-store-create.mjs`, the
  `drizzle:schema` / `drizzle:check` package scripts, and their CI wiring.
- Tests and in-memory stores create by converging from empty — same path as production.

If not confirmed, keep the gen file as the differ's input and say so in the PR.

## Step 4 — tests (`@effect/vitest`, per `effect-test-layers.md`)

Fresh-file converge equals the old create path (schema introspection matches). Idempotent second
boot: zero statements. Add-column and add-table converge preserving existing rows. Column type
change: recreate dance runs, rows survive. Rename-shaped diff: backup-and-recreate fires, original
file preserved. Post-converge verification failure: fail-closed `unavailable`. Two racing boots on
one file: one converges, neither corrupts (the store's write lock; see ADR 0015 on `BEGIN
IMMEDIATE`).

## Step 5 — dependency and docs

- `drizzle-kit` moves from dev-only to an exact-pinned runtime dependency of `@cogwork/engine`
  (`1.0.0-rc.4` today; bump deliberately, never by tag — the rc line has regressed before).
- Rewrite `AGENTS.md` § Drizzle: no more "delete `~/.cogwork/control.db`", no `drizzle:schema` /
  `drizzle:check` (if step 3 lands), dev loop is "edit schema, restart daemon".
- Desktop packaging: confirm the engine's drizzle-kit import survives electron-builder (no asar
  surprise); the payload surface needs nothing on disk.

## Step 6 — review passes

`reviewer`, `rule-reviewer`, and `complexity-skeptic` before the PR — the skeptic specifically on
step 2 (the converge step should be *smaller* than the fingerprint machinery it replaces, not
larger).

## Out of scope

The data-transform hatch (shape decided in the ADR, built when the first transform exists). The
pre-release policy flip (destructive/rename-shaped → fail closed) — tracked as a release
prerequisite, not built now. Anything about the future hosted database.
