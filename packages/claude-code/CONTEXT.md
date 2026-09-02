# Claude Code (harness adapter)

The Claude-specific [harness runner](../engine/CONTEXT.md). It implements the engine harness contract through the installed, already-authenticated Claude Code CLI with TanStack AI's Claude Code adapter. The engine knows nothing about Claude Code; this package knows nothing about scheduling.

## Language

**claudeCodeRunner**:
The factory that produces the Claude Code harness runner. It projects the Run Plan into the prepared checkout, starts Claude Code there, and returns native AG-UI events.
_Avoid_: Anthropic provider runner, Claude API runner

**Host login**:
Authentication owned by the Claude Code installation on the Runtime Host. Cogwork never injects an API key or auth token. The local Sandbox provider removes inherited `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` values before every child process starts.
_Avoid_: Credential-store authentication, API-key mode

**Sandbox lineage**:
The ownership boundary for an opaque Claude session handle. Resume is allowed only in the Sandbox lineage that created the session. The runner declares fork support for later orchestration work but does not fork sessions in this package.
_Avoid_: Transcript replay, cross-worktree resume

**Ambient Claude state**:
Optional instructions, skills, plugins, hooks, and settings that Claude loads from its user and project sources. The session event records what Claude reports. This state never satisfies required instructions, MCP, or policy checks; those arrive through the Harness Workspace and preflight.
_Avoid_: Harness Workspace, required capability

**Setup handoff**:
Readiness checks installation, supported CLI version, and host login independently. A missing or logged-out Claude Code installation makes only this Harness unavailable and gives the operator a `claude auth login` path. Other registered Harnesses remain usable.
_Avoid_: Daemon startup check, provider fallback

**Stage-result interface**:
The runner passes the engine-owned root JSON Schema to Claude Code and returns one terminal `structured-output.complete` event. The executor, not this package, decodes the result before coordination changes.
_Avoid_: Text-result parser, result footer

Run `pnpm --filter @cogwork/claude-code test:claude-live` only when an authenticated Claude Code CLI is available. It is the opt-in compatibility probe for fresh launch, session resume, and structured output.
