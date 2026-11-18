# cogwork

cogwork is a productivity assistant for software engineers. Its first capability is coding
orchestration: it finds work, classifies and schedules it, runs agent workflows, records the
results, and brings completed changes to a pull request for human review.

The project is pre-release, local, and single-user today.

## Runtime

- The Electron desktop app is mission control and the primary daemon host on a laptop. It shows
  work and live runs while the engine operates in the background.
- The engine reconciles issue trackers, schedules work within concurrency and budget limits,
  prepares worktrees, and records each run.
- The owned provider runner uses TanStack AI to run the model loop against configured model
  providers.
- The shared external-harness runtime drives Claude Code and Codex today, with a fail-closed Cursor
  ACP adapter on the same seam.

## Packages

| Package | Role |
|---|---|
| [**contracts**](./packages/contracts/GLOSSARY.md) | Shared schemas and orchestration vocabulary |
| [**engine**](./packages/engine/GLOSSARY.md) | Daemon, scheduler, executor, owned runner, worktrees, and service adapters |
| [**cli**](./apps/cli/GLOSSARY.md) | `cogwork` client and headless daemon host |
| [**desktop**](./apps/desktop/GLOSSARY.md) | Electron mission-control app and primary laptop daemon host |
| [**claude-code**](./packages/claude-code/GLOSSARY.md) | Claude Code harness adapter |
| [**codex-cli**](./packages/codex-cli/GLOSSARY.md) | Codex CLI harness adapter |
| [**cursor-acp**](./packages/cursor-acp/GLOSSARY.md) | Cursor harness adapter over ACP |

Start with the [Context Map](./GLOSSARY-MAP.md) for how the major contexts connect. Detailed product
direction lives in [Product](./docs/agents/product.md), and operation playbooks live in
[`packages/engine/operating-instructions`](./packages/engine/operating-instructions/).

## Setup

From the repository root:

```bash
pnpm install
pnpm vendor effect
pnpm typecheck
pnpm build
pnpm test
pnpm format-and-lint
```

`pnpm vendor effect` hydrates `.repos/effect` with the Effect source version installed by this
workspace. The ignored reference checkout lets agents and people inspect the exact API locally.
Re-running the command is safe: it does nothing when the checkout already matches and refreshes it
when the dependency changes.
