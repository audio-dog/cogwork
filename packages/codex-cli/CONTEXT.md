# Codex CLI (harness adapter)

The Codex-specific [harness runner](../engine/CONTEXT.md): it implements the engine's harness
contract through the installed, already-authenticated Codex CLI using TanStack AI's Codex adapter.
The engine knows nothing about Codex; this package knows nothing about scheduling.

Role in the flow: `codexRunner` supplies the native descriptor and trusted local-process inputs to
the engine's shared external Harness runtime. The runtime projects the Run and returns Codex's native
AG-UI event stream.

## Language

**codexRunner**:
The factory that produces the Codex descriptor-backed harness runner. The descriptor declares an
opaque Session, native model/effort/authentication projection, readiness and error refinements,
coarse policy fidelity, and required shared-Git access. The shared runtime owns Workspace,
Sandbox, stream, cancellation, event, and structured-output plumbing.
_Avoid_: Provider runner, OpenAI runner

**Durable-run capability**:
The Codex adapter supports journaled output and takeover attachment. The runner declares that fact, but the shared runtime does not supply durability stores or flags, so Codex Runs remain nondurable and locally cancelled.
_Avoid_: Enabled takeover, safe detachment

**Best-effort file diff**:
Codex does not provide the Run activity file contract. The shared runtime observes its Sandbox workspace and emits `sandbox.file.diff` while the Run is live. The capability profile says `best-effort`: polling and process termination can miss intermediate states.
_Avoid_: Native Codex file event, exact delivery

**Stage-result interface**:
The shared runtime passes the Run Plan's root JSON Schema through streaming `outputSchema`; TanStack
projects it to native Codex `--output-schema`. Codex emits one terminal `structured-output.complete` event;
the executor, not this package, decodes that object with Effect before it changes coordination.
The runner preserves ordinary AG-UI events but never parses a stage result itself.
_Avoid_: Result footer, text-result parser

**Setup handoff**:
A missing Codex executable or host login is a non-retryable launch failure for one work item. The
message tells the operator to install Codex or run `codex login`; it does not stop the daemon or
change another harness. Process, provider, and network failures during a turn remain retryable.
Run `pnpm --filter @cogwork/codex-cli test:codex-live` only when an authenticated Codex CLI is
available. It is the opt-in compatibility probe for the pinned adapter and the implement schema.
_Avoid_: Daemon startup check, provider fallback

**Unattended runtime policy**:
The shared Sandbox Policy maps through TanStack's coarse Codex controls. Read-only Runs use Codex
`read-only`; full Runs use `workspace-write`, so native file changes stay in the prepared Worktree.
The descriptor also grants linked Worktrees their resolved shared Git metadata directory with
Codex `--add-dir`. Codex CLI owns
authentication through its host login; Cogwork's credential store is not consulted.
The local-process provider only starts Codex on the trusted Runtime Host; Codex's native Sandbox is
the worktree-confinement boundary.
_Avoid_: Local-process isolation, danger-full-access

**Native MCP projection**:
The descriptor declares native MCP projection and maps each resolved MCP server from the request
onto TanStack's documented Codex adapter passthrough: `config` carries `mcp_servers.<name>.url`
and, for an authenticated server, `bearer_token_env_var` naming a hashed `COGWORK_MCP_*` variable;
`env` carries the resolved bearer value into the Codex child environment only. Codex prepends
`Bearer ` itself. Command arguments carry names and URLs, never secret values. The adapter is
constructed per launch, so a rotated credential applies on the next Run. The shared runtime sends
required Instructions through Codex's in-memory system prompt and keeps the Harness Workspace
projection already satisfied, so neither channel writes into the prepared Worktree and its
repository-authored `AGENTS.md` remains unchanged.
_Avoid_: Codex MCP assembler, Codex authentication, projected instruction file, persistent credential file, package patch
