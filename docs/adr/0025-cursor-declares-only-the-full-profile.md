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
Permission profiles are a user choice constrained by the selected Harness's declared profiles.
Operations supply canonical defaults — Triage uses Read only; Implement and Follow-up use Full —
but do not restrict Provider selection. Cursor is selectable for every Operation. Because it
declares only Full, that is the only permission choice for a Cursor Run, including Triage.

## Consequences

This reverses the refuse-everything posture previously documented in `packages/cursor-acp/GLOSSARY.md`
— do not "fix" Cursor back to hidden. The Full declaration trusts Cursor's own permission mode the
same way ADR 0023 trusts Codex's hooks. Revisit when TanStack AI / ACP gains an enforceable
permission mapping or an isolated Sandbox provider lands; either can justify adding the Read only
profile without changing the Provider picker.

## Amendment — 2026-11-11

A Full Cursor Run allows every permission request that Cursor sends (`bypassPermissions`), the same
posture as Codex's `approvalPolicy: "never"` and Claude Code's auto-allowed sandboxed Bash. Cursor
asks before any command that is not on the host's own Cursor allowlist. The earlier `default` mode
refused each of those requests, because a headless Run has nobody to answer. So a Run could run a
command only when an ambient Cursor config allowed it. The Implement Runs for
[#901](https://github.com/taylorfsteele/cogwork/issues/901) and
[#912](https://github.com/taylorfsteele/cogwork/issues/912) parked when `pnpm`, `rg`, and file
deletes were refused. A Cursor Triage Run is also Full, so it can run every command too.

Accepted risk: Cursor has no Sandbox and no worktree confinement, so this permission was the last
gate before a command on the Runtime Host. Text in an issue that tells the agent to run a command,
for example one that sends a credential file to another host, can now cause that command to run.
Claude Code and Codex keep their native Sandboxes; Cursor does not have one.
