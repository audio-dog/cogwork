# Context assembler owns layered instructions; playbook skills are provisioned on the host

> **Vocabulary note (2026-08-24).** This ADR predates the current domain language and uses retired terms. `MCP skill` is now **MCP server**; `playbook` is now **Operation Definition** plus **Operation Settings**; `playbook skill` is now **Operating Instructions**; `stage` is now **Operation**; `Run Manifest` is now **Run Plan**; and `capability` as an umbrella noun is retired outright — there is no collective term, so name the kind (MCP server, Skill, Subagent, Rules, Command, Hook). The decisions below stand; only the words changed. See `packages/contracts/GLOSSARY.md`.

The first-party harness runner needs engine-owned context. External CLI harnesses keep discovering skills themselves. We introduce a **context assembler** that returns structured **instruction layers** (global → repo → playbook). The runner turns those layers into `systemPrompts`; the filled playbook prompt template stays the user message. The assembler runs only on the first-party path (ADR 0006's unequal paths).

**Ambient instructions** are `AGENTS.md` only: `~/.cogwork/AGENTS.md` plus every `AGENTS.md` from the worktree cwd up to the project root. The sync package is leaving this repo, so the assembler does not depend on it.

**Playbook skills** live in `packages/engine/skills/`. For a first-party run we both (a) put `SKILL.md` into the playbook instruction layer so AFK stages always see the body, and (b) **skill-provision** the whole skill directory onto a host path under `~/.cogwork/` (not into the driven worktree) so sibling files stay readable without dirtying git. This mirrors TanStack sandbox's "skills are files on disk" idea without using `defineWorkspace` projection on the first-party `chat()` path. MCP skills stay on the capability channel (ADR 0005), not as a fourth instruction layer.

Compaction / windowing / tool-result pruning remain a named seam on the runner (`onConfig` + optional `summarize()`); this ADR does not pick an algorithm.

## Amendment: required context crosses every harness path

ADR 0010 adds the Codex CLI runner and changes the provider-only boundary above. The context assembler now supplies every harness runner with the required instruction layers and provisioned playbook resource path. External CLI discovery remains useful for optional user capabilities, but a mandatory AFK playbook never depends on ambient installation or discovery.

## Amendment: Rules are a fourth instruction layer, beneath Operating Instructions

The contribution-kinds resolution adds **Rules** — advisory guidance contributed at any scope, authored as markdown with frontmatter. The ambient-instructions-are-`AGENTS.md`-only rule above is narrowed accordingly: `AGENTS.md` remains the only *ambient discovery*, and Rules are a fourth, *declared* layer.

Precedence, general to specific: global Rules → repo `AGENTS.md` → repo Rules → private-overlay Rules → **Operating Instructions, last and highest**. Rules are advisory and can never satisfy a required need — ADR 0010's guarantee that a mandatory AFK operation never depends on ambient installation or discovery holds unchanged.

## Correction: same verb, same noun, opposite destination

The paragraph above says skill provision "mirrors TanStack sandbox's 'skills are files on disk' idea". That is misleading and should not be read as placement parity.

TanStack AI's provisioning writes **into the checkout root** — `bootstrapWorkspace()` places instructions, `fileSkill` and `gitSkill` content under the same directory as the cloned source, then `projectWorkspace()` renders per harness. Every on-disk destination is inside the checkout. This ADR does the opposite on purpose, and its own rejected-options list rejects what TanStack does ("Copy skills into the worktree — rejected: dirties the driven checkout and risks landing in a PR").

The inversion is right, because the two systems drive different things: TanStack's checkout is a throwaway clone inside a disposable sandbox, while Cogwork drives a real worktree whose diff becomes a pull request. The decision stands; only the justification was wrong. The accurate framing is **host-side skill provision** — same verb, same noun, opposite destination.

## Correction: the Engine does not police what a Rule says

The amendment above also claimed a Rule can never "weaken Operating Instructions". That half is struck by ADR [0018](../../../../docs/adr/0018-contribution-files-live-in-three-authoring-trees.md). The Engine collects Rules and does not read them: it decides on / off, whether the globs match, and where in the ladder they sit. Whether a model then follows a Rule over an Operating Instruction is the author's business, and no Engine gate can enforce otherwise. "Can never satisfy a required need" survives, because that one *is* an Engine gate.

The same ADR narrows this ADR's ambient-instruction rule in the other direction. `AGENTS.md` is no longer the only thing read from a repository: `<repo>/.agents/` is the Workspace input's **Authoring tree**, scanned on registration, and `register` is the trust act that admits it.

## Amendment: Operating Instructions use their own package contract

The first-party packages now live in `packages/engine/operating-instructions/`. Each package has an `INSTRUCTIONS.md` entry point and can carry supporting resources. The Context assembler copies that package to the Run's host-side resource path, records every readable resource in the Run Plan, and supplies the entry point as the highest-precedence instruction layer. References above to `packages/engine/skills/`, `SKILL.md`, playbook skills, and skill provision describe the retired representation and do not direct current implementation. Real Skills remain contributions and keep the `SKILL.md` contract.

## Amendment: a Workspace may supply the package

ADR [0019](../../../../docs/adr/0019-per-workspace-operating-instructions-overrides.md) narrows the package-source claim above. `packages/engine/operating-instructions/` remains the default source, and a Workspace may replace a package whole from its private overlay tree at `~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/`. The Context assembler resolves the source by presence — override directory first, engine package otherwise — and an override that is present but has no readable, non-empty `INSTRUCTIONS.md` fails the Run rather than falling back. Everything downstream of source resolution (copy to the Run's host-side resource path, resource recording, entry point as the highest-precedence layer) is unchanged, so the assembler must now know which Workspace a Run belongs to.

## Considered Options

- **Flatten everything into one prompt string in the engine** — rejected: blocks mid-run compaction and muddies the ADR 0005 assemble/render split.
- **OpenCode-style catalog + `skill` tool only** — deferred: right for interactive optional skills; unreliable for headless playbook stages that must follow one skill every time.
- **Inject `SKILL.md` only, no disk provision** — rejected: sibling skill files become hard to reach; fights TanStack's provision-to-disk skill model.
- **Copy skills into the worktree** — rejected: dirties the driven checkout and risks landing in a PR.
