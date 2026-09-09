# 0023 — Codex Runs trust ambient Hooks for registered Workspaces

- **Status:** accepted
- **Date:** 2026-09-09

## Context

Codex skips untrusted Hooks silently in non-interactive Runs. The only direct CLI grant applies to
every enabled Hook in the invocation. The narrower alternative requires Cogwork to reproduce
Codex's private trust machinery or operate its app-server protocol only to persist individual trust
entries.

## Decision

Every Codex Run bypasses Hook trust, so repository Hooks such as post-edit formatting can run without
an interactive prompt. This is a narrow Harness exception to ADR 0013's repository-Hook prohibition
and resolves ADR 0018's deferral only for Hooks that Codex discovers ambiently. Cogwork still does not
project Hook contributions or define their settings.

## Consequences

The grant also trusts Hooks enabled in the operator's Codex configuration. That broader grant is
accepted while Cogwork operates registered, trusted Workspaces: a Run already executes their build
and test code. Revisit this decision before Cogwork runs untrusted third-party Workspaces.
