# Context Map

Clanker-forge has two languages that don't overlap. The **orchestration** language of the control
plane — how work gets discovered, scheduled, and run by coding agents — and the **sync** language of
the asset generator — how skills, rules, and agent config get rendered for each tool.

Read this map first for how the pieces connect, then the per-context `CONTEXT.md` for the area you're
working in. `packages/contracts/CONTEXT.md` is the shared kernel; read it alongside any orchestration
context.

## Contexts

### Orchestration (the control plane)

- [contracts](./packages/contracts/CONTEXT.md) — shared kernel: the schemas and vocabulary every other orchestration context speaks (`WorkItem`, `Run`, `Claim`, harness terms, lifecycle stages).
- [engine](./packages/engine/CONTEXT.md) — the runtime machinery: daemon, reconcile, scheduler, executor, harness dispatch, worktrees, and the issue-tracker and source-control-provider adapters.
- [cli](./apps/cli/CONTEXT.md) — `clanker-forge`, the client and daemon host: subcommands, RPC transport, workspace loading, live watch.
- [cursor-acp](./packages/cursor-acp/CONTEXT.md) — the Cursor harness adapter: bridges the engine's harness contract to the Cursor agent over ACP.

### Sync (the agent toolkit)

- [sync](./packages/sync/CONTEXT.md) — the single-source generator: renders `packages/sync/assets/` and the `packages/sync/skills/sync/` bucket into each tool's native config. Shares no vocabulary with orchestration.

## Relationships

### Orchestration runtime flow

The **daemon** (hosted by the `cli`) runs two heartbeats over every registered **workspace**:

1. **Reconcile.** The reconcile worker polls each workspace's **issue tracker** (GitHub Issues or Linear) and attaches any configured **source control provider**'s PR state, then `classify` partitions the observed items into **eligible**, **claimed**, **blocked** (open dependencies), and **needs-human** (triage parked it), each tagged with a **lifecycle stage**. The result is held in an in-memory snapshot.
2. **Execute.** The **scheduler** picks eligible **candidates** from that snapshot under its concurrency limits and daily budget, and forks one **executor** per candidate.

Each executor run then:

- **claims** the work item on the issue tracker (a label plus a coordination marker),
- opens a git **worktree** for the branch,
- resolves the stage's **playbook** into a prompt + harness + model,
- sends a **harness request** to the **harness service**, which routes to the registered **harness runner** by name,
- streams **harness events** back, appending them to the **run ledger** and publishing **run activity** on the event bus,
- records the **attempt** outcome and updates roles and coordination on the issue tracker (PR state is read from the source control provider, never written back).

### Cross-context edges

- **engine → contracts.** Every engine service consumes and produces contracts schemas. Contracts owns the nouns; engine owns the verbs.
- **cli → engine.** The `daemon` command composes the engine's layers into a running server. `status` / `runs` / `watch` talk to it over the RPC group. `worktree` embeds the engine's worktree manager directly, with no RPC.
- **cursor-acp → engine.** `cursorRunner` implements the engine's harness runner interface. The engine knows nothing about ACP or Cursor; cursor-acp knows nothing about scheduling.
- **engine ↔ issue tracker.** Claims, attempts, and other coordination markers live in one coordination comment on the issue tracker, so any daemon can rebuild its coordination view from the tracker alone. Human-facing triage proposals are separate comments (one per round) so the thread stays conversational. The "ledger" marker anchoring the coordination comment is not the run ledger — see contracts.
- **engine ↔ source control provider.** A separate, read-only port that resolves a work item's pull request by its **link key** (the `ticketSlug(item.id)` branch prefix) and reports the PR's checks, reviews, mergeable state, and human comments. It never writes: coordination stays on the issue tracker, PR writes stay with the agent. A GitHub issue tracker is its own provider by default; a Linear tracker pairs with a GitHub provider via an explicit `sourceControl` config block. This is what lets a Linear-tracked, GitHub-hosted repo get follow-up on its PRs (see engine ADR 0004).

### Sync stands alone

The `sync` context reads `packages/sync/assets/`, the `packages/sync/skills/sync/` bucket, and
repo-root `repo-config/`, and writes each **target's** native files. Its only tie to orchestration is
indirect: the skills and rules it distributes are what the orchestration harnesses eventually run.

Every authored skill lives in one of three buckets: `packages/sync/skills/forge/` (writing this
repo), `packages/engine/skills/` (the daemon's headless playbooks, colocated with the `playbook.ts`
that names them), and `packages/sync/skills/sync/` (what the generator distributes). Only `sync/`
is read by the generator — the other two are authoring homes so each audience can diverge later,
and today their skills reach their audience through the copy in `sync/`.
