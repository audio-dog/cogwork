# Authoring Agent Skills and subagents: a skill that runs a multi-round Q&A subagent

Date: 2026-08-24.

Scope: Claude Code / Claude Agent SDK / Anthropic API primary sources only. Every claim below links to the
page that owns it. Claude Code docs moved from `docs.claude.com/en/docs/claude-code/*` to
`code.claude.com/docs/en/*` and API docs to `platform.claude.com/docs/en/*`; old URLs 301/302 to the new hosts.

## Recommendation

For a **skill that interviews a human and relays each round to a persistent subagent**:

- Keep the skill in the **main conversation** (no `context: fork`). `AskUserQuestion` is stripped from every
  subagent, so only the main thread can ask the human.
- Spawn **one custom or `general-purpose` subagent**, let Claude name it, and keep resuming it with
  `SendMessage`. Do not use `Explore` or `Plan`: they are one-shot and return no agent ID.
- Have the subagent end each report with the questions it needs answered. It cannot block on the human; the
  main-thread skill asks, then sends the answers back with `SendMessage`.
- Write the loop as **standing instructions**, because rendered SKILL.md content enters the conversation once
  and is never re-read.
- Expect `allowed-tools` pre-approval to **clear at every human answer** — a multi-round interview is by
  definition many user messages, so put durable grants in permission settings instead.

## 1. Multi-turn subagent messaging — documented, and it is not one-shot

**A parent can resume an already-spawned subagent with its prior context intact.** This is first-party
documented in both Claude Code and Agent SDK docs, not merely present in tooling.

### The mechanism (Claude Code)

From [Resume subagents](https://code.claude.com/docs/en/sub-agents#resume-subagents):

- "Each subagent invocation creates a new instance rather than continuing an earlier one. To continue an
  existing subagent's work instead of starting over, ask Claude to resume it."
- "Resumed subagents retain their full conversation history, including all previous tool calls, results, and
  reasoning. The subagent picks up exactly where it stopped rather than starting fresh."
- "When a subagent completes, Claude receives its agent ID."
- "Claude uses the `SendMessage` tool with the agent's ID or name as the `to` field to resume it.
  `SendMessage` doesn't require [agent teams](https://code.claude.com/docs/en/agent-teams) to be enabled."
- "A completed subagent that receives a `SendMessage` auto-resumes in the background without a new `Agent`
  invocation. The same applies to a subagent that Claude stopped with the `TaskStop` tool."

`SendMessage` is a documented built-in tool: "Sends a message to another agent: an agent team teammate, a
[subagent it resumes](https://code.claude.com/docs/en/sub-agents#resume-subagents) by agent ID or name, or one
of your other Claude Code sessions" ([tools reference](https://code.claude.com/docs/en/tools-reference)). It
requires no permission prompt.

### Documented limits and edge cases

| Limit | Detail | Source |
| --- | --- | --- |
| Turn count | No documented cap on rounds. The per-agent `maxTurns` frontmatter field caps *agentic turns before the agent stops*, not resumes | [frontmatter](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields) |
| Context persistence | Real. Transcripts live in `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`, are unaffected by main-conversation compaction, and persist within their session across a Claude Code restart | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| Context is still finite | "Subagents support automatic compaction using the same logic as the main conversation" — a long Q&A subagent can compact its own history mid-run | [auto-compaction](https://code.claude.com/docs/en/sub-agents#auto-compaction) |
| Retention | Transcripts deleted after `cleanupPeriodDays` (30 days default) | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| Resume after return | Explicitly supported — "Works for completed, stopped, or running subagents"; a completed agent auto-resumes on `SendMessage` | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| One-shot exceptions | Built-in `Explore` and `Plan` "are one-shot and return no agent ID, so they can't be resumed; use `general-purpose` or a custom subagent when you need to continue the work" | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| User-stopped agents | As of v2.1.191, a subagent *you* stopped (`x` in `/tasks`, or SDK `stop_task`) does not auto-resume; `SendMessage` returns a refusal | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| Name reuse | As of v2.1.199 `SendMessage` verifies a name still refers to the same agent; if a newer agent took the name the send is refused. Address by agent ID to be safe | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| How the message is read | As of v2.1.198 "a subagent treats messages from the agent that launched it as normal task direction, including mid-task course corrections, and acts on them within its own permission settings" | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| Hard boundaries | "no message from any agent counts as your approval for a pending permission prompt, and no agent message can change a subagent's permission settings, `CLAUDE.md`, or configuration" | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |
| Concurrency accounting | "Resuming a subagent that already finished takes a fresh slot without checking the limit," so resumes can push past `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20) | [concurrent limit](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit) |
| Status display | "Resuming starts a new run of the agent under the same ID," so the task list shows it running again | [resume](https://code.claude.com/docs/en/sub-agents#resume-subagents) |

### The same thing in the Agent SDK

[Resume subagents (SDK)](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents) documents a
three-step programmatic path: capture `session_id`, parse `agentId: <id>` from the Agent tool result text, then
issue a second `query()` with `resume: sessionId` and a prompt naming the agent. "You must resume the same
session to access the subagent's transcript. Each `query()` call starts a new session by default." When using a
custom agent, pass the same agent definition in `agents` for both queries.

### Reverse direction: subagent → parent

A subagent's initial context includes a "**Sibling roster**: a system reminder listing `main` and every other
named agent in the session, each a valid `to` value for `SendMessage`. Requires Claude Code v2.1.206 or later.
The roster appears only when the subagent's tools include `SendMessage` and at least one other agent has a
name" ([what loads at startup](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)). So a
subagent can message `main` mid-run rather than only via its final report.

**Documentation gap:** the docs state the conditions under which the *roster* appears, not whether `main`
remains addressable when the roster is absent (e.g. no other agent has a name). Treat "the subagent can reach
`main` without a roster" as unverified.

**Documentation gap:** nothing documents a subagent *blocking* on a reply. `SendMessage` delivery is
asynchronous ("messages enqueue and drain at the receiver's next tool round"). A request/response round-trip
initiated by the subagent is not a documented primitive; the documented shape is parent-driven — subagent
returns a report, parent sends the next message.

### Related but distinct mechanisms

- [Agent teams](https://code.claude.com/docs/en/agent-teams): separate Claude Code instances with a shared task
  list and mailboxes at `~/.claude/teams/{team}/inboxes/{agent}.json`. Teammates message each other directly.
  Higher token cost; "each teammate is a separate Claude instance."
- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging): messaging your *other*
  Claude Code sessions, on this machine or beyond.
- [Dynamic workflows](https://code.claude.com/docs/en/workflows): script-driven orchestration for "dozens to
  hundreds of agents." Note `Workflow` is stripped from subagents.
- Interactive steering: with a fork's or subagent's transcript open in `/tasks`, "follow-up messages and skills
  go to that agent" ([observe and steer](https://code.claude.com/docs/en/sub-agents#observe-and-steer-running-forks)) —
  a human path, not a programmatic one.

## 2. Subagent format

### Frontmatter (`.claude/agents/*.md`)

Only `name` and `description` are required.
Source: [supported frontmatter fields](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields).

| Field | Notes |
| --- | --- |
| `name` | Required. Lowercase + hyphens. Cannot contain `:` (reserved for plugin identifiers); such files are skipped with a debug-log error as of v2.1.218. Filename need not match |
| `description` | Required. When Claude should delegate |
| `tools` | Allowlist. Inherits all subagent-available tools if omitted |
| `disallowedTools` | Denylist, applied *before* `tools`. Accepts `mcp__<server>`, `mcp__<server>__*`, `mcp__*` |
| `model` | `sonnet`, `opus`, `haiku`, `fable`, full ID, or `inherit`. Defaults to `inherit` |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, or `manual` (alias for `default`, v2.1.200+) |
| `maxTurns` | Max agentic turns before the subagent stops |
| `skills` | Skills preloaded in full at startup |
| `mcpServers` | Named or inline MCP servers |
| `hooks` | Lifecycle hooks scoped to this subagent |
| `memory` | `user`, `project`, or `local` — persistent cross-session directory |
| `background` | `true` keeps it in the background even when Claude asks for the foreground |
| `effort` | `low`/`medium`/`high`/`xhigh`/`max` |
| `isolation` | `worktree` runs it in a temporary git worktree, branched from the default branch |
| `color` | Task-list display color |
| `initialPrompt` | Auto-submitted first user turn when the agent runs as the *main* session agent |

Plugin subagents ignore `hooks`, `mcpServers`, and `permissionMode` for security reasons.
The SDK's `AgentDefinition` mirrors this set with a required `prompt` field replacing the markdown body
([AgentDefinition](https://code.claude.com/docs/en/agent-sdk/subagents#agentdefinition-configuration)).

Files silently skipped: no `name`; a `name` starting with `-` or containing `:`; a `name` without a
`description`; unparseable YAML. Run with `--debug` to see why
([skipped files](https://code.claude.com/docs/en/sub-agents#subagent-files-claude-code-skips)).

### Scope and precedence

Managed settings > `--agents` CLI flag > `.claude/agents/` > `~/.claude/agents/` > plugin `agents/`
([choose the subagent scope](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)). Directories
are scanned recursively; identity comes only from `name`. Across nested project directories the definition
closest to the working directory wins (v2.1.178+). Duplicate names inside one directory resolve by filesystem
read order — undefined; `/doctor` reports them.

### Context isolation

A non-fork subagent's context contains only: its own system prompt, the Agent tool's delegation prompt, the
CLAUDE.md hierarchy (skipped by `Explore`/`Plan`), a git-status snapshot, preloaded skill content, and the
sibling roster. It does **not** get the parent's conversation history or tool results, the parent's system
prompt, the output style, auto memory, or the parent's context-window size
([what loads at startup](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)).

The SDK states the design constraint bluntly: "The only content you pass from parent to subagent is the Agent
tool's prompt string, so include any file paths, error messages, or decisions the subagent needs directly in
that prompt" ([what subagents inherit](https://code.claude.com/docs/en/agent-sdk/subagents#what-subagents-inherit)).

### What it returns

Only the final message. "The parent receives the subagent's final message as the Agent tool result, but may
summarize it in its own response. To preserve subagent output verbatim in the user-facing response, include an
instruction to do so in the prompt."

Since v2.1.210 the final report passes through
[output scanning](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning): backslashes inserted
into `<system-reminder>`-style tags and `Human:`/`Assistant:` turn markers, plus a
`[harness: subagent output matched instruction-shaped pattern(s):` marker line for control-tag or
permission-configuration matches. Nothing is removed or reworded. **Relevant here:** a subagent that returns a
transcript quoting a human will occasionally trip the turn-marker rule.

API errors are not returned as findings: as of v2.1.199, a foreground subagent cut off mid-run returns partial
output with a cut-off note, or fails with `Agent terminated early due to an API error`; a background one is
marked failed with the error named ([API errors](https://code.claude.com/docs/en/sub-agents#api-errors-in-subagents)).

### Can a subagent pause to ask a question? No — not the user.

`AskUserQuestion` is on the list of tools removed from **every** subagent, "even when listed in the `tools`
field" ([available tools](https://code.claude.com/docs/en/sub-agents#available-tools)). The SDK docs say it
outright: "**Subagents**: `AskUserQuestion` is not currently available in subagents spawned via the Agent tool"
([limitations](https://code.claude.com/docs/en/agent-sdk/user-input#limitations)). Also removed:
`EndConversation`, `EnterPlanMode`, `ExitPlanMode` (unless `permissionMode: plan`), `ScheduleWakeup`,
`TaskOutput`, `WaitForMcpServers`, `Workflow`, and `Agent` at the depth limit.

A subagent *can* message `main` with `SendMessage`, and it can end its turn with a report containing questions.
Both are documented. Blocking-until-answered is not.

### Background is the default, and it narrows the toolset

Two behavior changes matter for orchestration:

- Since v2.1.198 subagents run in the background by default; Claude sets `run_in_background: false` "when it
  needs the result before continuing" ([SDK](https://code.claude.com/docs/en/agent-sdk/subagents#agentdefinition-configuration)).
- [Fork mode](https://code.claude.com/docs/en/sub-agents#turn-fork-mode-on-or-off) is on by default in
  interactive sessions (v2.1.232+); where it is on, "Claude Code runs the subagents Claude spawns in the
  background... and Claude can't ask for the foreground." Fork mode is off by default with `-p` and in the SDK.

A **background** subagent keeps every MCP tool but only these built-ins: `Read`, `Grep`, `Glob`, `Bash`,
`PowerShell`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`,
`EnterWorktree`, `ExitWorktree`, `Monitor`, `TaskStop`, `SendMessage`, and `Artifact`
([available tools](https://code.claude.com/docs/en/sub-agents#available-tools)). `SendMessage` survives, so
background Q&A works; `ListAgents` does not.

## 3. Skill format

### Frontmatter

Source: [frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference). "All fields are
optional. Only `description` is recommended." Booleans accept `yes`/`no`/`on`/`off`/`1`/`0` since v2.1.218.

| Field | Honored where | Notes |
| --- | --- | --- |
| `name` | Spec + Claude Code | In personal/project skills it is only the **display label**; the command name comes from the directory. In plugin skills it sets the last command segment |
| `description` | Spec + Claude Code | Falls back to the first paragraph of the body |
| `license` | Spec + Claude Code | "Claude Code accepts the field but doesn't act on it" |
| `compatibility` | Spec + Claude Code | Max 500 chars; accepted but not acted on by Claude Code |
| `metadata` | Spec + Claude Code | Free-form map; Claude Code drops a non-map value |
| `allowed-tools` | Spec (experimental) + Claude Code CLI | **Not** honored for project/personal skills in SDK sessions — use the `allowedTools` option instead ([SDK skills](https://code.claude.com/docs/en/agent-sdk/skills#pre-approve-tools-for-skills)) |
| `when_to_use` | Claude Code only | Appended to `description` in the listing |
| `argument-hint`, `arguments` | Claude Code only | Autocomplete hint; named positional args for `$name` substitution |
| `disable-model-invocation` | Claude Code only | Only you can invoke. Also blocks preloading into subagents and scheduled-task firing (v2.1.196+) |
| `user-invocable` | Claude Code only | `false` = only Claude can invoke |
| `disallowed-tools` | Claude Code only | Removes tools while the skill is active; clears at your next message |
| `model`, `effort` | Claude Code only | Apply for the rest of the current turn; not saved to settings |
| `context` | Claude Code only | `fork` runs the skill in a subagent |
| `agent` | Claude Code only | Which subagent type when `context: fork`; defaults to `general-purpose` |
| `background` | Claude Code only | Only with `context: fork`; default `true` (v2.1.218+) |
| `hooks` | Claude Code only | Registered on invoke, kept for the session |
| `paths` | Claude Code only | Globs limiting auto-activation |
| `shell` | Claude Code only | `bash` (default) or `powershell` for `!` injection |

**Claude Code-specific vs portable.** claude.ai uploads, the Skills API, and `package_skill.py` accept only the
six spec fields — `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` — and fail
hard on anything else: `Unexpected key(s) in SKILL.md frontmatter: argument-hint. Allowed properties are:
allowed-tools, compatibility, description, license, metadata, name`
([using skill frontmatter outside Claude Code](https://code.claude.com/docs/en/skills#using-skill-frontmatter-outside-claude-code)).

Note `model` is **not** a spec field and is not honored outside Claude Code.

### Limits

| Limit | Value | Source |
| --- | --- | --- |
| `name` | 1–64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens, must match the parent directory name | [spec](https://agentskills.io/specification) |
| `description` | 1–1024 chars, non-empty | [spec](https://agentskills.io/specification) |
| Listing truncation | "the combined `description` and `when_to_use` text is truncated at 1,536 characters in the skill listing" | [frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference) |
| API `name` | Max 64 chars; no XML tags; reserved words "anthropic"/"claude" rejected | [Skills API guide](https://platform.claude.com/docs/en/api/skills-guide) |
| API `display_name` | Optional, max 255 chars | [Skills API guide](https://platform.claude.com/docs/en/api/skills-guide) |
| API upload | Under 30 MB uncompressed; `SKILL.md` at the upload root | [Skills API guide](https://platform.claude.com/docs/en/api/skills-guide) |
| API per request | Up to 20 skills via `container.skills`; requires the code execution tool | [Skills API guide](https://platform.claude.com/docs/en/api/skills-guide) |
| Body length | "Keep `SKILL.md` under 500 lines" (both Claude Code and the spec) | [add supporting files](https://code.claude.com/docs/en/skills#add-supporting-files), [spec](https://agentskills.io/specification) |

### Progressive disclosure

The [spec](https://agentskills.io/specification) gives three levels with budgets:

1. **Metadata** (~100 tokens): `name` + `description` loaded at startup for all skills.
2. **Instructions** (< 5000 tokens recommended): the full `SKILL.md` body, loaded on activation.
3. **Resources** (as needed): files under `scripts/`, `references/`, `assets/`.

Conventions: relative paths from the skill root; "Keep file references one level deep from `SKILL.md`. Avoid
deeply nested reference chains." The engineering post frames the payoff as "the amount of context that can be
bundled into a skill is effectively unbounded"
([Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)).

### Locations and precedence

| Location | Path |
| --- | --- |
| Enterprise | [managed settings](https://code.claude.com/docs/en/managed-settings) |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` |
| Project | `.claude/skills/<skill-name>/SKILL.md` |
| Plugin | `<plugin>/skills/<skill-name>/SKILL.md` |

"Across levels, enterprise overrides personal, and personal overrides project." **This inverts the subagent
ordering** — for subagents, project beats personal; for skills, personal beats project
([where skills live](https://code.claude.com/docs/en/skills#where-skills-live)). Plugin skills are namespaced
`plugin-name:skill-name` and cannot conflict. A skill beats a same-named `.claude/commands/` file, and any
local skill beats a claude.ai-synced one. Nested `.claude/skills/` below the working directory load lazily —
"the first time Claude reads or edits a file inside that subdirectory" — and appear under a directory-qualified
name such as `apps/web:deploy`.

### Content lifecycle — the part that bites multi-round skills

From [skill content lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle):

- "the rendered `SKILL.md` content enters the conversation as a single message and stays there for the rest of
  the session... **Claude Code does not re-read the skill file on later turns, so write guidance that should
  apply throughout a task as standing instructions rather than one-time steps.**"
- Re-invoking with identical rendered content adds a short "already loaded" note instead of a second copy.
- After auto-compaction, the most recent invocation of each skill is re-attached, keeping the first 5,000
  tokens each, against a combined 25,000-token budget across all re-attached skills.
- `allowed-tools` "grants permission for the listed tools during the turn that invokes the skill... The grant
  clears when you send your next message." For an interview loop, every human answer ends the grant. Use
  permission settings for anything that must survive the loop.

## 4. Skill vs subagent, and scoping a skill to a subagent

### When to use which

[Skill vs Subagent](https://code.claude.com/docs/en/features-overview#compare-similar-features): "**Skills**
are reusable content you can load into any context. **Subagents** are isolated workers that run separately from
your main conversation." Use a subagent "when you need context isolation or when your context window is getting
full."

[Choose between subagents and main conversation](https://code.claude.com/docs/en/sub-agents#choose-between-subagents-and-main-conversation)
says to use the **main conversation** when "the task needs frequent back-and-forth or iterative refinement" and
adds: "Consider Skills instead when you want reusable prompts or workflows that run in the main conversation
context rather than isolated subagent context." That is the direct doctrinal support for keeping an interview
loop on the main thread.

The Anthropic blog frames it as visibility: "Use a subagent when a side task like deep search, a log analysis
pass, or a dependency audit would clutter your main conversation with intermediate results you won't reference
again"
([Steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more)).

### Yes, a skill can be scoped to a subagent — in both directions

[Run skills in a subagent](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent) documents the pair:

| Approach | System prompt | Task | Also loads |
| --- | --- | --- | --- |
| Skill with `context: fork` | From agent type | SKILL.md content | CLAUDE.md, except when the agent is Explore or Plan |
| Subagent with `skills` field | Subagent's markdown body | Claude's delegation message | Preloaded skills + CLAUDE.md |

`context: fork` details:

- "The skill content becomes the prompt that drives the subagent. It won't have access to your conversation history."
- `agent:` picks the type — built-in `Explore`, `Plan`, `general-purpose`, or any `.claude/agents/` subagent.
  Omitted means `general-purpose`.
- Runs in the background by default; `background: false` waits in the invoking turn (v2.1.218+). Claude Code
  waits regardless in `-p`/SDK sessions, with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, when an earlier run of
  the same skill is still going, or when a scheduled task fires it.
- Warning from the docs: "`context: fork` only makes sense for skills with explicit instructions. If your skill
  contains guidelines like 'use these API conventions' without a task, the subagent receives the guidelines but
  no actionable prompt, and returns without meaningful output."
- A backgrounded fork gets the narrower background toolset; `background: false` restores the full set.
- Background fork edits fall outside session checkpoints, so `/rewind` will not undo them.

`skills:` preload details ([preload skills](https://code.claude.com/docs/en/sub-agents#preload-skills-into-subagents)):
full content injected at startup; the subagent can still invoke unlisted skills through the `Skill` tool;
skills with `disable-model-invocation: true` cannot be preloaded; a missing skill logs a warning. To block skill
use entirely, omit `Skill` from `tools` or add it to `disallowedTools`.

Caveat for the teams path: "The `skills` and `mcpServers` frontmatter fields in a subagent definition are not
applied when that definition runs as a teammate"
([agent teams](https://code.claude.com/docs/en/agent-teams#use-subagent-definitions-for-teammates)).

## 5. Answering on behalf of a human, and when to escalate

### Persona / principles corpus — no first-party guidance for the specific case

**Documentation gap.** There is no Anthropic first-party guidance on prompting a model to answer *as a specific
named human* from a written persona or principles corpus. Nothing in the Claude Code, Agent SDK, or prompt
engineering docs addresses proxying an individual. Treat any such design as unsupported by documentation.

The adjacent, genuinely first-party material is generic role/character prompting:

- [Give Claude a role](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#give-claude-a-role):
  "Setting a role in the system prompt focuses Claude's behavior and tone for your use case. Even a single
  sentence makes a difference."
- [Keep Claude in character](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency):
  "Use system prompts to set the role... When setting up the character, provide detailed information about the
  personality, background, and any specific traits or quirks. This helps the model better emulate and
  generalize the character's traits." And: "Prepare Claude for possible scenarios: Provide a list of common
  scenarios and expected responses in your prompts. This 'trains' Claude to handle diverse situations without
  breaking character."
- Same page, [use retrieval for contextual consistency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency):
  ground responses in a fixed information set and have the model cite which entry it used. This is the closest
  documented analogue to answering from a principles corpus — it is a retrieval-grounding technique, not a
  persona technique.
- [Constrain with examples](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency):
  "Provide examples of your desired output. This is more effective than abstract instructions."

### When to escalate to a human — documented

- Opus 5 task scoping ([prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)):
  "Make routine judgment calls yourself, and check in only when different readings of the request would lead to
  materially different work. If the request seems mistaken or a better approach exists, say so in a sentence
  and continue with the task as asked."
- Reversibility test ([balancing autonomy and safety](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#balancing-autonomy-and-safety)):
  "You are encouraged to take local, reversible actions like editing files or running tests, but for actions
  that are hard to reverse, affect shared systems, or could be destructive, ask the user before proceeding."
- Agent design ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)):
  agents can "pause for human feedback at checkpoints or when encountering blockers"; "it's also common to
  include stopping conditions (such as a maximum number of iterations) to maintain control"; "human review
  remains crucial for ensuring solutions align with broader system requirements."
- Interview pattern ([Let Claude interview you](https://code.claude.com/docs/en/best-practices#let-claude-interview-you)):
  the documented recipe is "Interview me in detail using the AskUserQuestion tool... Keep interviewing until
  we've covered everything, then write a complete spec to SPEC.md." Then start a fresh session to execute.
- `AskUserQuestion` mechanics: "each `AskUserQuestion` call supports 1-4 questions with 2-4 options each"
  ([SDK limitations](https://code.claude.com/docs/en/agent-sdk/user-input#limitations)). Questions stay open
  until answered unless `askUserQuestionTimeout` is set to `60s`/`5m`/`10m`; on timeout it "submits any options
  you'd already selected and tells Claude you may be away from your keyboard"
  ([AskUserQuestion behavior](https://code.claude.com/docs/en/tools-reference#askuserquestion-tool-behavior)).
  Clarifying questions are "especially common in plan mode."
- Delegation damping, if the skill should *not* fan out: the documented prompt is "Delegate to a subagent only
  for large tasks that are genuinely independent and parallelizable... Do not delegate work you can finish
  yourself in a handful of tool calls, and do not use subagents to verify or double-check your own work."
  Deterministic caps are `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
  (default 20), and the SDK's `max_budget_usd`
  ([cap subagent depth, concurrency, and spend](https://code.claude.com/docs/en/agent-sdk/subagents#cap-subagent-depth-concurrency-and-spend)).
- Delegation prompt quality ([multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)):
  "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task
  boundaries."

## Where the documentation is silent or contradictory

| Question | Status |
| --- | --- |
| Max number of resume rounds for one subagent | **Silent.** Only `maxTurns` (agentic turns per run) and concurrency/depth/spend caps are documented |
| Whether a subagent can block waiting for a `SendMessage` reply | **Silent.** Delivery is described as enqueued and drained at the receiver's next tool round; no request/response primitive is documented |
| Whether `main` is a valid `SendMessage` target when the sibling roster is absent | **Silent.** Docs give the roster's appearance conditions, not the target's validity |
| Whether preloaded `skills` content survives subagent auto-compaction | **Silent.** Compaction is documented for subagents; skill re-attachment budgets are documented only for the main conversation |
| Skill vs subagent precedence ordering | **Contradictory-looking but real:** subagents are project > personal; skills are personal > project. Both are stated explicitly on their own pages |
| Answering as a specific human from a persona corpus | **Silent.** No first-party guidance exists |

## Applying this to a Q&A-orchestrating skill

Documented pieces, assembled:

1. Skill lives at `.claude/skills/<name>/SKILL.md`, no `context: fork`, so it runs on the main thread and keeps
   `AskUserQuestion`. Set `disable-model-invocation: true` if it should only start when the human types `/<name>`.
2. Body written as standing instructions describing the whole loop, under 500 lines, with the long persona or
   principles corpus in sibling files referenced one level deep (progressive disclosure level 3).
3. Round 1: spawn a custom subagent (or `general-purpose`) with everything it needs in the Agent prompt —
   nothing else crosses the boundary. Let Claude name it so later sends can address it by name; keep the agent
   ID as the collision-proof address.
4. The subagent returns a report ending with its questions. It cannot ask the human itself.
5. The skill asks the human with `AskUserQuestion` (1–4 questions, 2–4 options each).
6. Round N: `SendMessage` to the agent's name/ID. It auto-resumes with full prior context; as of v2.1.198 it
   reads the message as ordinary task direction.
7. Repeat. No documented round cap. Watch subagent auto-compaction on long interviews and the fresh
   concurrency slot each resume consumes.

Two inferences, flagged as such:

- **Inferred:** because `allowed-tools` clears at every user message and an interview is many user messages,
  durable pre-approval belongs in permission settings rather than skill frontmatter. The two facts are
  documented; the conclusion is mine.
- **Inferred:** because the parent needs each round's answer before asking the human, the Agent tool's
  `run_in_background: false` is the right call for the initial spawn where fork mode permits it — but under
  interactive fork mode "Claude can't ask for the foreground," so the loop must tolerate background completion
  notifications. The constraint is documented; the design consequence is mine.

## Sources

Claude Code: [sub-agents](https://code.claude.com/docs/en/sub-agents) ·
[skills](https://code.claude.com/docs/en/skills) ·
[tools reference](https://code.claude.com/docs/en/tools-reference) ·
[agent teams](https://code.claude.com/docs/en/agent-teams) ·
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) ·
[features overview](https://code.claude.com/docs/en/features-overview) ·
[best practices](https://code.claude.com/docs/en/best-practices)

Agent SDK: [subagents](https://code.claude.com/docs/en/agent-sdk/subagents) ·
[skills](https://code.claude.com/docs/en/agent-sdk/skills) ·
[approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)

API / prompt engineering: [Skills API guide](https://platform.claude.com/docs/en/api/skills-guide) ·
[prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) ·
[prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) ·
[increase output consistency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency)

Spec and engineering: [Agent Skills specification](https://agentskills.io/specification) ·
[anthropics/skills](https://github.com/anthropics/skills) ·
[Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) ·
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) ·
[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ·
[Steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more)
