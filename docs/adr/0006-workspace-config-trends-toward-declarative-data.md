# 0006 — Workspace config trends toward declarative data, not executable code

- **Status:** accepted
- **Date:** 2026-08-05

## Context

The daemon loads workspace config by `import()`-ing `*.workspace.{ts,mts,cts}` files from
the config home — it *executes* them as TypeScript, not parses them as data. Full code
execution by design. #10 narrowed the surface to that suffix; the trust assumption
("the config home is owner-controlled") was never written down.

The open question was whether to just document that assumption, or to add sandboxing /
allowlisting before config could ever come from a less-trusted source (a sync service, a
shared folder, a GUI download).

The reference implementations all separate *settings* from *extensibility*. opencode,
t3code, Cursor, and Codex keep config as declarative, schema-validated JSON (opencode even
offers a `$schema` and remote JSON config). The only place opencode runs code is an
explicit plugin system — loaded by `import()` from a plugin dir or an npm package,
unsandboxed, trusted purely by provenance. Nobody sandboxes; nobody makes their base
config executable either. clanker-forge is unusual in collapsing settings and code into
one executed file.

This matters for the trajectory: as clanker-forge becomes a desktop and then web app,
config should be GUI-editable and cloud-syncable — which executable TypeScript from a
folder is not.

## Decision

Workspace config trends toward **declarative, schema-validated data** — the model that is
GUI-editable, cloud-syncable, and cannot execute. Executable code, if ever needed, becomes
an explicit, opt-in plugin layer trusted by provenance, never the base config.

For now:

- **Document** the current trust model honestly: config is executable TypeScript from an
  owner-controlled config home, run as the user; the `*.workspace.*` suffix filter is the
  only guardrail.
- **No sandbox.** The migration to declarative data is the real mitigation; building a
  sandbox for a model we intend to leave behind is wasted effort.

The migration from executable config to declarative data is future work, tracked
separately.

## Consequences

- The config-as-code trust question dissolves in the target state — data cannot execute,
  so there is nothing to sandbox.
- clanker-forge gains cloud sync and a GUI config editor almost for free once config is
  data, matching the Cursor/Codex model.
- A migration is owed: the current `*.workspace.ts` files and the `import()`-based loader
  must move to a declarative schema. Until then, the documented trust assumption stands as
  the interim guardrail.
