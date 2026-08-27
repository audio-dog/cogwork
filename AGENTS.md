<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## Effect TS

The Effect v4 repository is cloned to `.repos/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementations for Effect.
When Effect v4 behavior or types are unclear, don't guess from Effect v3 memory —
grep the real source in `.repos/effect` (e.g. `packages/effect/src`).
The repo also contains agent-specific rules and guidance to follow in various markdown files.
Before changing Effect code, read the applicable patterns in `docs/agent-patterns`; use each pattern's scope to select it.

You must always invoke the /effect-ts skill when writing Effect code.

## Drizzle

The Control store's schema lives in `packages/engine/src/control-store-schema.ts`, and `drizzle-kit`
runs from `packages/engine`. `drizzle-kit` ships its own agent skills, which
`pnpm dlx @tanstack/intent@latest list` surfaces under `drizzle-kit` — load them before touching a
Drizzle file. `pnpm --filter @cogwork/engine exec drizzle-kit skills` writes a local copy for editors
that read `.claude/skills`; those copies are ignored, not committed.

Pre-alpha, there are no migrations: the Control store is created from the schema and replaced when
the schema moves. After changing `control-store-schema.ts`, run
`pnpm --filter @cogwork/engine drizzle:schema` to regenerate the shipped create statements;
`pnpm --filter @cogwork/engine drizzle:check` reports when they have drifted. Then delete
`~/.cogwork/control.db` and let boot recreate it.

`drizzle-kit push` is deliberately not wired up. It reaches a schema by `ALTER TABLE`, so the store it
leaves behind carries different DDL text and column order than the create statements produce, and
boot's schema comparison — which is exact on purpose — refuses it. Deleting the store is the only
supported way forward. See ADR 0015 for when migrations come back.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to labels of the same name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` points to per-package `CONTEXT.md` files. See `docs/agents/domain.md`.

### Product

What cogwork is, who it is for, where it is, and where it is going — read it to answer a question
the code cannot answer, to judge whether work is in scope, or to check what the product refuses to
become. See `docs/agents/product.md`.

### Technical disposition

Decision shapes — a limit, a failure, a trust boundary, a name, how far to restructure, whether deterministic code or a model does the work — resolved from this project's own heuristics instead of blocked. Read it when answering a technical question in the maintainer's place. See `docs/agents/technical-disposition.md`.
