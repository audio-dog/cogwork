# Context assembler owns layered instructions; playbook skills are provisioned on the host

The first-party harness runner needs engine-owned context. External CLI harnesses keep discovering skills themselves. We introduce a **context assembler** that returns structured **instruction layers** (global → repo → playbook). The runner turns those layers into `systemPrompts`; the filled playbook prompt template stays the user message. The assembler runs only on the first-party path (ADR 0006's unequal paths).

**Ambient instructions** are `AGENTS.md` only: `~/.clanker-forge/AGENTS.md` plus every `AGENTS.md` from the worktree cwd up to the project root. The sync package is leaving this repo, so the assembler does not depend on it.

**Playbook skills** live in `packages/engine/skills/`. For a first-party run we both (a) put `SKILL.md` into the playbook instruction layer so AFK stages always see the body, and (b) **skill-provision** the whole skill directory onto a host path under `~/.clanker-forge/` (not into the driven worktree) so sibling files stay readable without dirtying git. This mirrors TanStack sandbox's "skills are files on disk" idea without using `defineWorkspace` projection on the first-party `chat()` path. MCP skills stay on the capability channel (ADR 0005), not as a fourth instruction layer.

Compaction / windowing / tool-result pruning remain a named seam on the runner (`onConfig` + optional `summarize()`); this ADR does not pick an algorithm.

## Considered Options

- **Flatten everything into one prompt string in the engine** — rejected: blocks mid-run compaction and muddies the ADR 0005 assemble/render split.
- **OpenCode-style catalog + `skill` tool only** — deferred: right for interactive optional skills; unreliable for headless playbook stages that must follow one skill every time.
- **Inject `SKILL.md` only, no disk provision** — rejected: sibling skill files become hard to reach; fights TanStack's provision-to-disk skill model.
- **Copy skills into the worktree** — rejected: dirties the driven checkout and risks landing in a PR.
