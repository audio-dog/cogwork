# 0037 — Commands are Skills, and Subagent files follow the Claude Code shape

- **Status:** accepted
- **Date:** 2026-11-05
- **Amends:** ADR [0011](./0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md),
  ADR [0018](./0018-contribution-files-live-in-three-authoring-trees.md)

## Context

ADR 0011 named six contribution kinds: MCP server, Skill, Subagent, Rules, Command, and Hook. ADR
0018 put the files in three Authoring trees and scanned `commands/<name>.md` and
`subagents/<name>.md` in each one. Cogwork never defined what goes inside a Command file or a
Subagent file.

The [#874](https://github.com/taylorfsteele/cogwork/issues/874) triage asked for an industry
standard, not a new format. The research in
[`subagent-and-skill-file-standards.md`](../research/subagent-and-skill-file-standards.md) found:

- **Commands are merging into Skills.** Claude Code merged custom commands into skills. Codex
  deprecated custom prompts for skills. Cursor converts a slash command to a Skill with
  `disable-model-invocation: true`.
- **No standard exists for Subagents**, but the de facto file is Markdown with YAML frontmatter in the
  Claude Code shape. The only fields that all vendors share are `name`, `description`, and the
  prompt body.
- **`agents/` is the folder name** that every major vendor uses inside its own folder
  (`.claude/agents/`, `.codex/agents/`), and the sync toolkit already writes
  `~/.agents/agents/`.

## Decision

1. **Commands become Skills.** The Command contribution kind goes away. A `commands/<name>.md` file
   in any Authoring tree is read as a Skill named `<name>` that the model cannot start by itself —
   the `disable-model-invocation: true` of the Claude Code shape. The contribution carries that mark. The Skill reaches a Run through the
   same mechanism as every other Skill. The contribution kinds are **MCP server, Skill, Subagent,
   Rules, and Hook**, and the Run Plan has no Commands member.
2. **Subagent files live in `agents/`** in each Authoring tree — `~/.agents/agents/`,
   `<repo>/.agents/agents/`, and the private overlay — in place of `subagents/`.
3. **The Subagent file follows the Claude Code Markdown shape:**
   - a required `name` (lowercase letters, digits, and hyphens, equal to the file name);
   - a required `description`;
   - the body as the prompt;
   - an optional `tools` list.

   No `model` field means Model level `standard` (ADR
   [0028](./0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md)). `light` and `deep`
   go in `metadata.model-level`. There is no read-only field.

When a Skill directory and a Command file in one tree have the same name, the Skill directory wins
and the Command file is not read. That is the rule Claude Code applies.

## Considered Options

- **Keep Command as a kind and define its file format.** Rejected: the vendors are retiring the
  separate Command file, and a seventh format of Cogwork's own is the thing the triage refused.
- **Stop reading `commands/` at all.** Rejected: existing Command files would disappear without a
  word. Reading them as Skills keeps them working.
- **Keep `subagents/`.** Rejected: no vendor uses that name, and the Subagents the sync toolkit writes
  to `~/.agents/agents/` never reach a Run today.
- **Carry a vendor `model` id in the Subagent file.** Rejected by ADR 0028: model choice is a named
  level, not a pinned model.

## Consequences

- The `command` kind leaves the contracts, the Plugin manifest, Operation needs, and Customize. A
  stored Workflow document whose Operation needs a `command` no longer decodes; this is pre-alpha
  and no migration is written.
- A Command file shows under Skills in Customize, with its Authoring tree as its badge.
- No shipped Plugin bundles `commands/`, so a Plugin manifest names no Command and the Plugin loader
  has no Command rule.
- Decisions 2 and 3 are implemented by a separate ticket, "Subagent files live in agents/ and carry
  a Model level". Until it lands, the scanner still reads `subagents/`.
