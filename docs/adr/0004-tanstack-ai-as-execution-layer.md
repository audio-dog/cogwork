# 0004 — TanStack AI is the unified AI execution layer

- **Status:** accepted — extended by engine ADR 0006 (`packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md`): the `HarnessRunner` port does not disappear; a first-party TanStack runner and the CLI harness adapters both live behind it, and only the owned provider layer serves direct model calls.
- **Date:** 2026-07-28

## Context

The orchestration engine needs to (a) drive coding-agent harness sessions (Cursor, Claude
Code, Codex) in checkouts and (b) make direct model calls of its own (triage routing,
summaries). Alternatives considered: keep the
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

## Durable execution boundary

Cogwork gives every TanStack Harness invocation its globally unique `RunId` as `runId` and its `SessionId` as `threadId`. Native Claude, Codex, and Cursor handles remain adapter model options. Claude Code and Codex declare journal and takeover support. Cursor ACP declares no support. Cogwork has no OpenCode runner, so no OpenCode capability profile exists to activate; any future runner must initially declare no journal or takeover support.

Capability is not activation. The shared external Harness runtime uses nondurable `withSandbox` without Run stores, stream durability, journal, detach, attach, takeover, or reaping. Cancellation aborts and destroys the local execution. A disconnect or daemon death does not prove that the child process stopped, so diagnostics must not claim that `SIGKILL` established safe detachment.

Restart recovery creates a replacement Run and a new native invocation. It can resume the prior Session with a continuation Message, but it is neither a retry of an interrupted attempt nor a takeover of the old Run. Attach-first recovery stays deferred until persistent Harness execution status, exact delivery logging, durable cancellation, supported locking and fencing, and scheduled reaping exist together. Decoded Run events remain the client and ledger projection; they are not a TanStack `StreamDurability` exact chunk log.
