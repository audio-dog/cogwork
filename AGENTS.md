<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## Coding standards

`CODING_STANDARDS.md` holds the code rules that `biome check` cannot test: suppressions, comments,
control flow, TypeScript, time, and React composition. Read it before you write code. Each rule in it
blocks a change.

## Tests

`docs/agent-patterns/test-value.md` is the bar a test must meet to earn its place. Read it before you
add, change, review, or delete a test.

## Bug review

Every review of a diff in this repo includes a bug-hunter, and an implement Run's review round adds
it to its reviewers. Dispatch a read-only reviewer with a clean context. Its brief is
`docs/agents/bug-hunt.md`, and it also gets the diff and the work item.

In the fix round, prove each blocking bug-hunter finding before you fix it. Write the test that its
sketch describes, and run it on the reviewed code:

- **It fails on its assertion.** The bug is real. Fix it, and record the red proof as a Mutation
  whose named break is the finding: `Mutation: B1 unfixed`.
- **It passes.** The finding is refuted. Delete the test, and give the finding *won't-fix* with the
  passing run as the reason.
- **No test can express the bug.** Decide at your judgment, and record the call.

## Effect TS

The Effect v4 repository is cloned to `.repos/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementations for Effect.
When Effect v4 behavior or types are unclear, don't guess from Effect v3 memory —
grep the real source in `.repos/effect` (e.g. `packages/effect/src`).
The repo also contains agent-specific rules and guidance to follow in various markdown files.
Before changing Effect code, read the applicable patterns in `docs/agent-patterns/`; the triggers:

- `effect-control-flow.md` — branching on a success value or an expected typed failure; decode-error boundaries.
- `effect-time-bounds.md` — an Effect crosses an external boundary (subprocess, HTTP, harness stream): deadlines and retry policy.
- `effect-fiber-lifecycle.md` — work on another fiber: forking, supervision, fiber registries, runtime re-entry.
- `effect-test-layers.md` — writing or restructuring `@effect/vitest` tests: doubles, layers, probes, TestClock.
- `effect-schema-unions.md` — a domain type with variants, a branded id, or decoding at a boundary.
- `effect-service-layers.md` — defining a service or its layer, adding a dependency, composing the layer graph, or placing an `Effect.provide`.
- `effect-error-design.md` — defining a new error type or adding a failure kind: `Schema.TaggedError` vs `Data.TaggedError`, `reason` and `retryable` fields.
- `effect-observability.md` — logs, span attributes, metrics, telemetry wiring.
- `effect-process-edges.md` — a process starts, a non-Effect host calls in, or a socket, subprocess, or emitter enters Effect.

You must always invoke the /effect-ts skill when writing Effect code.

## Drizzle

The Control store's schema lives in `packages/engine/src/control-store-schema.ts`, and `drizzle-kit`
runs from `packages/engine`. `drizzle-kit` ships its own agent skills, which
`pnpm dlx @tanstack/intent@latest list` surfaces under `drizzle-kit` — load them before touching a
Drizzle file. `pnpm --filter @cogwork/engine exec drizzle-kit skills` writes a local copy for editors
that read `.claude/skills`; those copies are ignored, not committed.

Boot converges the live Control store to `control-store-schema.ts` with drizzle-kit's in-process
SQLite differ, applies the statements through the engine's `SqlClient`, and verifies convergence with
an empty second diff. After changing the schema, restart the daemon; do not run `drizzle-kit push` or
delete `~/.cogwork/control.db`. Rename-shaped diffs are the pre-alpha exception: boot moves the store
to a timestamped backup and creates a new one. See `docs/adr/0015-one-control-store-with-engine-owned-migrations.md`.

## TanStack AI

The Harnesses and the engine's own runtime run on TanStack AI: `@tanstack/ai` for `chat()`, tools,
subagents, and middleware, and `@tanstack/ai-sandbox` for the Workspace definition that every external
Harness adapter projects. Before you change a Harness descriptor, the external Harness runtime, the
provider runner, or any code that imports `@tanstack/ai*`, load these skills:

- `pnpm dlx @tanstack/intent@latest load @tanstack/ai#ai-core`, plus the sub-skill for the area, such
  as `ai-core/tool-calling` or `ai-core/middleware`.
- `pnpm dlx @tanstack/intent@latest load @tanstack/ai-sandbox#ai-sandbox` for Workspace definitions,
  projection, and sandboxes.
- `pnpm dlx @tanstack/intent@latest load @tanstack/ai-skills#ai-skills` for Skill catalogs and
  `withSkills`.

`.agents/skills/tanstack-ai` is TanStack's map of its packages. Use it to find the package that owns
a capability. The installed packages' own skills match the installed code, so they win over the docs
site when the two disagree.

## Never start the dev server

Do not run `pnpm dev`, `turbo dev`, `electron-vite dev`, or any package's `dev` script. Not to check
a change, not to grab a screenshot, not just this once. The human running the session starts it. You
attach to what is already there.

A second dev server does not give you a second app — it damages the first. The desktop main process
takes a single-instance lock (`apps/desktop/src/main/index.ts`), so a second Electron process quits
the moment it starts and only refocuses the window someone else was using. Any debug port it opened
dies with it, and its Vite server has already claimed a different port. The result is that you
believe you started something, you are attached to nothing, and you stole focus from a person.

- **The app is running** — attach and verify. See `apps/desktop/AGENTS.md`.
- **The app is not running** — say so, ask the human to start it, and wait.
- **No human is in the session** — an autonomous triage, implement or follow-up Run has no app and
  will not get one. Verify through tests, typecheck, build and the code itself, and report the UI as
  unverified. Never start a server to close that gap.

This covers every dev server in the workspace, not only the desktop app.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to labels of the same name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `GLOSSARY-MAP.md` points to per-package `GLOSSARY.md` files. A large glossary is
an index with `GLOSSARY-<group>.md` parts. See `docs/agents/domain.md`.

### Product

What cogwork is, who it is for, where it is, and where it is going — read it to answer a question
the code cannot answer, to judge whether work is in scope, or to check what the product refuses to
become. See `docs/agents/product.md`.

### Technical disposition

Decision shapes — a limit, a failure, a trust boundary, a name, how far to restructure, whether deterministic code or a model does the work — resolved from this project's own heuristics instead of blocked. Read it when answering a technical question in the maintainer's place, and when proposing a fix or design — an ADR, a ticket's brief or acceptance criteria, a plan. See `docs/agents/technical-disposition.md`.
