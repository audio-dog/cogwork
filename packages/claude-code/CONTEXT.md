# Claude Code (harness adapter)

The Claude-specific [harness runner](../engine/CONTEXT.md). It implements the engine harness contract through the installed Claude Code CLI with TanStack AI's Claude Code adapter. The engine knows nothing about Claude Code; this package knows nothing about scheduling.

## Language

**claudeCodeRunner**:
The factory that produces the Claude Code harness runner. It projects the Run Plan into the prepared checkout, starts Claude Code there, and returns native AG-UI events.
_Avoid_: Anthropic provider runner, Claude API runner

**Host login**:
Authentication owned by the Claude Code installation on the Runtime Host. Cogwork never injects an API key or auth token. The local Sandbox provider removes inherited `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` values before every child process starts.
_Avoid_: Anthropic BYOK, inferred authentication

**Anthropic BYOK**:
Authentication owned by the principal through the Credential store. The runner resolves a fresh Anthropic provider key for each Run and projects it as an `ANTHROPIC_API_KEY` `SecretRef` into only the live Sandbox. The Claude adapter stays in host mode so it cannot copy ambient daemon credentials; the Sandbox receives only the explicit Run secret and removes inherited `ANTHROPIC_AUTH_TOKEN` values. A missing key fails before launch with the operator command that stores one. It never falls back to Host login.
_Avoid_: Claude Code API-key mode, ambient environment authentication, Host login fallback

**Sandbox lineage**:
The ownership boundary for an opaque Claude session handle. Resume is allowed only on the Runtime Host and in the Sandbox lineage that created the Session. The runner declares journal, takeover, and fork support for later orchestration work, but the shared runtime enables none of them.
_Avoid_: Transcript replay, cross-worktree resume

**MCP config projection**:
The Run's MCP servers travel through Claude's inline `--mcp-config` argument. The JSON holds only URLs and `${...}` environment references, so no generated MCP file can enter the driven checkout. The shared runtime resolves each bearer token onto the live Sandbox environment. A repository's own `.mcp.json` is untouched ambient state.
_Avoid_: `.mcp.json` (that name belongs to the repository), credential file, adapter patch

**Ambient Claude state**:
Optional instructions, skills, plugins, hooks, and settings that Claude loads from its user and project sources. The session event records what Claude reports. This state never satisfies required instructions, MCP, or policy checks; those arrive through the Harness Workspace and preflight.
_Avoid_: Harness Workspace, required capability

**Setup handoff**:
Readiness checks installation, supported CLI version, and the runner's explicit authentication binding independently. Host login checks `claude auth status` and gives the operator a `claude auth login` path. Anthropic BYOK checks the Credential store and gives the operator a `cogwork login key --provider anthropic` path. A failed binding never tries the other mode. An unavailable Claude Code runner does not block other registered Harnesses.
_Avoid_: Daemon startup check, provider fallback

**Stage-result interface**:
The runner passes the engine-owned root JSON Schema to Claude Code and returns one terminal `structured-output.complete` event. The executor, not this package, decodes the result before coordination changes.
_Avoid_: Text-result parser, result footer

Run `pnpm --filter @cogwork/claude-code test:claude-live` only when an authenticated Claude Code CLI is available. It is the opt-in compatibility probe for fresh launch, session resume, and structured output.
