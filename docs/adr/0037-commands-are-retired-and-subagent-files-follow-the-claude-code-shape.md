# 0037 — Commands are retired, and Subagent files follow the Claude Code shape

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

1. **Commands are retired.** The Command contribution kind goes away, and Cogwork does not read
   `commands/` in any Authoring tree. A Command is a Skill that a person starts by name, and Cogwork
   does not model that difference: a Skill is a Skill. Whether the model may start a Skill by itself
   is the Skill file's own business — the `disable-model-invocation` frontmatter of the Claude Code
   shape, read by the Harness. The contribution kinds are **MCP server, Skill, Subagent, Rules, and
   Hook**, and the Run Plan has no Commands member.
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

## Considered Options

- **Keep Command as a kind and define its file format.** Rejected: the vendors are retiring the
  separate Command file, and a seventh format of Cogwork's own is the thing the triage refused.
- **Read `commands/<name>.md` as a Skill that only a person can start.** Rejected: it keeps the
  Command as a second kind of Skill under a new name, with a contribution field and a same-name rule
  to carry it. No Authoring tree and no shipped Plugin has a `commands/` folder, so nothing needs
  the bridge.
- **Keep `subagents/`.** Rejected: no vendor uses that name, and the Subagents the sync toolkit writes
  to `~/.agents/agents/` never reach a Run today.
- **Carry a vendor `model` id in the Subagent file.** Rejected by ADR 0028: model choice is a named
  level, not a pinned model.

## Consequences

- The `command` kind leaves the contracts, the Plugin manifest, Operation needs, and Customize. A
  stored Workflow document whose Operation needs a `command` no longer decodes; this is pre-alpha
  and no migration is written.
- A file in `commands/` is ignored, like any other folder the scanner does not know. Customize does
  not show it.
- A Plugin manifest that declares a `command` contribution fails to decode. No shipped Plugin does.
- Decisions 2 and 3 are implemented by a separate ticket, "Subagent files live in agents/ and carry
  a Model level". Until it lands, the scanner still reads `subagents/`.
