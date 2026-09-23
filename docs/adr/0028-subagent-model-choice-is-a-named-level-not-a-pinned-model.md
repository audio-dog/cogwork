# 0028 — Subagent model choice is a named level, not a pinned model

- **Status:** accepted
- **Date:** 2026-09-23

## Context

The reviewer subagent definitions pinned vendor model aliases (`model: sonnet`, `model: haiku`).
Those aliases are Claude Code vocabulary; the codex Harness validates a spawn's model against the
account's model list and rejected them, so every implement Run in both workspaces paid a failed
spawn and a fallback re-brief for each pinned role — a recurring tax the 2026-09-23 retrospective
measured on every run.

[`harness-model-selection-and-run-speed.md`](../research/harness-model-selection-and-run-speed.md)
surveyed the three Harnesses: Claude Code takes family aliases or full ids with a documented
resolution order; Codex takes exact account-valid slugs plus a native reasoning-effort field in TOML
agent files; Cursor takes `inherit` or exact ids with bracket parameters. No cross-harness model
vocabulary exists. The one portable convention is *omission*: a role with no model field runs on the
parent Run's model in all three. This is the same shape ADR
[0024](./0024-harness-catalogs-are-managed-not-probed.md) already resolved for option axes: a
canonical id for the shared concept, Harness-native values underneath.

Not every role needs the Run's model. Mechanical rule-checking is classification-shaped work both
vendors document as a small-model cascade case; judgment review is not.

## Decision

A role's model choice is a named **Model level** with three values:

- **`light`** — the cheapest capable model on whatever Harness runs the role. First customers:
  rule-reviewer, and the triage operation as a whole.
- **`standard`** — the Run's own model, expressed by *omitting* the model field. The default for
  every role not named here.
- **`deep`** — a reasoning-heavy escalation tier. Named now so the vocabulary is complete; no role
  uses it yet.

The level maps to Harness-native values at authoring time: the sync toolkit that renders subagent
definitions per Harness renders `light` as `haiku` for Claude Code, as an account-valid small slug
with low reasoning effort for Codex, and as an exact id for Cursor. Vendor model names never appear
in a role definition's source; only the level does.

Whole-operation model selection needs no new mechanism: Operation settings already resolve a model
per operation, so "triage runs light" is a settings row.

The Run Plan's Subagents member is the eventual home: when a Harness adapter first declares
Subagents in its projected members, the member carries the level and the adapter owns the mapping
through its managed catalog. Until then the mapping lives with the sync toolkit that authors the
files.

## Considered options

- **Pin vendor models per role** (status quo): breaks whenever account or Harness changes, and the
  failure mode is a silent per-run tax, not an error a person sees.
- **Always inherit**: fixes the breakage, saves nothing — triage and rule-checking keep paying the
  flagship model for classification-shaped work.
- **Engine-side projection now**: no adapter declares Subagents yet, so this buys the same behavior
  at the cost of the largest change. Deferred, not rejected.

## Consequences

- The contracts glossary gains **Model level**; `light`/`standard`/`deep` become the only words for
  role model capability anywhere in instructions, settings, or role definitions.
- The pinned aliases in the existing subagent definitions are deleted in the sync repo.
- When Subagents projection lands, the per-Harness mapping migrates from the sync toolkit into the
  Harness adapters beside their option catalogs, and this ADR's authoring-time mapping retires.
