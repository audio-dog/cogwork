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

**Unattended runtime policy**:
Every playbook uses `approvalPolicy: never`, `workspace-write`, and worktree network access. The
runner never selects `danger-full-access`. Codex CLI owns authentication through its host login;
Cogwork's credential store is not consulted.
_Avoid_: Sandbox isolation (the local-process provider scopes the worktree but is not a container)

**MCP child environment**:
Resolved MCP URLs are passed as Codex config overrides. Bearer values are named by
`bearer_token_env_var` and exist only in the child environment, never in the worktree or command
argument.
_Avoid_: Codex authentication, credential file
