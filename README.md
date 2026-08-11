# clanker-forge

Orchestration control plane for AI coding agents — discover work from an issue tracker,
schedule runs under concurrency and budget limits, and drive harnesses (Cursor ACP today;
first-party runners next).

## Packages

| Package | Role |
|---|---|
| **contracts** (`packages/contracts`) | Shared schemas and vocabulary (`WorkItem`, `Run`, `Claim`, harness terms) |
| **engine** (`packages/engine`) | Daemon, reconcile, scheduler, executor, worktrees, tracker/provider adapters |
| **cli** (`apps/cli`) | `clanker-forge` client and headless daemon host |
| **cursor-acp** (`packages/cursor-acp`) | Cursor harness adapter over ACP |

Playbook skills for headless stages live in `packages/engine/skills/`.

Start with [`CONTEXT-MAP.md`](./CONTEXT-MAP.md) for how the pieces connect, then the
per-package `CONTEXT.md`.

## Setup

```bash
pnpm install
pnpm vendor   # shallow-clone Effect v4 into .repos/effect for agent/human reference
pnpm typecheck
pnpm test
```

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

## Agent toolkit (moved)

The single-source generator that syncs rules, commands, subagents, and MCP config across
Claude Code, Cursor, and Codex used to live here as `packages/sync`. It now lives in
[taylorfsteele/sync](https://github.com/taylorfsteele/sync).
