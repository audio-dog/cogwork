# Codex CLI is an external harness with engine-assembled capabilities

> **Vocabulary note (2026-08-24).** This ADR predates the current domain language and uses retired terms. `MCP skill` is now **MCP server**; `playbook` is now **Operation Definition** plus **Operation Settings**; `playbook skill` is now **Operating Instructions**; `stage` is now **Operation**; `Run Manifest` is now **Run Plan**; and `capability` as an umbrella noun is retired outright — there is no collective term, so name the kind (MCP server, Skill, Subagent, Rules, Command, Hook). The decisions below stand; only the words changed. See `packages/contracts/CONTEXT.md`.

Cogwork needs a second subscription-backed coding path without taking ownership of OpenAI authentication. We register Codex as an external CLI **harness runner**, beside Cursor and the owned provider runner: Codex CLI owns `codex login`, its native agent loop, tools, and opaque conversation handle, while Cogwork owns stage selection, required instruction assembly, MCP-skill assembly, the worktree, run recording, and failure policy. Harness selection is explicit and has no fallback.

## Considered Options

- **Use the owned OpenAI provider adapter.** Kept for API-key users and the eventual first-party login experience, but rejected for this milestone because a ChatGPT subscription is authenticated by Codex CLI rather than Cogwork's credential store.
- **Reimplement OpenAI OAuth and the ChatGPT Codex transport.** Rejected because it makes Cogwork own tokens and an undocumented backend contract merely to recover a capability the installed CLI already provides.
- **Build a Codex app-server client like T3 Code.** Rejected for the first slice because its richer interactive protocol costs more integration work than unattended playbooks need.
- **Use TanStack AI's Codex adapter.** Chosen as the smallest runner behind the existing harness seam. The first integration pins the adapter version compatible with Cogwork's TanStack stack and guards its CLI protocol with a live compatibility probe.

## Consequences

The Codex runner declares an opaque-handle session and resumes the Codex conversation through that handle. A missing binary or CLI login is a non-retryable launch failure for the affected work item, not a daemon startup failure; transient turn failures remain retryable.

External does not mean ambient. Every runner receives the required global, repository, and playbook instruction layers from the context assembler, plus the provisioned playbook resource path. This amends ADR 0007's provider-only context boundary: harness-native discovery may add optional context, but it cannot be the source of a mandatory AFK playbook.

Codex enforces the external harness execution boundary because Cogwork cannot intercept its native shell and file tools. Unattended runs use `approvalPolicy: never`, `workspace-write`, and network access inside the run worktree, never `danger-full-access` by default. MCP skills remain engine-assembled; the runner renders endpoints into Codex configuration and passes bearer values only through the child environment, never through a worktree file or command argument.
