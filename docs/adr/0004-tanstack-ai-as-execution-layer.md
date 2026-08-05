# 0004 — TanStack AI is the unified AI execution layer

- **Status:** accepted
- **Date:** 2026-07-28

## Context

The orchestration engine needs to (a) drive coding-agent harness sessions (Cursor, Claude
Code, Codex) in checkouts and (b) make direct model calls of its own (triage routing,
summaries). The audiodog orchestrator hand-rolled a `HarnessAdapter` port on `@cursor/sdk`
and never implemented its Claude/Codex placeholders. Alternatives considered: keep the
hand-rolled port per harness; use Effect v4's unstable AI modules for model calls; special-case
Cursor on `@cursor/sdk` while using TanStack for the rest.

## Decision

Both layers go through TanStack AI. Harnesses run via its sandbox + harness adapters
(`claudeCodeText`, `codexText`, first-class; Cursor via `acpCompatible` over `agent acp`)
with the `localProcessSandbox` provider pointed at git worktrees on the host. Direct model
calls use the same library's provider adapters. Everything — harness sessions and raw model
calls alike — streams one AG-UI event protocol, which the daemon can persist and relay to
any client (CLI, GUI, feldspar) without per-vendor translation.

## Consequences

- Harness choice becomes configuration, not code; the per-vendor adapter port disappears.
- One event protocol end-to-end is the backbone of the client/daemon RPC surface.
- We take on beta risk: the sandbox layer is the newest part of TanStack AI (in-memory
  resume bookkeeping today), and Cursor's blocking ACP extension methods
  (`cursor/ask_question`, `cursor/create_plan`) need verification under a headless generic
  client. Fallback if the Cursor ACP path proves lossy: a `@cursor/sdk`-backed adapter for
  Cursor only, behind the same interface.
