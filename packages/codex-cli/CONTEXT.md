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
_Avoid_: Sandbox isolation (the local-process provider scopes the worktree but is not a container)

**Harness Workspace channel**:
Instructions and MCP servers arrive only through the shared Harness Workspace. TanStack resolves
live SecretRefs into Codex's transient native config; the descriptor removes that secret-bearing
file at every terminal outcome. Cogwork does not generate Codex MCP identities, config keys, or
bearer environment names.
_Avoid_: Codex MCP assembler, Codex authentication, persistent credential file
