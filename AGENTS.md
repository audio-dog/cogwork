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

## Linear API

Always use `@linear/sdk`'s typed `LinearClient` methods to talk to Linear — never hand-build a
GraphQL document or hit `api.linear.app` with a raw `fetch`. The one accepted exception is documented
in `packages/engine/src/linear/client.ts` (`rawRequest`, used for reads where the SDK's lazy nested
fetching would cost extra round trips); anything else needing the SDK for the first time should use
its typed methods (e.g. `client.viewer`, `client.organization`), not a raw request. The Linear OAuth
token endpoint (`/oauth/token`) has no SDK equivalent and is the one legitimate raw-HTTP case outside
`client.ts` — see `packages/engine/src/linear/oauth.ts`.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to labels of the same name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` points to per-package `CONTEXT.md` files. See `docs/agents/domain.md`.

