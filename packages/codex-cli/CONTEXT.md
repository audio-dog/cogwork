# Codex CLI (harness adapter)

The Codex-specific [harness runner](../engine/CONTEXT.md): it implements the engine's harness
contract through the installed, already-authenticated Codex CLI using TanStack AI's Codex adapter.
The engine knows nothing about Codex; this package knows nothing about scheduling.

Role in the flow: the engine hands `codexRunner` a harness request; the runner assembles mandatory
context, starts Codex in the run worktree, and returns the native AG-UI event stream.

## Language

**codexRunner**:
The factory that produces the Codex harness runner. It declares an opaque session, resumes through
Codex's thread handle, injects context-assembler layers and the provisioned playbook resource path,
and maps stream cancellation onto the child process.
_Avoid_: Provider runner, OpenAI runner

**Stage-result interface**:
The runner resolves the lifecycle stage to the engine-owned root JSON Schema and passes it to the
native Codex `--output-schema` flag. Codex emits one terminal `structured-output.complete` event;
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
Every playbook uses `approvalPolicy: never`, `workspace-write`, and worktree network access. The
runner grants linked worktrees their shared Git metadata directory with Codex `--add-dir`, so Git
commits remain possible without `danger-full-access`. Codex CLI owns authentication through its host login;
Cogwork's credential store is not consulted.
_Avoid_: Sandbox isolation (the local-process provider scopes the worktree but is not a container)

**MCP child environment**:
Resolved MCP URLs are passed as Codex config overrides. Bearer values are named by
`bearer_token_env_var` and exist only in the child environment, never in the worktree or command
argument.
_Avoid_: Codex authentication, credential file
