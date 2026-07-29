# CONTEXT

Shared vocabulary for this repo, so docs and skills stay consistent.

## Orchestration

**Work control plane**:
The system that decides when eligible work should advance, selects its workflow, coordinates agent execution, and verifies outcomes. It does not own the user's authoritative backlog.
_Avoid_: Agent runner, autonomous work manager

**Work source**:
A user-provided external system that is authoritative for backlog intent, priority, human-visible work status, and the control plane's coordination markers (claims, attempt records). The daemon keys off tickets; any machine can reconstruct the control plane's view from the work source alone.
_Avoid_: Control-plane database, internal backlog

**Run ledger**:
The control plane's disposable local cache of operational details that the work source doesn't carry — session handles, progress counters, budgets. Losing it is safe by design; it is rebuilt by reconciling against the work source.
_Avoid_: Source of truth, backlog

**Engine**:
The work control plane packaged as an embeddable library. It has no process identity of its own.
_Avoid_: Daemon, app

**Daemon**:
The long-lived host process that runs the engine on one machine.
_Avoid_: Engine, orchestrator app

**Client**:
Anything that talks to a running daemon — the CLI, a future GUI, or another application. Clients never embed the engine directly.
_Avoid_: Frontend

**Harness**:
A coding agent (Cursor, Claude Code, Codex, …) the control plane drives as a long-lived session to perform work in a checkout. A harness bundles its own model access and tools; swapping harnesses swaps the whole worker.
_Avoid_: Model, provider, target (that word belongs to the sync generator)

**Workspace**:
A repo registered with the daemon: a checkout path bound to a work source, harness preferences, and playbook config. The unit of isolation and per-repo configuration inside the single daemon.
_Avoid_: Project; not pnpm's or TanStack's "workspace"

**Playbook**:
A workspace's binding of one lifecycle stage (triage, implement, follow-up, verify) to a prompt template, skill, and harness/model choice. Stages can be disabled per workspace.
_Avoid_: Workflow, pipeline

**Plugin**:
Repo-specific behavior supplied to the engine from outside it, as an implementation of a typed extension port provided by workspace config (e.g. audiodog's CloudWatch verifier). The engine never contains repo-specific code.
_Avoid_: Extension, integration

## Agent toolkit

- **Skill** — a self-contained capability in `skills/<category>/<name>/SKILL.md`, distributed
  as-is via the `skills` CLI. Portable across agents with no generation step.
- **Asset** — a non-skill thing that differs per tool: rules/memory, commands, subagents, MCP
  config. Authored once in `packages/sync/assets/`, rendered per tool by the generator.
- **Global rules** vs **project rules** — `packages/sync/assets/rules/global.md` is personal
  user-level rules synced in `--global` mode; `packages/sync/assets/rules/project.md` is
  per-project rules synced in `--project` mode.
- **Canonical source** — `packages/sync/assets/`. The one place an asset is edited.
- **Target** — a coding agent we generate for: `claude`, `cursor`, `codex`. One module each in
  `packages/sync/src/targets/`.
- **Generator / sync** — the `pnpm sync` CLI (`packages/sync/src/cli.ts`) that reads
  `packages/sync/assets/` and writes each target's native files.
- **Mode** — `--global` (writes to `~/.claude`, `~/.codex`, `~/.cursor`) vs `--project` (writes
  into a project directory: `.claude/`, `.cursor/`, root `AGENTS.md`/`CLAUDE.md`).
