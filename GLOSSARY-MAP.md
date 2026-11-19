# Context Map

cogwork is the **orchestration** control plane — how work gets discovered, scheduled,
and run by coding agents.

Read this map first for how the pieces connect, then the per-context `GLOSSARY.md` for the area you're
working in. `packages/contracts/GLOSSARY.md` is the shared kernel; read it alongside any orchestration
context.

The agent toolkit generator (rules / skills / MCP config sync across Claude Code, Cursor, and Codex)
lives in a separate safekeep repo: [taylorfsteele/sync](https://github.com/taylorfsteele/sync).

## Contexts

### Orchestration (the control plane)

- [contracts](./packages/contracts/GLOSSARY.md) — shared kernel: the schemas and vocabulary every other orchestration context speaks (`WorkItem`, `Run`, `Claim`, harness terms, Workflows).
- [engine](./packages/engine/GLOSSARY.md) — the runtime machinery: daemon, reconcile, scheduler, executor, harness dispatch, worktrees, and the issue-tracker and source-control-provider adapters. It also owns the terms only it speaks, such as **Trigger event**, **Credential store**, and **Harness request**.
- [cli](./apps/cli/GLOSSARY.md) — `cogwork`, the client and headless daemon host: subcommands, RPC transport, workspace loading, live watch. On a laptop the desktop app is the primary daemon host (see product ADR 0008).
- [desktop](./apps/desktop/GLOSSARY.md) — the Electron mission-control shell: primary daemon host on a laptop, supervising the engine as a bundled Node child and giving the renderer a typed IPC seam to the daemon (see product ADRs 0008/0009). It owns its settings surfaces: Plugins, Customize, Connections, and Workspaces.
- [cursor-acp](./packages/cursor-acp/GLOSSARY.md) — the Cursor harness adapter: bridges the engine's harness contract to the Cursor agent over ACP.
- [claude-code](./packages/claude-code/GLOSSARY.md) — the Claude Code harness adapter: drives an installed, host-authenticated Claude Code CLI through the TanStack adapter.
- [codex-cli](./packages/codex-cli/GLOSSARY.md) — the Codex harness adapter: drives an installed, host-authenticated Codex CLI through the TanStack Codex adapter.

### Self-correction (the sensing layer)

- [sensor](./configs/sensor/GLOSSARY.md) — the CI-resident sensors: seed runs, test-suite budgets, and the paired comparison tool that measure the app's own health and file work items on the issue tracker (ADRs 0021, 0022, 0026).

## Relationships

### Orchestration runtime flow

The **daemon** (hosted by the `cli`) runs two heartbeats over every registered **workspace**:

1. **Reconcile.** The reconcile worker polls each workspace's **issue tracker** (GitHub Issues or Linear) and attaches any configured **source control provider**'s PR state, then `classify` partitions the observed items into **eligible**, **claimed**, **blocked** (open dependencies), and **needs-human** (triage parked it), each tagged with an **operation**. The result is held in an in-memory snapshot.
2. **Execute.** The **scheduler** picks eligible **candidates** from that snapshot under its concurrency limits and daily budget, and forks one **executor** per candidate.

Each executor run then:

- **claims** the work item on the issue tracker (a label plus a coordination marker),
- opens a git **worktree** for the branch,
- resolves the selected **operation** and its settings into the inputs for a run,
- sends a **harness request** to the **harness service**, which routes to the registered **harness runner** by name,
- streams **harness events** back, appending them to the **run ledger** and publishing **run activity** on the event bus,
- records the **attempt** outcome and updates roles and coordination on the issue tracker (PR state is read from the source control provider, never written back).

### Cross-context edges

- **engine → contracts.** Every engine service consumes and produces contracts schemas. Contracts owns the shared nouns; engine owns the verbs and the nouns only it speaks.
- **cli → engine.** The `daemon` command is the headless host: it composes the engine's layers into a running server. `status` / `runs` / `watch` are clients over the RPC group. `worktree` embeds the engine's worktree manager directly, with no RPC. The desktop app is the primary daemon host on a laptop and talks over the same RPC contract; it does not live in this package yet.
- **external Harnesses → engine.** Claude Code, Codex, and Cursor implement the Harness runner interface through one engine-owned external runtime. That runtime owns the mandatory Workspace, Sandbox lifecycle, authentication resolution, MCP and secret projection, cancellation, event normalization, and optional usage estimation. Each package retains its native descriptor: Claude session lineage and native options, Codex shared Git and native options, or Cursor ACP transport, generated catalog, telemetry acknowledgements, and usage fallback. Capability profiles expose their intentional inequalities; no path falls back to another Harness or authentication mode.
- **engine ↔ issue tracker.** Claims, attempts, and other coordination markers live in one coordination comment on the issue tracker, so any daemon can rebuild its coordination view from the tracker alone. Human-facing triage proposals are separate comments (one per round) so the thread stays conversational. The "ledger" marker anchoring the coordination comment is not the run ledger — see contracts.
- **engine ↔ source control provider.** A separate port that resolves a work item's pull request by its **link key** (the `ticketSlug(item.id)` branch prefix) and reports the PR's checks, reviews, mergeable state, and human comments. It can also open a pull request and post the daemon's marked round summary. Coordination stays on the issue tracker; push and rebase stay with the agent. A GitHub issue tracker is its own provider by default; a Linear tracker pairs with a GitHub provider via an explicit `sourceControl` config block. This is what lets a Linear-tracked, GitHub-hosted repo get follow-up on its PRs (see engine ADR 0004).
