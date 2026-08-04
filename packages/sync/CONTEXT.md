# Sync (agent toolkit generator)

The single-source generator: it reads authored `assets/` and the `skills/sync/` bucket (plus
repo-root `repo-config/`) and renders them into each coding tool's native config — one canonical source,
edited once, written out per tool. This context shares no vocabulary with orchestration; there
are no runs or work sources here.

## Language

**Asset**:
Anything the generator loads and renders — rules, commands, subagents, toolkit servers, skills, and repo configs — bundled together and handed to every target.
_Avoid_: Resource, file

**Skill**:
A self-contained, portable capability with a `SKILL.md`, living in one of three buckets:
`skills/forge/<name>/` and `skills/sync/<name>/` here, or `packages/engine/skills/<name>/`
for the orchestration playbooks (authored there so they sit next to the `playbook.ts` that
names them). Only the `sync` bucket is copied as-is (no rendering) to tools that support
skills; overlaps across buckets are duplicate files so each audience can diverge.
_Avoid_: Command, subagent, plugin

**Command**:
A reusable slash-command / prompt template authored as a markdown asset (with frontmatter) under `assets/commands/`.
_Avoid_: Skill. Codex renders commands as "prompts" — that's the output name, not ours.

**Subagent**:
A specialized agent persona authored as a markdown asset under `assets/subagents/`, with its own tools and model tier. Rendered as an "agent" in each tool's output.
_Avoid_: Agent (that's the output name), skill, harness

**Toolkit server**:
One of the human's local tool servers, authored in `assets/toolkit-servers/servers.json` and rendered into each target's native MCP config (`.cursor/mcp.json`, Claude's `.mcp.json` / `~/.claude.json`, a Codex `config.toml` snippet). The rendered output keeps each tool's own `mcpServers` / `mcp_servers` key; only sync's internal name changed.
_Avoid_: MCP server (that name now belongs to orchestration's MCP skill — see `packages/contracts/CONTEXT.md`), MCP skill

**Target**:
A coding tool the generator renders for — `claude`, `cursor`, or `codex` — each a module that writes its own native files.
_Avoid_: Harness (that word belongs to orchestration), platform, tool (loosely)

**Mode**:
Whether a sync run writes user-level config (`global` — `~/.claude`, `~/.codex`, `~/.cursor`) or into a project (`project` — `.claude/`, `.cursor/`, root `AGENTS.md` / `CLAUDE.md`).
_Avoid_: Scope, environment

**Global rules / project rules**:
The two rule documents — `assets/rules/global.md` (personal, synced in global mode) and `assets/rules/project.md` (per-project, synced in project mode).
_Avoid_: Config, memory

**Model tier**:
A semantic model alias — `fast`, `default`, or `powerful` — resolved to each target's concrete model id at render time.
_Avoid_: Model name, size

**Repo config**:
Per-repo skill configuration under `repo-config/<owner>--<repo>/`, synced to `~/.agents/repo-config/`. How a specific repo tunes which skills apply.
_Avoid_: Workspace (that's orchestration), settings

**Writer**:
The file-writing abstraction that tracks create / update / unchanged / skip, supports dry runs, and refuses to write back into the repo.
_Avoid_: Generator (that's the whole tool), output
