# Harness model selection for subagents, and two run-speed questions

Date: 2026-09-23.

**Scope and method.** Six questions, answered against primary sources only: vendor docs, the
harness's own source, and first-party changelogs. Claude Code claims come from
`code.claude.com/docs/en/*` and the [claude-code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
Codex claims come from the official docs at `developers.openai.com/codex/*` and the vendored
checkout `.repos/codex` at `4aa52f2` (2026-08-24); code citations are `path:line` into that
checkout. Cursor claims come from `cursor.com/docs/*`. pre-commit claims come from
[pre-commit.com](https://pre-commit.com/) and the `pre-commit/pre-commit` source on GitHub
(`main` as of this date). Agent-loop guidance comes from Anthropic's engineering blog and
OpenAI's Agents SDK docs and examples. Inference is marked **(inference)**.

---

## TL;DR

1. **Claude Code** subagent `model` accepts the family aliases `sonnet`, `opus`, `haiku`,
   `fable`, a full model ID (same values as `--model`), or `inherit`; omitting it falls
   through per-invocation parameter → frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` → main
   conversation's model. An unavailable model is survivable only when a **fallback model
   chain** (`fallbackModel` / `--fallback-model`) is configured; otherwise the subagent ends
   on the API error.
2. **Codex CLI** has a real, stable multi-agent feature (`features.multi_agent`, on by
   default) with built-in roles `default`, `worker`, `explorer`, custom agents as TOML files
   in `~/.codex/agents/` / `.codex/agents/`, and per-role `model` +
   `model_reasoning_effort`. A spawn naming a model outside the account's model list fails
   with `Unknown model … Available models: …`; a role whose config can't apply fails with
   `agent type is currently not available`. The "4-agent limit" is the hardcoded V2 default
   `max_concurrent_threads_per_session = 4`.
3. **Cursor** subagents are Markdown files in `.cursor/agents/` (plus `.claude/agents/` and
   `.codex/agents/` read for compatibility); `model` is `inherit` (the default) or an exact
   Cursor model ID, optionally with bracket parameters like `[effort=high]`. A blocked or
   plan-unavailable model silently falls back to "a compatible model".
4. **There is no cross-harness tier vocabulary.** Family aliases (`haiku`) are Claude
   Code-only; Codex and Cursor require exact vendor slugs. The only portable convention is
   **omitting the `model` field**, which in all three harnesses runs the subagent on the
   parent/session model.
5. **pre-commit**: `PRE_COMMIT_HOME` relocates the whole repository store (default
   `~/.cache/pre-commit`, or `$XDG_CACHE_HOME/pre-commit`). It is environment-only; the
   `.pre-commit-config.yaml` schema has **no** cache-location key, so `pre-commit run`
   cannot be pointed at a per-repo cache from config.
6. **Bounded review loops**: Anthropic recommends max-iteration stopping conditions as a
   normal part of agent design and reserves the evaluator-optimizer loop for tasks with
   clear evaluation criteria where iteration measurably helps. OpenAI's SDK ships a
   `max_turns` limit that raises `MaxTurnsExceeded`, and its own LLM-as-judge example caps
   rounds and instructs the judge to "not go for perfection".

---

# Question 1 — Claude Code subagent `model`

## Valid values

The subagent frontmatter reference defines `model` as: "Model to use: `sonnet`, `opus`,
`haiku`, `fable`, a full model ID such as `claude-opus-5-5`, or `inherit`. When you omit it,
Claude Code picks the model in the subagent model order"
([supported frontmatter fields](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields)).
The [Choose a model](https://code.claude.com/docs/en/sub-agents) section adds that a full
model ID "accepts the same values as the `--model` flag".

Two session-level aliases do **not** appear in the subagent list: `default` (clears the
override) and `best` (Fable where available, else Opus) are documented only for the main
`model` setting ([model aliases](https://code.claude.com/docs/en/model-config)). What each
alias resolves to is provider-dependent and updates over time; pin with a full model ID or
`ANTHROPIC_DEFAULT_OPUS_MODEL`-style variables
([model config](https://code.claude.com/docs/en/model-config)).

## Resolution order and overrides

Claude Code resolves a subagent's model in this order
([Choose a model](https://code.claude.com/docs/en/sub-agents)):

1. The **per-invocation `model` parameter** Claude passes on the Agent tool call. It also
   sticks across resumes (v2.1.211+).
2. The definition's **`model` frontmatter**, where `inherit` selects the main conversation's
   model.
3. The **`CLAUDE_CODE_SUBAGENT_MODEL`** environment variable.
4. The **main conversation's model**.

Two wrinkles, both documented on the same page:

- A **family alias resolves to the main conversation's exact model** when the main model
  belongs to that family (including any `[1m]` suffix), so the subagent keeps the extended
  context window. An alias in `CLAUDE_CODE_SUBAGENT_MODEL` always resolves to the version
  the alias points to.
- The environment variable is only a *default*. To force one model onto every subagent, set
  **`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`** as well (v2.1.257+;
  [Run every subagent on one model](https://code.claude.com/docs/en/sub-agents)). Before
  v2.1.251 the variable overrode everything including `model: inherit` — the
  [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) records the
  flip: "Changed `CLAUDE_CODE_SUBAGENT_MODEL` to set the default subagent model rather than
  override everything."

Subagents can also be defined ad hoc with the `--agents` JSON flag, which accepts the same
`model` field ([sub-agents page](https://code.claude.com/docs/en/sub-agents)). The built-in
Explore agent inherits the main model (capped at Opus on the Claude API); a user-defined
subagent named `Explore` with `model: haiku` overrides it
([built-in subagents](https://code.claude.com/docs/en/sub-agents)).

## When the model is unavailable

Three distinct mechanisms, no single answer:

| Situation | Behavior | Source |
| --- | --- | --- |
| Model blocked by an org `availableModels` allowlist | The subagent **runs on a fallback model rather than failing**; interactive sessions show a warning naming requested and substituted models. A blocked family alias substitutes the newest permitted version of the family instead | [model config](https://code.claude.com/docs/en/model-config) |
| Model rejected by the API at call time (404, overload, non-retryable server error) | With a **fallback model chain** configured, "Claude Code switches the subagent to the first model in the chain that accepts the request. The subagent keeps working instead of ending on the error" (v2.1.247+). Chains come from `--fallback-model` or the `fallbackModel` settings array, max three entries | [subagent API errors](https://code.claude.com/docs/en/sub-agents), [fallback model chains](https://code.claude.com/docs/en/model-config) |
| No chain configured | The subagent's run **ends on the API error** and the failure is reported to Claude (partial output is preserved with a cut-off note; a subagent with no text output fails with `Agent terminated early due to an API error`) | [subagent API errors](https://code.claude.com/docs/en/sub-agents) |

The changelog confirms the 404 case explicitly: "Fixed sub-agents dying on a first-call
model 404: they now use the session's fallback model chain, and the error returned to the
parent includes the error type, status, request id, and model"
([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).

---

# Question 2 — Codex CLI subagents and per-role models

## The feature exists and is stable

Codex has first-party subagents. The docs call the feature "subagent workflows":
`features.multi_agent` enables "multi-agent collaboration tools (`spawn_agent`,
`send_input`, `resume_agent`, `wait_agent`, and `close_agent`) (stable; on by default)"
([config reference](https://developers.openai.com/codex/config-reference)). The dedicated
[Subagents page](https://developers.openai.com/codex/multi-agent) documents the whole
feature. In the vendored source the V2 collaboration tools are `spawn_agent`,
`followup_task`, `send_message`, `wait_agent`, `interrupt_agent`, and `list_agents`
(`.repos/codex/codex-rs/core/src/session/multi_agents.rs:55`) — the docs and the
checkout's tool names differ slightly because the checkout is a month older than the live
docs **(inference)**.

Built-in roles are `default` (general-purpose fallback), `worker` (execution), and
`explorer` (read-heavy exploration) — both
[documented](https://developers.openai.com/codex/multi-agent) and hardcoded
(`.repos/codex/codex-rs/core/src/agent/role.rs:355-394`).

## How per-role models are configured

Three layers, resolved in a documented order
([Subagents → Custom agents](https://developers.openai.com/codex/multi-agent)):

1. **Explicit spawn value.** `spawn_agent` takes optional `model` and `reasoning_effort`
   arguments (`.repos/codex/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:270-281`).
2. **`[agents]` defaults in `config.toml`**: `agents.default_subagent_model` and
   `agents.default_subagent_reasoning_effort` ("An explicit spawn model takes precedence",
   [config reference](https://developers.openai.com/codex/config-reference); struct at
   `.repos/codex/codex-rs/config/src/config_toml.rs:667`).
3. **The parent's model.** "If you don't configure a subagent model or
   `model_reasoning_effort`, the subagent inherits the parent agent's model and reasoning
   effort" ([Subagents](https://developers.openai.com/codex/multi-agent)).

On top of that, a **custom agent file wins over the resolved value**: "If a custom agent
file sets `model` or `model_reasoning_effort`, the value in the file takes precedence"
([Subagents → Custom agents](https://developers.openai.com/codex/multi-agent)). Custom
agents are standalone TOML files in `~/.codex/agents/` (personal) or `.codex/agents/`
(project) with required `name`, `description`, and `developer_instructions`, plus any
supported `config.toml` keys such as `model`, `model_reasoning_effort`, `sandbox_mode`,
`mcp_servers`, and `skills.config`. Roles can also be declared inline as `[agents.<role>]`
tables with `description`, `config_file` (a role-specific config layer), and
`nickname_candidates` (`.repos/codex/codex-rs/config/src/config_toml.rs:690-717`). Codex
applies a role by loading its config file as a bounded override layer — `model`,
`model_reasoning_effort`, `developer_instructions`, and a few others; "Roles may customize
the child or reduce its capabilities, but never replace the parent session's authority"
(`.repos/codex/codex-rs/core/src/agent/role.rs:1-4,80-89`).

One constraint worth knowing for orchestration: **full-history forks inherit the parent
model and do not accept overrides**. The usage hint injected into the model says "Full-history
forks (`fork_turns` omitted or `\"all\"`) inherit the parent model and reasoning effort and
do not accept overrides … set `fork_turns` to `\"none\"` or a positive integer string"
(`.repos/codex/codex-rs/core/src/session/multi_agents.rs:50`). So a model-overridden
subagent is necessarily a fresh-context ("isolated") agent — this is the mechanism behind
the "isolated fallback agents" phrasing seen in runs **(inference)**.

## Models, and what happens when one is not available to the account

The [Models page](https://developers.openai.com/codex/models) recommends `gpt-6-sol` for
demanding agents and `gpt-6-luna` for "fast, narrowly scoped agents handling clear,
repeatable, or high-volume work", with `gpt-6-astra` above both; older `gpt-5.x` models are
in various stages of retirement, and Codex can also "point … at any model and provider that
supports either the Chat Completions or Responses APIs" via `model_providers`.

When a spawn requests a model, Codex resolves it against the **account's model list**
(`models_manager.list_models`) filtered to models supporting the active multi-agent
backend. A miss fails the tool call with a message returned to the model:

> `Unknown model `{requested_model}` for spawn_agent. Available models: {available}`

(`.repos/codex/codex-rs/core/src/tools/handlers/multi_agents_common.rs:416-440`, reached
from `apply_requested_spawn_agent_model_overrides` at `:263-307`). A requested
`reasoning_effort` is validated against the selected model's supported levels the same way
(`multi_agents_common.rs:443-453`). Separately, a role whose config layer fails to apply
returns the fixed string `agent type is currently not available`
(`.repos/codex/codex-rs/core/src/agent/role.rs:34,60-66`).

Both errors are `RespondToModel` — Codex hands them to the LLM and the LLM decides what to
do next, typically re-spawning without the role or model override. The run transcript
language quoted in the research brief ("Code-simplifier role unavailable in this account
(unsupported model)", "isolated fallback agents") is the model's own paraphrase of these
tool errors, not a string in the codebase — neither phrase appears in the checkout
**(inference, checked by search over `.repos/codex`)**.

## The "4-agent limit"

The V2 multi-agent backend defaults to **4 concurrently open agent threads per session**:
`DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION: usize = 4`
(`.repos/codex/codex-rs/core/src/config/mod.rs:226`). The spawn tool guidance tells the
model how many slots exist: "There are {max_concurrency} available concurrency slots,
meaning that up to {max_concurrency} agents can be active at once, including you"
(`.repos/codex/codex-rs/core/src/session/multi_agents.rs:117`). It is configurable via
`agents.max_concurrent_threads_per_session` (legacy alias `agents.max_threads`), documented
as "Maximum number of spawned-agent threads that can be open concurrently, excluding the
primary thread. When unset, Codex chooses the default"
([config reference](https://developers.openai.com/codex/config-reference)).

---

# Question 3 — Cursor subagents and per-subagent models

## Definition files

All from the [Subagents docs](https://cursor.com/docs/agent/subagents):

| Scope | Locations |
| --- | --- |
| Project | `.cursor/agents/`, plus `.claude/agents/` and `.codex/agents/` "(Claude compatibility)" / "(Codex compatibility)" |
| User | `~/.cursor/agents/`, plus `~/.claude/agents/` and `~/.codex/agents/` |

"Project subagents take precedence when names conflict. When multiple locations contain
subagents with the same name, `.cursor/` takes precedence over `.claude/` or `.codex/`."

Each subagent is a Markdown file with YAML frontmatter. The documented fields are `name`,
`description`, `model` (default `inherit`), `readonly`, and `is_background` — all optional.

## Model values

The `model` field takes exactly two kinds of value
([model configuration](https://cursor.com/docs/agent/subagents#model-configuration)):

- **`inherit`** — "Uses the same model as the parent agent. This is the default."
- **A specific model ID** — "the exact model you specify, such as `composer-2` or
  `gpt-5.6-sol`. See the models reference for available IDs." The models reference is
  [cursor.com/docs/models](https://cursor.com/docs/models), which lists the current lineup
  (Composer 2.5, Grok 4.5–4.7, Claude Sonnet/Opus/Fable, GPT-5.x/5.6 Sol/Terra/Luna,
  Gemini, Kimi, Muse Spark, …). There are no tier aliases — no `haiku`-style keywords.

Model IDs accept **bracket parameters**: `composer-2.5[fast=false]`,
`claude-opus-5[effort=high]`, `claude-opus-5[context=300k]`, and combinations; empty
brackets pin the standard (non-fast) variant. "Available options depend on the model, and
use the same `id=value` pairs as the SDK's model parameters"
([model parameters](https://cursor.com/docs/agent/subagents#model-parameters)).

## When the configured model won't be used

Cursor overrides the frontmatter model in three documented cases: team-admin restrictions,
the legacy Max Mode requirement on request-based plans, and "Plan limitations — The model
isn't available on your current plan." In these cases "Cursor falls back to a compatible
model" ([when the configured model won't be used](https://cursor.com/docs/agent/subagents#when-the-configured-model-wont-be-used)).
The FAQ adds the concrete legacy rule: "On legacy request-based plans without Max Mode,
subagents run using Composer regardless of any `model` configuration … On usage-based plans
and legacy request-based plans with Max Mode, subagents default to the parent model"
([FAQ](https://cursor.com/docs/agent/subagents)). There is no documented error surfaced to
the run — the fallback is silent apart from "unexpected model behavior".

---

# Question 4 — Is there a portable "cheap model for this role" convention?

**No.** Each harness expresses model tiers in its own vocabulary, and none of them accepts
another's:

| Intent | Claude Code | Codex CLI | Cursor |
| --- | --- | --- | --- |
| Small / cheap | `model: haiku` (alias) | `model = "gpt-6-luna"` (exact slug; docs recommend Luna for "fast, narrowly scoped agents") | `model: composer-2.5` or another cheap exact ID |
| Default / same as parent | `model: inherit`, or omit the field | Omit `model` ("the subagent inherits the parent agent's model and reasoning effort") | `model: inherit`, or omit the field (default is `inherit`) |
| Deep reasoning | `model: opus` / `model: fable`, plus per-agent `effort: high…max` frontmatter | `model = "gpt-6-sol"` or `"gpt-6-astra"` with `model_reasoning_effort = "high"`/`"xhigh"`/`"max"` | `model: claude-opus-5[effort=high]`-style bracket params |

Sources: [Claude Code frontmatter](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields),
[Codex Subagents](https://developers.openai.com/codex/multi-agent),
[Cursor model configuration](https://cursor.com/docs/agent/subagents#model-configuration).

Observations that matter for cogwork:

- **Family aliases are Claude-only.** `haiku`/`sonnet`/`opus`/`fable` mean nothing to Codex
  (its spawn validation matches exact slugs from the account's model list,
  `.repos/codex/codex-rs/core/src/tools/handlers/multi_agents_common.rs:416-427`) and are
  not documented values for Cursor's `model` field.
- **Reasoning effort is the second axis** and each harness spells it differently: Claude
  Code has per-agent `effort` frontmatter (`low`→`max`), Codex has
  `model_reasoning_effort` (`low`→`ultra`), Cursor has `[effort=…]` bracket params. Codex's
  own docs frame "cheap vs deep" primarily as a model-slug-plus-effort choice, not a tier
  keyword ([Subagents → Choosing models and reasoning](https://developers.openai.com/codex/multi-agent)).
- **The one convergence point is file discovery, not vocabulary**: Cursor reads
  `.claude/agents/` and `.codex/agents/` definitions
  ([file locations](https://cursor.com/docs/agent/subagents)), but a `model: haiku` value in
  a shared `.claude/agents/*.md` file is only documented to work in Claude Code; Cursor
  documents `inherit` or exact IDs. Sharing a file across harnesses therefore only works
  cleanly when the `model` field is `inherit` or absent **(inference from the three docs)**.

**The least common denominator is omission.** All three harnesses run a subagent on the
parent/session model when no model is assigned: Claude Code's subagent model order ends at
"the main conversation's model" ([Choose a model](https://code.claude.com/docs/en/sub-agents)),
Codex inherits the parent absent a spawn value or `[agents]` default
([Subagents](https://developers.openai.com/codex/multi-agent)), and Cursor's default is
`inherit` ([configuration fields](https://cursor.com/docs/agent/subagents)). An explicit
`inherit` keyword exists in Claude Code and Cursor but not in Codex, where inheritance is
expressed only by omission. Anything cheaper or deeper than the parent model must be
written per-harness.

---

# Question 5 — pre-commit cache in sandboxes

All claims from [pre-commit.com](https://pre-commit.com/#managing-ci-caches) and the
`pre-commit/pre-commit` source.

- **What `PRE_COMMIT_HOME` controls.** The location of pre-commit's repository store — the
  cache of cloned and installed hook repositories (and installed language environments;
  e.g. Rust hook binaries are "stored in your pre-commit cache",
  [supported languages](https://pre-commit.com/#rust)). The store also holds `pre-commit.log`.
- **Default location.** "`pre-commit` by default places its repository store in
  `~/.cache/pre-commit`". Resolution order in code: `PRE_COMMIT_HOME` if set, else
  `$XDG_CACHE_HOME/pre-commit` if `XDG_CACHE_HOME` is set, else `~/.cache/pre-commit`
  ([`pre_commit/store.py`, `_get_default_directory`](https://github.com/pre-commit/pre-commit/blob/main/pre_commit/store.py)).
- **Recommended relocation.** Set the environment variable. The docs' own CI examples do
  exactly this when `$HOME` isn't a good cache home: Azure Pipelines sets
  `PRE_COMMIT_HOME: $(Pipeline.Workspace)/pre-commit-cache` and GitLab CI sets
  `PRE_COMMIT_HOME: ${CI_PROJECT_DIR}/.cache/pre-commit`
  ([Managing CI caches](https://pre-commit.com/#managing-ci-caches)). The docs also note the
  cache "requires to be served from a constant location between the different builds" —
  keys embed absolute paths, so a moving cache directory breaks reuse.
- **No per-repo cache config.** `.pre-commit-config.yaml`'s top-level schema accepts only
  `repos`, `default_install_hook_types`, `default_language_version`, `default_stages`,
  `files`, `exclude`, `fail_fast`, and `minimum_pre_commit_version`, and warns on additional
  keys ([`pre_commit/clientlib.py`, `CONFIG_SCHEMA`](https://github.com/pre-commit/pre-commit/blob/main/pre_commit/clientlib.py)).
  `pre-commit run` therefore always uses the process-environment-resolved store; the only
  per-invocation control is exporting `PRE_COMMIT_HOME` for the command. Maintenance of the
  store is via `pre-commit clean` (wipe) and `pre-commit gc` (drop unused repos)
  ([cli docs](https://pre-commit.com/#pre-commit-gc)).

For cogwork's sandboxed runs this means: export `PRE_COMMIT_HOME` to a writable, **stable**
path in the run environment; there is nothing to commit into the repo to achieve the same
effect.

---

# Question 6 — What the vendors say about bounded review loops

## Anthropic — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

- **Bound iterations by default.** On agents generally: "The task often terminates upon
  completion, but it's also common to include stopping conditions (such as a maximum number
  of iterations) to maintain control."
- **The evaluator-optimizer workflow is conditional, not default.** "One LLM call generates
  a response while another provides evaluation and feedback in a loop … particularly
  effective when we have clear evaluation criteria, and when iterative refinement provides
  measurable value. The two signs of good fit are, first, that LLM responses can be
  demonstrably improved when a human articulates their feedback; and second, that the LLM
  can provide such feedback."
- **A separate pass beats a combined one when it's a distinct concern.** Under
  parallelization: "one model instance processes user queries while another screens them …
  tends to perform better than having the same LLM call handle both guardrails and the core
  response."
- **The overriding principle is minimalism**: "find the simplest solution possible, and only
  increase complexity when needed … you should consider adding complexity only when it
  demonstrably improves outcomes." A single pass is the default; a reviewer loop must earn
  its cost.

## OpenAI — Agents SDK docs and examples

- **The evaluator loop is a first-class documented pattern, written as a bounded `while`:**
  "In each iteration of a `while` loop, run the task agent to produce an output, then run an
  evaluator agent to assess that output and provide feedback; stop when the evaluator says
  the output passes the required criteria"
  ([Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)).
- **Hard turn limits are built into the runtime.** The runner loop raises
  `MaxTurnsExceeded` "when the agent's run exceeds the `max_turns` limit", and
  `error_handlers={"max_turns": …}` lets you return a controlled final output instead of an
  exception ([Running agents](https://openai.github.io/openai-agents-python/running_agents/)).
- **OpenAI's own judge example caps both sides of the loop.** In
  [`examples/agent_patterns/llm_as_a_judge.py`](https://github.com/openai/openai-agents-python/blob/main/examples/agent_patterns/llm_as_a_judge.py)
  the evaluator's instructions read "Never give it a pass on the first try. After 5
  attempts, you can give it a pass if the story outline is good enough - do not go for
  perfection", and the unattended ("auto mode") variant additionally hard-stops after 3
  rounds.
- **When a separate reviewer is worth it**: the orchestration page's tactics are to "have
  specialized agents that excel in one task, rather than having a general purpose agent",
  and to let an agent "introspect and improve. For example, run it in a loop, and let it
  critique itself" — i.e. self-critique in-loop is the cheap option, and a dedicated
  evaluator agent is the structured option when pass/fail criteria are explicit
  ([Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)).

**Combined reading for cogwork (inference):** both vendors treat a reviewer loop as a
workflow you opt into when criteria are checkable, and both insist on an explicit iteration
cap with a "good enough" exit rather than convergence-to-perfection. A single generate pass
plus one bounded review pass matches both vendors' guidance; unbounded generate–review
cycles match neither.
