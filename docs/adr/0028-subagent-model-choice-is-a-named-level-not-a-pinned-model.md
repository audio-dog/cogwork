# 0028 — Subagent model choice is a named level, not a pinned model

- **Status:** accepted
- **Date:** 2026-09-23

## Context

Every reviewer-role spawn on the codex Harness failed with an unsupported-model error — a recurring
per-run tax the 2026-09-23 retrospective measured on every implement Run. The first diagnosis blamed
vendor aliases pinned in the role definitions; the truth was one layer down. The sync toolkit that
authors those definitions already resolves a semantic tier per target (`fast` / `default` /
`powerful` at the time), and the rendered Claude aliases were that mechanism working correctly. What
broke was the **codex row of the tier table going stale**: it mapped to `gpt-5.4` and
`gpt-5.4-mini`, which the account's model list — the codex-cli package's managed catalog (ADR
[0024](./0024-harness-catalogs-are-managed-not-probed.md)) — no longer contains, and codex validates
every spawn against that list. One role definition also pinned a raw vendor alias, bypassing tiers
entirely. A stale mapping fails silently on every run; nothing checked it against the catalog.

[`harness-model-selection-and-run-speed.md`](../research/harness-model-selection-and-run-speed.md)
surveyed the three Harnesses: Claude Code takes family aliases or full ids with a documented
resolution order; Codex takes exact account-valid slugs plus a native reasoning-effort field in TOML
agent files; Cursor takes `inherit` or exact ids with bracket parameters. No cross-harness model
vocabulary exists. The one portable convention is *omission*: a role with no model field runs on the
parent Run's model in all three. This is the same shape ADR 0024 already resolved for option axes: a
canonical id for the shared concept, Harness-native values underneath.

Not every role needs the Run's model. Mechanical rule-checking is classification-shaped work both
vendors document as a small-model cascade case; judgment review is not.

## Decision

A role's model choice is a named **Model level** with three values:

- **`light`** — the cheapest capable model on whatever Harness runs the role. First customers:
  rule-reviewer, and the triage operation as a whole.
- **`standard`** — the Run's own model or the tool's default judgment model, rendered as omission
  where the Harness inherits by omitting. The default for every role not named here.
- **`deep`** — a reasoning-heavy escalation tier. Named now so the vocabulary is complete; no role
  uses it yet.

The sync toolkit's existing tier mechanism is the implementation, renamed in place to these three
words so one vocabulary serves both repos. The level maps to Harness-native values at authoring time
(`light` → `haiku` for Claude Code, an account-valid small slug for Codex, an exact id for Cursor),
and the codex row must be verified against the codex-cli package's managed catalog when it changes —
a stale row is exactly the silent failure this decision cleans up. Vendor model names never appear
in a role definition's source; only the level does.

Whole-operation model selection needs no new mechanism: Operation settings already resolve a model
per operation, so "triage runs light" is a settings row.

The Run Plan's Subagents member is the eventual home: when a Harness adapter first declares
Subagents in its projected members, the member carries the level and the adapter owns the mapping
through its managed catalog. Until then the mapping lives with the sync toolkit that authors the
files.

## Considered options

- **Pin vendor models per role, or hand-maintain per-target ids**: breaks whenever the account or
  Harness changes, and the failure mode is a silent per-run tax, not an error a person sees — the
  stale codex row proved it.
- **Always inherit**: fixes the breakage, saves nothing — triage and rule-checking keep paying the
  flagship model for classification-shaped work.
- **Engine-side projection now**: no adapter declares Subagents yet, so this buys the same behavior
  at the cost of the largest change. Deferred, not rejected.

## Consequences

- The contracts glossary gains **Model level**; `light`/`standard`/`deep` become the only words for
  role model capability anywhere in instructions, settings, or role definitions.
- The sync toolkit's tier table is renamed to the three levels and its codex row refreshed against
  the managed catalog; the one raw vendor pin converts to a level.
- When Subagents projection lands, the per-Harness mapping migrates from the sync toolkit into the
  Harness adapters beside their option catalogs, and this ADR's authoring-time mapping retires.
