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

You must always invoke the /effect-ts skill when writing Effect code.


