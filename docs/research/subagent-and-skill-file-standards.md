# Subagent, Skill, and Command file standards: what a portable cogwork file should follow

Date: 2026-11-03. All sources accessed on 2026-11-03.

**Scope and method.** Cogwork scans contribution files from three Authoring trees: `~/.agents/`,
`<repo>/.agents/`, and the private workspace overlay
(ADR [0018](../adr/0018-contribution-files-live-in-three-authoring-trees.md)). The Skill kind uses
`skills/<name>/SKILL.md`. The Subagent kind uses `subagents/<name>.md`, and the Command kind uses
`commands/<name>.md` ([`authoring-tree.ts`](../../packages/engine/src/authoring-tree.ts)). Cogwork has
not defined what goes inside a Subagent file or a Command file. The maintainer wants an industry
standard, not a new format. A Subagent's model choice must be a Model level (`light`, `standard`,
`deep`), not a vendor model id
(ADR [0028](../adr/0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md)). This note
supports issue [#874](https://github.com/taylorfsteele/cogwork/issues/874).

This note answers five questions:

1. What is the Agent Skills standard, who adopted it, and which discovery directory is shared?
2. What Subagent file format and location does each vendor use?
3. Is there an emerging cross-vendor standard for Subagent definitions?
4. Is there a shared format for Commands, and do Commands converge into Skills?
5. Which format should cogwork adopt for a portable Subagent file, and how does a Model level fit?

Sources are primary only: vendor docs, spec sites, foundation press releases, and vendor
repositories. Repository snapshots: `agentskills/agentskills` at `69ef37e9` (2026-08-09),
`agentplugins/agent-plugins-spec` at `ff8ab5e3` (2026-08-19), and the vendored `.repos/opencode` at
`ceb4890` (2026-07-30). I read GitHub issues and discussions through the GitHub API. I mark a claim
**(inference)** when no source states it. I mark a claim **thin evidence** when only a weak or
indirect source supports it. This note builds on
[`harness-native-projection-channels.md`](./harness-native-projection-channels.md), which maps the
native channels of Claude Code, Codex, and Cursor, and on
[`authoring-skills-and-subagents.md`](./authoring-skills-and-subagents.md), which covers Claude Code
in depth. It does not repeat them.

---

## TL;DR

1. **Skills have one standard, and it now has a neutral owner.** The Agent Skills format
   (`SKILL.md` with `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`)
   came from Anthropic. The Agentic AI Foundation (AAIF, Linux Foundation) accepted it as a project
   on 2026-10-22
   ([LF press release](https://www.linuxfoundation.org/press/agentic-ai-foundation-announces-four-new-projects-agent-skills-open-responses-openenv-and-opensandbox)).
   The spec's client list has 46 products, including Claude Code, Codex, Cursor, GitHub Copilot,
   VS Code, opencode, Gemini CLI, Amp, Factory, Kiro, Goose, and OpenHands
   ([`clients.jsx`](https://github.com/agentskills/agentskills/blob/main/docs/snippets/clients.jsx)).
2. **`.agents/skills` is a convention, not a rule of the spec.** The spec "does not mandate where
   skill directories live," but its client guide calls `.agents/skills/` "a widely-adopted
   convention for cross-client skill sharing"
   ([adding skills support](https://agentskills.io/client-implementation/adding-skills-support.md)).
   Codex, Cursor, VS Code and Copilot, opencode, Gemini CLI, and Amp read it. Claude Code and Kiro do
   not.
3. **No standard exists for Subagents. A neutral body says so.** The Agent Plugins spec (1.0.0;
   maintainers from Amazon, Cursor, Microsoft, OpenAI, and Vercel; AAIF Technical Committee
   approved) covers Skills and MCP servers only. It says "commands, hooks, agents, rules, and LSP
   servers — remain too client-specific for a stable portable contract"
   ([spec 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md)). Open
   proposals in the Agent Skills and AGENTS.md projects ask for a Subagent format. None has a spec
   change.
4. **The de facto Subagent format is Markdown with YAML frontmatter, in the Claude Code shape.**
   Claude Code, Cursor, Copilot and VS Code, opencode, Gemini CLI, Factory, Kiro, OpenHands, and
   Kimi Code all use a Markdown file with frontmatter and the body as the prompt. Cursor and VS Code
   read `.claude/agents/` directly. Factory imports it. Kimi Code loads Claude-style files. **Codex
   is the outlier:** it uses TOML (`.codex/agents/*.toml`), and its role file cannot change the
   sandbox.
5. **The only common fields are `name`, `description`, and the prompt body.** `model`, the tools
   allowlist, and read-only control differ in name and in meaning across vendors. Kimi Code states
   the floor: "A minimal file with `description` and a body works across tools"
   ([Kimi Code agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html)).
6. **Omission is the portable form of "use the parent's model".** Every vendor runs a Subagent on
   the parent's model when the file has no `model` field. `model: inherit` is valid in Claude Code,
   Cursor, Gemini CLI, Factory, and OpenHands, but not in Codex, Copilot, opencode, or Kiro. Two
   vendors already put a named indirection in front of the model: Factory's `complexity` tiers
   (`light`, `medium`, `heavy`) and OpenHands' LLM profile names.
7. **Commands are merging into Skills.** Claude Code: "Custom commands have been merged into
   skills." Codex: custom prompts are "Deprecated. Use skills." Cursor ships `/migrate-to-skills`,
   which converts slash commands to Skills with `disable-model-invocation: true`. VS Code runs
   prompt files only in its Local harness and says to use a Skill elsewhere. Gemini CLI (TOML) and
   opencode (Markdown) still keep a separate Command file.
8. **Recommendation.** Use the Claude Code Markdown shape as cogwork's portable Subagent file, with
   only `name`, `description`, the body, and an optional `tools` list. Leave the vendor `model` field
   out of the source. Map omission to `standard`, and carry `light` or `deep` in a cogwork-owned key
   that each Harness adapter maps to a native value. Do not define a Command format: author a
   Command as a Skill with `disable-model-invocation: true`. See Question 5.

---

# Question 1 — The Agent Skills standard

## The spec

A Skill is a directory with a `SKILL.md` file, plus optional `scripts/`, `references/`, and
`assets/` ([specification](https://agentskills.io/specification)). The frontmatter fields:

| Field | Required | Constraint |
| --- | --- | --- |
| `name` | Yes | 1–64 characters; lowercase `a-z`, `0-9`, and `-`; no leading, trailing, or double hyphen; must match the parent directory name |
| `description` | Yes | 1–1024 characters; says what the Skill does and when to use it |
| `license` | No | A license name or a bundled license file |
| `compatibility` | No | 1–500 characters; environment needs |
| `metadata` | No | A map from string keys to string values, for "additional properties not defined by the Agent Skills spec" |
| `allowed-tools` | No | A space-separated list of pre-approved tools. "Experimental. Support for this field may vary" |

The spec has no `model`, `context`, `agent`, `disable-model-invocation`, or `user-invocable` field.
Issue [#105](https://github.com/agentskills/agentskills/issues/105) (open since 2026-01-24, 19
comments) asks the spec to adopt the Claude Code command fields. Discussion
[#616](https://github.com/agentskills/agentskills/discussions/616) (2026-10-23) proposes
`context: fork`. Neither is in the spec.

The project's own bar is high: "it is much easier to add things to a specification than to remove
them. … When in doubt, leave it out"
([`CONTRIBUTING.md`](https://github.com/agentskills/agentskills/blob/main/CONTRIBUTING.md)).

## Governance and dates

- **Origin.** "The Agent Skills format was originally developed by Anthropic, released as an open
  standard" ([agentskills.io](https://agentskills.io)). The spec repository was created on
  2025-12-16 (GitHub API, `agentskills/agentskills`).
- **Neutral home.** AAIF launched in December 2025 with MCP, goose, and AGENTS.md. On 2026-10-22 it
  announced Agent Skills, "contributed by Anthropic," as one of four new projects
  ([LF press release](https://www.linuxfoundation.org/press/agentic-ai-foundation-announces-four-new-projects-agent-skills-open-responses-openenv-and-opensandbox);
  [AAIF projects](https://aaif.io/projects)). The proposal
  [aaif/project-proposals#47](https://github.com/aaif/project-proposals/issues/47) is still open,
  so paperwork may continue **(thin evidence on final status)**.

## Who adopted it

The spec lists a client only if it can "discover and execute skills today"
([`CONTRIBUTING.md`](https://github.com/agentskills/agentskills/blob/main/CONTRIBUTING.md)). At
`69ef37e9`, [`clients.jsx`](https://github.com/agentskills/agentskills/blob/main/docs/snippets/clients.jsx)
lists 46 clients. The ones that matter to cogwork, with each vendor's own statement:

| Vendor | Vendor's statement | Project paths | User paths |
| --- | --- | --- | --- |
| Claude Code | "Claude Code skills follow the Agent Skills open standard" ([skills](https://code.claude.com/docs/en/skills)) | `.claude/skills/` | `~/.claude/skills/` |
| OpenAI Codex | "Skills build on the open agent skills standard" ([build skills](https://developers.openai.com/codex/skills)) | `.agents/skills` from cwd up to the repo root | `~/.agents/skills`; `/etc/codex/skills` |
| Cursor | "Agent Skills is an open standard" ([skills](https://cursor.com/docs/skills)) | `.agents/skills/`, `.cursor/skills/`; also `.claude/skills/`, `.codex/skills/` | `~/.agents/skills/`, `~/.cursor/skills/`; also `~/.claude/skills/`, `~/.codex/skills/` |
| GitHub Copilot and VS Code | "Open standard (agentskills.io)" ([VS Code skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)) | `.github/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |
| opencode | Listed client ([skills](https://opencode.ai/docs/skills/)) | `.opencode`, plus `.claude` and `.agents` skill dirs (`skill/index.ts`) | Same, at user level |
| Gemini CLI | "Based on the Agent Skills open standard" ([skills](https://geminicli.com/docs/cli/skills/)) | `.gemini/skills/` or the `.agents/skills/` alias | `~/.gemini/skills/` or `~/.agents/skills/` |
| Amp | Listed client ([skills](https://ampcode.com/docs/customize/skills)) | `.agents/skills/`, `.claude/skills/` | `~/.config/agents/skills/`, `~/.agents/skills/`, `~/.claude/skills/` |
| Kiro | "Kiro supports the Agent Skills standard" ([skills](https://kiro.dev/docs/skills/)) | `.kiro/skills/` only | `~/.kiro/skills/` only |
| Factory, Goose, OpenHands, Junie, Roo Code, Letta, Tabnine, and others | Listed clients | Not checked | Not checked |

## The shared discovery directory

The spec defines the inside of a Skill, not its location. The client guide tells each client to
scan both its own directory and `.agents/skills/` at project and user scope. It also says: "The
universal convention across existing implementations: project-level skills override user-level
skills," and it recommends a trust check before loading project Skills
([adding skills support](https://agentskills.io/client-implementation/adding-skills-support.md)).
Issue [#15](https://github.com/agentskills/agentskills/issues/15), "include a standard folder where
agent skills should be," is still open (2025-12-19, 130 comments).

Precedence differs across vendors. Gemini CLI prefers `.agents/skills/` over `.gemini/skills/` in
the same tier. Codex does not merge two Skills with the same name; both can show. Amp takes the
first match from an 11-step list. Cursor gives no rule
([`harness-native-projection-channels.md`](./harness-native-projection-channels.md)).

For cogwork, ADR 0018's choice of `~/.agents/skills` is now the cross-vendor convention. Claude Code
is the main Harness that does not read it.

---

# Question 2 — Subagent file formats, per vendor

## Comparison of Subagent formats

"Inherit by omission" means that a file with no model field runs on the parent's model.

| Vendor | Project and user location | File format | Required fields | Model field | Tools control | Read-only control | Reads other vendors' agent dirs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `.claude/agents/`, `~/.claude/agents/` (recursive); plugin `agents/`; `--agents` JSON | Markdown + YAML; body is the prompt | `name`, `description` | `sonnet`, `opus`, `haiku`, `fable`, full id, or `inherit`; inherit by omission | `tools`, `disallowedTools` | `tools` allowlist, or `permissionMode: plan` | No |
| Cursor | `.cursor/agents/`, `~/.cursor/agents/` | Markdown + YAML | None (`name` from file name) | `inherit` (default) or an id with `[effort=…]` options | None | `readonly: true` | `.claude/agents/`, `.codex/agents/` (project and user) |
| OpenAI Codex | `.codex/agents/*.toml` (trusted project), `~/.codex/agents/`; `[agents.*]` in config | TOML | `name`, `description`, `developer_instructions` | `model` slug plus `model_reasoning_effort`; inherit by omission | `features.<x> = false` only | None: "they don't create a separate read-only sandbox" | No |
| GitHub Copilot (cloud, CLI) and VS Code | `.github/agents/*.agent.md`, `~/.copilot/agents/`; org `agents/` | Markdown + YAML; prompt up to 30,000 characters | `description` | `model` string (IDEs); inherit by omission | `tools` with aliases (`read`, `edit`, `search`, `execute`, `agent`, `web`) | `tools` allowlist | VS Code: `.claude/agents/`, `~/.claude/agents/` in "the Claude agent format" |
| opencode | `.opencode/agents/`, `~/.config/opencode/agents/`; `agent` in `opencode.json` | Markdown + YAML, or JSON | `description` (name from file name) | `provider/model-id`; a subagent inherits the invoking agent's model by omission | `permission` map (`tools` is deprecated) | `permission: { edit: deny }` | No (source: only `.opencode` and the global config dir) |
| Gemini CLI | `.gemini/agents/*.md`, `~/.gemini/agents/*.md` | Markdown + YAML | `name`, `description` | `model`, default `inherit` | `tools` with wildcards | `tools` allowlist | No |
| Factory (droids) | `.factory/droids/`, `~/.factory/droids/` | Markdown + YAML | `name` | `inherit` (default) or an id; `reasoningEffort`; caller `complexity` tier | `tools` list or a category | `tools: read-only` | One-time import from `.claude/agents/` |
| Kiro | `.kiro/agents/`, `~/.kiro/agents/` | JSON, or Markdown + YAML (IDE 1.0, CLI V3) | None stated (`name` from file name) | Model id; default model by omission | `tools`, `excludedTools`, `permissions` | `permissions` rules | No evidence |
| Amp | No file; plugin code `amp.createAgent({ name, model, instructions, tools, reasoningEffort })` | TypeScript | — | `model` string | `tools` | — | No |
| OpenHands SDK | `.agents/agents/*.md`, `.openhands/agents/`, `~/.agents/agents/` (top level only) | Markdown + YAML | None (`name` from file stem) | `inherit` (default) or an LLM profile name | `tools` | `permission_mode` | Reads `.agents/agents/` |
| Kimi Code CLI | `.agents/agents/`, `.kimi-code/agents/`, `~/.agents/agents/` (recursive) | Markdown + YAML | `description` | None; ignores Claude's `model` | `tools`, `disallowedTools` (Claude names) | `tools` allowlist | Reads `.agents/agents/`; loads Claude-style files |

Sources: [Claude Code subagents](https://code.claude.com/docs/en/sub-agents);
[Cursor subagents](https://cursor.com/docs/subagents);
[Codex subagents](https://developers.openai.com/codex/subagents);
[Copilot custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration),
[Copilot create custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-custom-agents),
[VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents);
[opencode agents](https://opencode.ai/docs/agents/) and `.repos/opencode`
`packages/opencode/src/config/{agent,paths}.ts`;
[Gemini CLI subagents](https://geminicli.com/docs/core/subagents/);
[Factory custom droids](https://docs.factory.ai/cli/configuration/custom-droids);
[Kiro agent configuration reference](https://kiro.dev/docs/cli/custom-agents/configuration-reference/);
[Amp plugin API](https://ampcode.com/docs/plugin-api), [Amp custom agents](https://ampcode.com/news/custom-agents);
[OpenHands SDK subagent `AGENTS.md`](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/subagent/AGENTS.md);
[Kimi Code agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html).

## Notes per vendor

**Claude Code.** `name` is at most 256 characters, with no `:`, because `:` marks a plugin scope.
The file name does not have to match. When `model` is absent, Claude Code follows its "subagent
model order": a per-invocation alias, then the frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then
the main conversation's model. `effort` is a separate field (`low` to `max`). Plugin Subagents ignore
`permissionMode`, `mcpServers`, and `hooks` ([subagents](https://code.claude.com/docs/en/sub-agents)).
The docs name no `.agents/` path for Subagents or Skills.

**Cursor.** The fields are `name`, `description`, `model`, `readonly`, and `is_background`. Cursor
reads `.claude/agents/` and `.codex/agents/` "for compatibility," and `.cursor/` wins over the
others on a name clash ([subagents](https://cursor.com/docs/subagents)). The page says each Subagent
is "a markdown file." Codex files in `.codex/agents/` are TOML. The docs do not say whether Cursor
parses them **(thin evidence)**. Cursor falls back to "a compatible model" when a pinned model is
blocked or not on the plan.

**Codex.** Codex identifies a custom agent by its `name` field, not by the file name. A custom agent
"can't override" the parent's permissions, provider, or MCP servers. "Custom agent instructions can
ask an agent to avoid edits, but they don't create a separate read-only sandbox." When the file sets
no model, the Subagent "inherits the parent agent's model and reasoning effort"
([subagents](https://developers.openai.com/codex/subagents)). So a read-only reviewer on Codex is a
request in the prompt, not an enforced limit.

**GitHub Copilot and VS Code.** Copilot calls these "custom agents" or "agent profiles." The file
name (without `.md` or `.agent.md`) is the key for deduplication. Unknown tool names "are ignored,
which allows product-specific tools to be specified in an agent profile without causing problems."
The tool aliases accept Claude names: `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Bash`, `Task`
([configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)). The
`model` property applies "in VS Code, JetBrains IDEs, Eclipse, or Xcode"
([create custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-custom-agents)).
VS Code also reads `.claude/agents/` and `~/.claude/agents/` "in the Claude agent format"
([VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)).
Copilot custom agents were "previously known as custom chat modes" (`.chatmode.md`).

**opencode.** An agent has a `mode`: `primary`, `subagent`, or `all` (the default). Read-only is
`permission: { edit: deny }`. The vendored source loads `{agent,agents}/**/*.md` only from `.opencode`
directories and the global config directory (`config/agent.ts`, `config/paths.ts`). For Skills it
also reads `.claude` and `.agents` (`skill/index.ts`).

**Gemini CLI.** `kind` is `local` (the default) or `remote`. The other fields are `tools`,
`mcpServers`, `model` (default `inherit`), `temperature`, `max_turns`, and `timeout_mins`
([subagents](https://geminicli.com/docs/core/subagents/)). The Gemini CLI docs say that unpaid-tier
users moved to Antigravity CLI on 2026-06-18
([custom commands](https://geminicli.com/docs/cli/custom-commands/)). I did not check Antigravity CLI
**(thin evidence on its format)**.

**Factory.** A droid's `model` is `inherit` by default. The caller's Task tool can pass `complexity:
light | medium | heavy`. When the droid's model is `inherit`, Factory maps that tier "to a model
using the routing you configure in `/settings`." A pinned model that the organization blocks "falls
back to the parent's model rather than failing." The import from Claude Code maps `sonnet`, `haiku`,
and `opus` to "the first available model in that family"
([custom droids](https://docs.factory.ai/cli/configuration/custom-droids)). This is the nearest
vendor design to a cogwork Model level.

**Kiro.** Kiro reads agents from `.kiro/agents/` and `~/.kiro/agents/`. CLI V3 adds a Markdown form
with config in the frontmatter and the system prompt in the body. If a pinned model is unavailable,
"the first prompt can fail instead of falling back automatically"
([configuration reference](https://kiro.dev/docs/cli/custom-agents/configuration-reference/)).

**Amp.** Amp has no Subagent file. A custom agent is TypeScript in a plugin
([plugin API](https://ampcode.com/docs/plugin-api)). Amp is out of reach for a file format.

## Which vendors read another vendor's directory

| Reader | Reads | Kind |
| --- | --- | --- |
| Cursor | `.claude/agents/`, `.codex/agents/` (project and user) | Subagents |
| VS Code (Copilot) | `.claude/agents/`, `~/.claude/agents/` | Subagents |
| Factory | `.claude/agents/`, `~/.claude/agents/` | One-time import, not live |
| Kimi Code | `.agents/agents/`; loads Claude-style frontmatter | Subagents |
| OpenHands SDK | `.agents/agents/` | Subagents |
| Cursor, VS Code, opencode, Amp | `.claude/skills/` | Skills |
| Cursor | `.codex/skills/` | Skills |

No vendor reads `.cursor/agents/`, `.github/agents/`, `.gemini/agents/`, or `.opencode/agents/` in
the sources I read. `.claude/agents/` is the one Subagent directory that other major vendors read
live.

---

# Question 3 — Is a cross-vendor Subagent standard emerging?

**Short answer: no standard exists. Two neutral bodies have declined or not yet started one. A
directory convention, `.agents/agents/`, is emerging among smaller tools.**

| Effort | Owner | Status on 2026-11-03 | Subagent definitions? |
| --- | --- | --- | --- |
| Agent Skills | AAIF (accepted 2026-10-22) | Spec at `69ef37e9`; 46 listed clients | **No.** Discussion [#152](https://github.com/agentskills/agentskills/discussions/152) (2026-02-08, 9 comments) asks to link Subagents and Skills; issue [#111](https://github.com/agentskills/agentskills/issues/111), an `agents` field, is closed. No spec change |
| Agent Plugins | Cross-vendor TSC (Amazon, Cursor, Microsoft, OpenAI, Vercel) | 1.0.0 published; 1.1.0 working draft; AAIF proposal [#56](https://github.com/aaif/project-proposals/issues/56) (2026-10-12) labeled "TC Approved" and "GB Vote" | **No, by decision.** "Agent Plugins v1 defines exactly two component types: skills and MCP servers." Agents, commands, hooks, and rules wait "until their formats converge." The 1.1.0 draft keeps this text |
| AGENTS.md | AAIF (founding project, December 2025) | Plain Markdown; "No required fields" ([agents.md](https://agents.md)) | **No.** Issues [#149](https://github.com/agentsmd/agents.md/issues/149) (2026-02-08, sub-agents, 0 comments), [#184](https://github.com/agentsmd/agents.md/issues/184) (2026-05-11, `.agent/` with `agents/`), and [#62](https://github.com/agentsmd/agents.md/issues/62) (2025-09-17, `.agents` subfolder) are open |
| Agent Client Protocol (ACP) | Zed and JetBrains; AAIF proposal [#1](https://github.com/aaif/project-proposals/issues/1) (2026-04-01, "TC Approved") | Subagent RFD added 2026-09-30, unstable | **No.** The [subagent RFD](https://agentclientprotocol.com/rfds/subagents) shows a running child session to a client (`subagent_update`). It does not define a Subagent. Session modes (`ask`, `architect`, `code`) are runtime choices, not files |
| Agent2Agent (A2A) | AAIF | Hosted project | **Not for local Subagents.** Gemini CLI's `kind: remote` points at remote agents **(inference that this is A2A; I did not verify)** |
| `.agents/agents/` directory | No owner | Read by OpenHands SDK, Kimi Code CLI, pw code, Fabric Agents, and Empryo | **Location only.** Each tool keeps its own fields. pw code, Fabric, and Empryo docs came from search results, and I did not read them in full **(thin evidence for those three)** |

Three facts carry the answer:

- **The neutral packaging spec excludes agents on purpose**, and Cursor and OpenAI sit on its
  steering committee. A Subagent standard is not near.
- **The Agent Skills project moves slowly by policy.** Its contributing guide rejects "major
  architectural changes" for now.
- **The de facto standard is the Claude Code file**, because two major vendors read it live
  (Cursor, VS Code), one imports it (Factory), and new tools load it (Kimi Code, Empryo).

---

# Question 4 — Commands

## Formats today

| Vendor | Command store | Format | Status |
| --- | --- | --- | --- |
| Claude Code | `.claude/commands/*.md`, `~/.claude/commands/*.md` | Markdown; same frontmatter as a Skill except `name` and `paths` | "Custom commands have been merged into skills." Old files "keep working." A Skill wins over a Command of the same name ([skills](https://code.claude.com/docs/en/skills)) |
| Codex | `~/.codex/prompts/*.md` (user only) | Markdown; `description`, `argument-hint`, `$1`–`$9`, `$ARGUMENTS` | "Deprecated. Use skills for reusable prompts" ([custom prompts](https://developers.openai.com/codex/custom-prompts)). Codex converts plugin `commands/` into Skills ([projection note](./harness-native-projection-channels.md)) |
| Cursor | Plugin `commands/`; `.cursor/commands/` **thin evidence** | Markdown | The commands page now shows Skills. `/migrate-to-skills` converts slash commands "to skills with `disable-model-invocation: true`" ([skills](https://cursor.com/docs/skills)) |
| VS Code (Copilot) | `.github/prompts/*.prompt.md`; user profile | Markdown; `description`, `name`, `argument-hint`, `agent`, `model`, `tools` | "Prompt files run only in Local harness sessions … For reusable workflows in other harnesses, create an agent skill" ([prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files)) |
| Gemini CLI | `.gemini/commands/*.toml`, `~/.gemini/commands/*.toml` | TOML; `prompt` (required), `description`; `{{args}}`, `!{…}`, `@{…}` | Current ([custom commands](https://geminicli.com/docs/cli/custom-commands/)) |
| opencode | `.opencode/commands/*.md`, global config `commands/` | Markdown; body is the template | Current (`config/command.ts`) |
| Kiro | No separate store | — | Skills run "As slash commands" ([skills](https://kiro.dev/docs/skills/)) |

## Convergence

The direction is clear. Four of the seven vendors now treat a Command as a Skill that only a person
invokes:

- **The invocation switch is `disable-model-invocation: true`.** Claude Code, Cursor, and VS Code
  use this field on Skills. Copilot uses the same name on custom agents
  ([configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)). The
  Agent Skills client guide names it as a reason to hide a Skill from the catalog
  ([adding skills support](https://agentskills.io/client-implementation/adding-skills-support.md)).
- **Codex spells it differently.** A Skill's `agents/openai.yaml` sets
  `policy.allow_implicit_invocation: false`, and "explicit `$skill` invocation still works"
  ([build skills](https://developers.openai.com/codex/skills)).
- **The field is not in the spec.** Issue [#105](https://github.com/agentskills/agentskills/issues/105)
  proposes it. Until the spec adopts it, each adapter maps it **(inference)**.

Argument placeholders do not converge. Claude Code and Codex use `$ARGUMENTS`. Gemini CLI uses
`{{args}}`. Kiro supports `$ARGUMENTS` in the CLI only. A portable Command body must not depend on a
placeholder **(inference)**.

---

# Question 5 — What cogwork should adopt

## The format

**Adopt the Claude Code Markdown Subagent shape as the portable source format, and use only the
fields that every Markdown vendor reads.**

```markdown
---
name: bug-hunter
description: Reports correctness bugs that a diff introduces. Report-only.
tools: Read, Grep, Glob, Bash
---

The prompt body.
```

Why this shape:

- It is the only Subagent file that other major vendors read live (Cursor and VS Code). Factory
  imports it, and Kimi Code loads it.
- Every Markdown vendor in the table reads `description` and the body. Most accept `name`.
- It matches the files the sync toolkit already writes. `~/.agents/agents/griller.md` on this
  machine uses `name`, `description`, `tools`, and `skills`.

Field rules for the portable core **(inference from the comparison table)**:

| Field | Rule | Why |
| --- | --- | --- |
| `name` | Required. 1–64 characters of `a-z`, `0-9`, `-`; equal to the file name | The intersection of Claude Code (no `:`), Cursor (lowercase and hyphens), Gemini CLI, Factory (`^[a-z0-9-_]+$`), Kimi Code (kebab-case), and the Codex `-c` key alphabet |
| `description` | Required | Every vendor uses it to decide delegation |
| Body | Required, non-empty | Factory rejects an empty body. Codex takes it as `developer_instructions` |
| `tools` | Optional allowlist with Claude tool names | Claude Code and Gemini CLI enforce it. Copilot and Kimi Code map Claude names. Cursor and Codex have no allowlist |
| Read-only intent | A cogwork-owned key, not a vendor key | No common field exists. Cursor has `readonly`, Claude Code has `permissionMode: plan` or `tools`, opencode has `permission.edit`, Factory has `tools: read-only`, and Codex cannot enforce it |
| `model` | **Not in the source** | See below |

The adapter renders this source into each Harness's native form. For Codex, that means a TOML role
file through the `-c agents.<name>.config_file` channel
([projection note](./harness-native-projection-channels.md)). Codex cannot read the Markdown shape,
so a cogwork Subagent always needs a rendering step on Codex.

## Where a Model level fits

The vendor `model` field cannot carry a Model level:

- Its values are vendor ids or aliases (`haiku`, `gpt-6-luna`, `provider/model-id`). The word
  `light` is not a valid value in any vendor.
- A harness that reads a raw file with `model: light` would treat `light` as a model id. Cursor and
  Factory fall back to another model. Kiro can fail the first prompt. Kimi Code ignores the field.
  The behavior of Claude Code for an unknown value is not documented **(thin evidence)**.
- A Model level selects more than a model. `deep` likely sets reasoning effort too, and each vendor
  puts effort in a different place: `effort` (Claude Code), `model_reasoning_effort` (Codex),
  `[effort=…]` (Cursor), `reasoningEffort` (Factory, Amp) **(inference)**.

So the rule follows the portable convention that already exists:

| Model level | In the source file | Claude Code | Codex | Cursor |
| --- | --- | --- | --- | --- |
| `standard` | No level key (the default) | Omit `model`, or `inherit` | Omit `model` | Omit `model`, or `inherit` |
| `light` | A cogwork-owned level key | `haiku` | An account-valid small slug from the managed catalog | An exact small-model id |
| `deep` | A cogwork-owned level key | An adapter choice of model and `effort` | A slug plus `model_reasoning_effort` | An id with `[effort=…]` |

Omission maps to `standard`. This is the one form that every vendor reads as "run on the parent's
model," and ADR 0028 already renders `standard` "as omission where the Harness inherits by omitting."
One caution: on Claude Code, `CLAUDE_CODE_SUBAGENT_MODEL` can change what omission means. A Run
must not inherit that variable from the host if `standard` must mean the Run's own model
**(inference)**.

For the level key, two shapes fit the standards:

- **`metadata: { model-level: light }`.** The Agent Skills spec reserves `metadata` for "additional
  properties not defined by the Agent Skills spec," and Copilot agent profiles also have a
  `metadata` field. This keeps the file inside a documented extension point.
- **A top-level `model-level: light`.** This is simpler to read. Copilot and Kimi Code ignore unknown
  fields; the other vendors do not document it **(thin evidence)**.

Factory's `complexity` and OpenHands' LLM profiles show that a named tier in front of the model is
an accepted vendor design. Neither is a standard. Cogwork keeps its own three words, per ADR 0028.

## Commands

**Do not define a Command format.** Author a Command as a Skill with
`disable-model-invocation: true`. The adapter maps that field to Codex's
`policy.allow_implicit_invocation: false`. Cogwork can keep reading `commands/<name>.md` in the
Claude Code command shape as legacy input and project each file as a Skill. Gemini CLI and opencode
keep separate Command files, but cogwork does not drive them today.

This collapses the Command kind into the Skill kind. That changes the contribution kinds of ADR
[0011](../adr/0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md) and ADR 0018, so it
needs an ADR **(inference)**.

## Directory name

Cogwork scans `subagents/` in each Authoring tree
([`authoring-tree.ts`](../../packages/engine/src/authoring-tree.ts)). The emerging convention is
`.agents/agents/` (OpenHands, Kimi Code, and three smaller tools). The sync toolkit already writes
`~/.agents/agents/`. ADR 0018 says "The overlap with harness convention is `skills/` alone; the
other subdirectories are Cogwork's."

Two facts pull in opposite directions:

- **For `agents/`:** it matches the sync toolkit and the tools that read `.agents/agents/`.
- **Against `agents/`:** a tool that reads `.agents/agents/` would also read cogwork's Workspace
  input tree ambiently. No cogwork Harness does so today. If Cursor later reads `.agents/agents/`
  the way it reads `.agents/skills/`, a Subagent could arrive twice, which is the duplicate risk
  that #874 names for Skills **(inference)**.

This is a maintainer decision. The format above does not depend on it.

## Side finding: two Subagents never reach a Run Plan

`~/.agents/agents/` on this machine holds `griller.md` and `understudy.md`. `~/.agents/` has no
`subagents/` or `commands/` directory. The engine scans `subagents/` only. So today no Subagent from
the Settings profile tree enters a Run Plan, even as a `not-projected` member.

---

## Thin evidence and unverified claims

- Whether Cursor parses TOML files in `.codex/agents/`; its docs call every Subagent "a markdown
  file."
- Claude Code's behavior for an unknown `model` value or an unknown frontmatter key in a Subagent
  file.
- Final AAIF paperwork status of Agent Skills; proposal #47 is still open after the 2026-10-22
  announcement.
- The pw code, Fabric Agents, and Empryo readings of `.agents/agents/`; seen in search results only.
- Antigravity CLI's Subagent and Command formats.
- Factory's Skill discovery paths; not checked.
- Gemini CLI's `kind: remote` as A2A.
- Cursor's `.cursor/commands/` store; the page now redirects to Skills.
- All field-rule and Model-level mapping conclusions in Question 5, which are inferences from the
  vendor docs.

---

## Source list

**Standards and foundations:** [Agent Skills overview](https://agentskills.io);
[specification](https://agentskills.io/specification);
[adding skills support](https://agentskills.io/client-implementation/adding-skills-support.md);
`agentskills/agentskills` at `69ef37e9`:
[`clients.jsx`](https://github.com/agentskills/agentskills/blob/main/docs/snippets/clients.jsx),
[`CONTRIBUTING.md`](https://github.com/agentskills/agentskills/blob/main/CONTRIBUTING.md), issues
[#15](https://github.com/agentskills/agentskills/issues/15),
[#105](https://github.com/agentskills/agentskills/issues/105),
[#111](https://github.com/agentskills/agentskills/issues/111), discussions
[#152](https://github.com/agentskills/agentskills/discussions/152),
[#616](https://github.com/agentskills/agentskills/discussions/616);
[Linux Foundation press release, 2026-10-22](https://www.linuxfoundation.org/press/agentic-ai-foundation-announces-four-new-projects-agent-skills-open-responses-openenv-and-opensandbox);
[AAIF projects](https://aaif.io/projects); `aaif/project-proposals` issues
[#1](https://github.com/aaif/project-proposals/issues/1),
[#47](https://github.com/aaif/project-proposals/issues/47),
[#56](https://github.com/aaif/project-proposals/issues/56);
Agent Plugins [spec 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md),
[spec 1.1.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.1.0.md),
[`MAINTAINERS.md`](https://github.com/agentplugins/agent-plugins-spec/blob/main/MAINTAINERS.md)
at `ff8ab5e3`; [AGENTS.md](https://agents.md); `agentsmd/agents.md` issues
[#62](https://github.com/agentsmd/agents.md/issues/62),
[#149](https://github.com/agentsmd/agents.md/issues/149),
[#184](https://github.com/agentsmd/agents.md/issues/184);
ACP [subagent sessions RFD](https://agentclientprotocol.com/rfds/subagents),
[session modes](https://agentclientprotocol.com/protocol/v1/session-modes).

**Anthropic:** [Claude Code subagents](https://code.claude.com/docs/en/sub-agents);
[Claude Code skills](https://code.claude.com/docs/en/skills).

**OpenAI:** [Codex subagents](https://developers.openai.com/codex/subagents);
[Codex build skills](https://developers.openai.com/codex/skills);
[Codex custom prompts](https://developers.openai.com/codex/custom-prompts).

**Cursor:** [Subagents](https://cursor.com/docs/subagents); [Agent Skills](https://cursor.com/docs/skills);
[Commands page, now Skills](https://cursor.com/docs/context/commands).

**GitHub and Microsoft:** [Copilot custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration);
[Copilot create custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-custom-agents);
[VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents);
[VS Code agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills);
[VS Code prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files).

**Google:** [Gemini CLI subagents](https://geminicli.com/docs/core/subagents/);
[Gemini CLI skills](https://geminicli.com/docs/cli/skills/);
[Gemini CLI custom commands](https://geminicli.com/docs/cli/custom-commands/).

**Other vendors:** [opencode agents](https://opencode.ai/docs/agents/) and `.repos/opencode` at
`ceb4890` (`packages/opencode/src/config/{agent,command,paths}.ts`, `src/skill/index.ts`);
[Factory custom droids](https://docs.factory.ai/cli/configuration/custom-droids);
[Kiro agent configuration reference](https://kiro.dev/docs/cli/custom-agents/configuration-reference/),
[Kiro skills](https://kiro.dev/docs/skills/);
[Amp skills](https://ampcode.com/docs/customize/skills), [Amp plugin API](https://ampcode.com/docs/plugin-api),
[Amp custom agents](https://ampcode.com/news/custom-agents),
[Amp modes and models](https://ampcode.com/docs/models-and-subagents);
[OpenHands SDK subagent `AGENTS.md`](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/subagent/AGENTS.md);
[Kimi Code agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html).
Search results only, thin: [pw code custom agents](https://parallelworks.com/docs/ai/code/custom-agents),
[Fabric Agents](https://agents.fabric.pro/docs/agents), [Empryo agents](https://empryo.com/docs/tools/agents).

**This repo:** [`authoring-tree.ts`](../../packages/engine/src/authoring-tree.ts);
ADRs [0011](../adr/0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md),
[0018](../adr/0018-contribution-files-live-in-three-authoring-trees.md),
[0028](../adr/0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md);
[`harness-native-projection-channels.md`](./harness-native-projection-channels.md);
[`authoring-skills-and-subagents.md`](./authoring-skills-and-subagents.md);
[`harness-model-selection-and-run-speed.md`](./harness-model-selection-and-run-speed.md);
issue [#874](https://github.com/taylorfsteele/cogwork/issues/874).
