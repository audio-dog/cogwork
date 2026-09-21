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

**Managed Codex catalog**:
The checked-in Codex model list. Every model declares the native `effort` choices and its default,
and the catalog records the Codex CLI version it was generated against. Catalog reads are pure data
reads; only readiness starts Codex. Run dispatch projects the selected effort, or its descriptor
default, onto Codex's native reasoning-effort field.
_Avoid_: Runtime model probe, adapter model list

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
Every Run uses Codex `workspace-write`, so native file changes stay in the prepared Worktree.
A registered Workspace's ambient Codex Hooks are trusted for the Run. The grant is invocation-wide,
so the operator's enabled Codex Hooks run too; see ADR 0023.
Codex's `read-only` mode denies the network as well as the disk, and the switch that reopens it
(`sandbox_workspace_write.network_access`) is read only under `workspace-write`; a permission
profile would separate the two, but `codex exec` refuses one beside the `--sandbox` argument the
adapter always sends. A read-only Run therefore keeps the Issue tracker its triage Operation reads
and loses its native write ban, which is why this Harness reports `policyFidelity: "none"`. The
Operation's own instructions carry the ban instead. Claude Code denies the write tools by name, so
the inequality is Codex's alone.
The descriptor also grants linked Worktrees the Git paths their own commits need — their Worktree
entry plus the common directory's `objects`, `refs`, `logs`, and its packed-ref files — with Codex `--add-dir`. The common
directory itself stays ungranted, and neither a read-only Run nor a checkout that owns its Git
directory is granted anything, so a Run cannot reach `config`, `hooks`, or a sibling Worktree.
Codex CLI owns authentication through its host login; Cogwork's credential store is not consulted.
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
