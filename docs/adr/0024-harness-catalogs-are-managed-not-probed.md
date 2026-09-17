# 0024 — Harness catalogs are managed, not probed

- **Status:** accepted
- **Date:** 2026-09-17

## Context

A Harness option catalog was resolved at read time through a runtime → native → fallback chain, so
listing models spawned Harness CLIs and priced every catalog read at the slowest probe (10-second
deadline). Option axes were invisible to the contract: Cursor packs effort, speed, and thinking into
composite model ids (`gpt-5.6-luna-high-fast`), Codex has a native reasoning-effort field, Claude has
neither, and the shared settings knew only `model` plus a special-cased `effort` string. Every
Harness expresses the same concepts differently, and no probe can normalize that.

## Decision

Catalogs are checked-in data, not runtime observations.

- Each Harness package ships a generated catalog module: base models, each carrying **option
  descriptors** (select or boolean). A sync script produces it — using the CLI where it helps
  (Cursor's `--list-models`), static data where it does not (Codex).
- Descriptors use **canonical option ids** for concepts more than one Harness has — `effort`,
  `speed`, `context` — while the *values* stay Harness-native. Harness-specific axes keep their own
  ids.
- The sync script decomposes composite native ids into base model + option values. The raw native id
  list stays in the generated file as the **validity oracle**: descriptors are per-axis and cannot
  express sparse combinations (no `claude-sonnet-5-*-fast` exists), so a recomposed native id must
  be checked against the raw list. An id the script cannot parse passes through as an opaque model
  with no descriptors — never dropped, never guessed.
- The catalog records the CLI version it was generated against. Version drift against the installed
  CLI is accepted: readiness (which already probes `--version`) reports the mismatch as a
  diagnostic; there are no per-model version bounds.
- Probing is demoted to **Harness readiness** only: measured at daemon boot and on invalidation,
  cached, published as events. No picker read and no settings write ever waits on a CLI probe.
- No remote catalog fetch. A new catalog rides an app update; this is a local desktop product today.

## Considered options

Runtime probing (status quo) makes catalog reads slow and cannot see option axes at all. t3code's
hybrid — remote-fetched manifest plus per-runtime discovery with free-form option ids — fits a
hosted product that receives ids from external runtimes at probe time; we author our catalogs at
generation time, so canonical ids cost one constant per sync script and buy one shared word per
concept across UI, stale checks, and future engine policy.

## Consequences

The engine's runtime → native → fallback catalog resolution deletes. The standalone `effort`
operation setting retires into a `model-options` selections value that changes and clears atomically
with `model`. New Harness models require a resync PR, and the diff shows exactly what a CLI release
changed.
