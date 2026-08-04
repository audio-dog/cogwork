# packages/sync/skills/

Authored skills for Clanker Forge, split into three buckets so each audience can
diverge over time. Overlaps are **duplicate files on purpose** — edit the copy in
the bucket whose behavior you want to change.

| Bucket | Path | Who uses it |
|---|---|---|
| **forge** | `forge/<name>/` | Agents and humans writing Clanker Forge itself |
| **engine** | [`packages/engine/skills/<name>/`](../../engine/skills/) | The orchestration daemon (headless playbooks) |
| **sync** | `sync/<name>/` | The sync generator — copied into each tool's global skill store |

The **engine** bucket lives in `packages/engine/`, next to the playbooks (`playbook.ts`)
that name its skills by string, rather than here — everything else authored for this
generator's own buckets stays under this directory.

Only **sync** is wired to anything today: it is the bucket `pnpm sync` and `pnpm link-skills`
distribute, and it currently holds a copy of every skill. So the forge and engine
audiences still reach their skills through the global store. **forge** and **engine**
exist as authoring homes so each audience can diverge without disturbing what ships.

A bucket is not a dependency closure. A skill that invokes another by name (the engine
playbooks reach for `git-master`, `code-review`, `tdd`, …) resolves it from the agent's
global skill store, wherever it was authored — some of those aren't authored in this repo
at all. Only duplicate a skill into a bucket when you want that bucket's copy to diverge.

Third-party / consumer installs (e.g. `effect-ts`) stay under repo-root
`.agents/skills/` and are not authored here.

## Syncing

`pnpm sync` (from `@clanker-forge/sync`) copies every skill in the **sync** bucket
into each tool's global skill store:

- **Cursor** → `~/.agents/skills/<name>/` (`--global` only)
- **Claude Code** → `~/.claude/skills/<name>/`, or `.claude/skills/<name>/` under `--project`
- **Codex** → skipped (no skills concept)

Preview with `pnpm sync --dry-run`, or scope to one tool with `pnpm sync --target cursor`.

## Local development

`pnpm link-skills` (→ `packages/sync/bin/link-skills.sh`) symlinks the **sync** bucket into
`~/.claude/skills` so you can test changes against local Claude Code without a full
sync. Prefer `pnpm sync` when you want a plain copy into every tool (including
Cursor's `~/.agents/skills`).

## Authoring a skill

Every `SKILL.md` starts with YAML frontmatter:

```markdown
---
name: my-skill
description: One sentence covering WHAT it does and WHEN to use it — this is what the agent matches against to decide whether to trigger.
---

# my-skill

The instructions the agent follows when the skill is invoked...
```

Conventions:

- **`name`** — kebab-case, matches the directory name.
- **`description`** — pack it with trigger phrases ("use when…", "open a PR", etc.).
  The agent only sees the description until the skill fires, so vague descriptions
  don't trigger.
- Keep skills **small and composable**. One job per skill.
- Reference supporting files by relative path; ship them in the skill's directory.
- Put the skill in the bucket(s) that should own it; copy into another bucket when
  the same capability needs to ship to more than one audience.

## Forked engineering skills

`code-review`, `domain-modeling`, `improve-codebase-architecture`, `to-spec`,
`to-tickets`, `triage`, and `wayfinder` are minimal-diff forks of
[mattpocock/skills](https://github.com/mattpocock/skills); `setup-repo-config`
forks its `setup-matt-pocock-skills`. They are duplicated into **forge** and **sync**.
The only intended divergence today is **repo config resolution**: per-repo config
resolves from `~/.agents/repo-config/<slug>/` before the repo's committed
`docs/agents/` (see [repo-config/README.md](../../../repo-config/README.md)). To pull
upstream updates, re-copy the skill into each bucket that holds it and re-apply the
resolution block.
