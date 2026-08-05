# clanker-forge

My personal toolkit for working with AI coding agents — skills, commands, subagents, rules,
and MCP config, built to be portable across tools.
(Claude Code, Cursor, Codex).

## Two kinds of things live here

| | What | How it ships |
|---|---|---|
| **Skills** (`packages/sync/skills/forge,sync/`, `packages/engine/skills/`) | Self-contained capabilities in `SKILL.md` format, in three buckets (`forge`, `engine`, `sync`) | The **sync** bucket is copied as-is into each tool's global skill store by `pnpm sync` |
| **Assets** (`packages/sync/assets/`) | Rules, commands, subagents, MCP config | Authored once, then **generated** into each tool's native format/location by `pnpm sync` |
| **Repo config** (`repo-config/`, git-ignored) | Per-repo config for the forked engineering skills (issue tracker, triage labels, domain docs) | Copied to the shared `~/.agents/repo-config/` home by `pnpm sync --global` (or symlinked by `pnpm link-skills`) — see [repo-config/README.md](repo-config/README.md) |

Third-party skills used only in this repo (e.g. Effect) live under `.agents/skills/` as consumer
installs — they are not authored or synced from this package.

## Syncing assets across tools

```bash
pnpm install

# Preview what would change, for every tool
pnpm sync --dry-run --target all

# Write Claude Code config into ~/.claude
pnpm sync --target claude --global

# Write project-scoped config (AGENTS.md, .cursor/rules, .mcp.json) into a repo
pnpm sync --target cursor --project /path/to/project

# Symlink the sync-bucket skills into ~/.claude/skills for local development
pnpm link-skills
```

`--global` (default) writes to `~/.claude`, `~/.codex`, `~/.cursor`. `--project [DIR]` writes
into a project directory (default: cwd). Run `pnpm sync --help` for all flags.

### What gets generated where

| Asset | Source | Claude Code | Cursor | Codex |
|---|---|---|---|---|
| Global rules (`--global`) | `packages/sync/assets/rules/global.md` | `~/.claude/CLAUDE.md` | UI-only (paste manually) | `~/.codex/AGENTS.md` |
| Project rules (`--project`) | `packages/sync/assets/rules/project.md` | `CLAUDE.md` | `AGENTS.md` + `.cursor/rules/main.mdc` | `AGENTS.md` |
| Slash commands | `packages/sync/assets/commands/*.md` | `.claude/commands/*.md` | `.cursor/commands/*.md` | `~/.codex/prompts/*.md` |
| Subagents | `packages/sync/assets/subagents/*.md` | `.claude/agents/*.md` | `.cursor/agents/*.md` | `.codex/agents/*.toml` |
| Skills | `packages/sync/skills/sync/<name>/` | `~/.claude/skills/<name>/`, or `.claude/skills/<name>/` with `--project` | `~/.agents/skills/<name>/` (`--global` only) | skipped |
| Toolkit servers | `packages/sync/assets/toolkit-servers/servers.json` | `mcpServers` (`.mcp.json` / `~/.claude.json`) | `.cursor/mcp.json` | `~/.codex/clanker-forge.mcp.toml` snippet |
| Per-repo skill config (`--global`) | `repo-config/<slug>/` | `~/.agents/repo-config/<slug>/` — one shared home, all tools | ← same | ← same |

> Tool conventions change often. Each target lives in `packages/sync/src/targets/<tool>.ts` — that's the one
> place to update when a tool moves its files.

### Model selection (per tool)

Commands and subagents pick a **semantic tier** in frontmatter instead of a tool-specific
model name, since each tool names models differently (Claude: `haiku`/`sonnet`/`opus`; Cursor:
`fast`/`inherit`/model-ID; Codex: `gpt-…` IDs):

```yaml
model: fast   # or: default | powerful
```

Each tier resolves to the right per-tool model in `packages/sync/src/lib/models.ts` (`TIER_MODELS`) — the one
place to edit when a tool renames its models. Any value that isn't a tier (e.g. `inherit` or a
concrete model ID) is passed through unchanged, and a tier that maps to nothing emits no `model`
key (the tool uses its own default).

| Tier | Claude | Cursor | Codex |
|---|---|---|---|
| `fast` | `haiku` | `fast` | `gpt-5.4-mini` |
| `default` | `sonnet` | `inherit` | `gpt-5.4` |
| `powerful` | `opus` | `inherit` | `gpt-5.4` |

## Layout

clanker-forge is a pnpm monorepo. Authored skills and the sync generator live together under
`packages/sync/`. Per-repo skill config stays at the repo root.

```
packages/sync/          TypeScript generator behind `pnpm sync`/`pnpm check` (src/cli.ts, src/check.ts, targets/, lib/)
packages/sync/assets/   Canonical source for rules, commands, subagents, MCP config
packages/sync/skills/   Authored skills — forge and sync buckets (see its README)
packages/engine/skills/ Authored skills — the engine bucket (headless playbooks), next to playbook.ts
packages/sync/bin/      link-skills.sh (symlink sync-bucket skills + repo-config for local dev)
repo-config/            Per-repo config for the forked engineering skills (see repo-config/README.md)
.agents/skills/         Consumer installs used in this repo (e.g. effect-ts), not authored here
.repos/                 Vendored reference source (git-ignored), pinned by `pnpm vendor`
```

`pnpm sync`, `pnpm check`, and `pnpm link-skills` run via `@clanker-forge/sync`.

## Vendored reference source

The Effect v4 API is beta and shifts release-to-release, so the exact source we depend on is
vendored locally for agents (and humans) to read:

```bash
pnpm vendor
```

This shallow-clones the Effect monorepo into `.repos/effect`, pinned to the **exact installed**
`effect` version (read from `packages/engine`, currently `4.0.0-beta.102` via the `effect` catalog),
so the reference can never drift from the dependency. `.repos/` is git-ignored, and re-running is
idempotent — it no-ops when `.repos/effect` already matches the installed version and re-clones when
the version changes.

## Contributing

1. Add a skill under `packages/sync/skills/<bucket>/<name>/SKILL.md` (`forge` or `sync`;
   `engine` lives at `packages/engine/skills/<name>/SKILL.md` — see
   [packages/sync/skills/README.md](packages/sync/skills/README.md)), or an asset under
   `packages/sync/assets/`.
2. Run `pnpm check` — validates the frontmatter of every skill, command, and subagent.
3. Open a PR.
