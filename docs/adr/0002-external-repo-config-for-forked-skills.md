# 0002 — External per-repo config for forked engineering skills

- **Status:** accepted (historical — the sync toolkit that owned this config moved out of cogwork; see [#171](https://github.com/taylorfsteele/cogwork/issues/171))
- **Date:** 2026-07-22

## Context

The [mattpocock/skills](https://github.com/mattpocock/skills) engineering workflow
(`triage`, `to-tickets`, `to-spec`, `wayfinder`, `code-review`, `domain-modeling`) assumes
per-repo config **committed to the target repo**: `docs/agents/{issue-tracker,triage-labels,domain}.md`,
an `## Agent skills` block in `AGENTS.md`/`CLAUDE.md`, and lazily created `CONTEXT.md`/ADR files.

That was rejected in work repos with their own doc conventions
(colony PR [#26924](https://github.com/colonylabs/colony/pull/26924) — conflicted with the
repo's SpecKit/ADR tooling and coworkers didn't want the files). Alternatives considered:

- **Untracked files via `.git/info/exclude`** — no skill changes, but linked worktrees only
  check out tracked files, so the config silently vanishes per-worktree; easy to leak into a commit.
- **A global rule redirecting the lookup** — no forks, but non-deterministic; upstream skills
  still name the in-repo paths.

## Decision

Fork the consumer skills into `skills/` and keep per-repo config under
`repo-config/<owner>--<repo>/`, resolved at `~/.agents/repo-config/` (symlinked by
`pnpm link`, copied by `pnpm sync --global`). Because cogwork is public and the config
can reference employer-internal details, `repo-config/` contents are git-ignored (only its
README is committed) — the directory is machine-local. Each fork carries a short **repo config
resolution** rule: external home first, then the repo's committed `docs/agents/` — so repos
that do commit config still work. The slug comes from `git remote get-url origin`, making
resolution worktree- and clone-proof.

`setup-matt-pocock-skills` is forked as `setup-repo-config`: same interview, but it writes
only to the external home and never touches the target repo (no `AGENTS.md` block, no
`docs/agents/`). A repo's `domain.md` can relocate skill-written `CONTEXT.md`/ADRs to
`repo-config/<slug>/domain/`, keeping domain modeling usable in repos that forbid
skill-generated files.

Forks keep upstream names so a `pnpm sync` overwrites the upstream-installed copies in each
tool's skill store. Diffs against upstream are kept minimal (a resolution block plus renamed
setup references) so upstream updates can be re-applied by copy + re-patch.

## Consequences

- The colony workflow works with zero files committed to colony; config lives in the
  git-ignored `repo-config/` directory (machine-local, not versioned — private backup is on the user).
- Forked skills drift from upstream until manually re-synced; the minimal-diff rule bounds the cost.
- Skills installed straight from upstream (unforked ones like `tdd`, `diagnosing-bugs`) still
  read only in-repo docs and won't see the external config; they degrade gracefully (proceed-silently).
