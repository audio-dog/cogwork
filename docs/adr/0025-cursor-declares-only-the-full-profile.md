# 0025 — Cursor declares only the Full profile

- **Status:** accepted
- **Date:** 2026-09-17

## Context

The Cursor runner declared zero execution profiles because ACP cannot prove worktree confinement or
read-only enforcement — Cursor decides which native actions request permission. The runner therefore
rejected every local-process Run, which made Cursor invisible in the Operation picker while the
unusable BYOK `provider` skeleton remained selectable. Codex has the same enforcement gap
(`policyFidelity: "none"`) yet declares both profiles; ADR 0023 accepted trusting Codex's ambient
hooks, and ADR 0005 places the trust boundary at authentication, not payload control.

## Decision

Cursor declares exactly one Operation profile: **Full**. It makes no Read only claim it cannot keep.
Because each Operation's permission profile is locked by its Operation Definition (Triage: Read
only; Implement and Follow-up: Full), Cursor is selectable for Implement and Follow-up and never for
Triage. The Operation picker becomes Operation-aware: it offers only Harnesses whose declared
profiles include that Operation's locked profile.

## Consequences

This reverses the refuse-everything posture previously documented in `packages/cursor-acp/CONTEXT.md`
— do not "fix" Cursor back to hidden. The Full declaration trusts Cursor's own permission mode the
same way ADR 0023 trusts Codex's hooks. Revisit when TanStack AI / ACP gains an enforceable
permission mapping or an isolated Sandbox provider lands; either can justify adding the Read only
profile.
