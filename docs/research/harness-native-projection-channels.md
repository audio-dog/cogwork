# Native projection channels for Skills, Subagents, and Commands on the external Harnesses

Date: 2026-11-02. All sources accessed on 2026-11-02.

**Scope and method.** Issue [#874](https://github.com/taylorfsteele/cogwork/issues/874) asks the
external Harnesses to project the Skills, Subagents, and Commands of a Run Plan. Today
`externalHarnessDeclaration.projectedMembers` does not list these three kinds, so the Run Plan
records them `not-projected`. The constraint: the driven worktree stays clean, and the engine
provisions files on host paths (engine ADR [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md),
engine ADR [0010](../../packages/engine/docs/adr/0010-codex-cli-is-an-external-harness.md)). TanStack's
Workspace projection writes Skills into the checkout and has no Subagent kind, so it is not a
channel. This note answers four questions for each Harness:

1. Which native channel outside the working directory supplies Skills, Subagents, or Commands for
   one invocation? Does it add to the user's config home or replace it? Is it safe headless?
2. Which stores does the Harness read by itself (ambient stores), and what wins on a name collision?
3. Which subagent file format does the Harness read, and which fields matter?
4. Which flags, environment, and config passthroughs do the cogwork descriptors and the TanStack
   adapters already use?

Sources are primary only:

- The vendored Codex source at `.repos/codex`, revision `4aa52f2` (2026-08-24).
- The official Claude Code docs (`code.claude.com/docs`) and Cursor docs (`cursor.com/docs`).
- `--help` output of the CLIs on this machine: Claude Code `2.1.296`, `codex-cli 0.166.0`, and
  Cursor `agent 2026.08.11-e8db854`. I did not log in, start a session, or write config.
- The adapter sources `@tanstack/ai-claude-code@1.0.0`, `@tanstack/ai-codex@1.0.0`, and
  `@tanstack/ai-acp@1.0.0` (`dist/esm`), and the cogwork descriptors in `packages/claude-code`,
  `packages/codex-cli`, and `packages/cursor-acp`.

I mark a claim **(inference)** when no source states it. I mark a claim **thin evidence** when only
a weak or indirect source supports it. The vendored Codex revision can be older than the installed
`0.166.0`. Where Codex behavior comes from source only, a live probe must confirm it on the installed
version **(thin evidence that the two match)**. This note builds on
[`harness-config-scopes-and-rules.md`](./harness-config-scopes-and-rules.md), which maps the Codex
config layers, and on [`harness-model-selection-and-run-speed.md`](./harness-model-selection-and-run-speed.md),
which maps the model vocabulary of each Harness.

---

## TL;DR

1. **Claude Code has two clean channels, and they cover all three kinds.** `--agents <json-or-file>`
   supplies Subagents for one session, at priority 2, above project and user agents. `--plugin-dir
   <path>` loads a plugin from a host directory "for this session only". A plugin carries
   `skills/`, `commands/`, and `agents/`. Both flags add to the config home. Neither flag touches
   `~/.claude` or the login.
2. **Claude Code reads no ambient Skills, agents, or Commands in a cogwork Run today.** The descriptor
   sets `settingSources: []`, so the adapter passes `--setting-sources ""`. The Agent SDK docs state
   that this setting turns off user and project Skills, commands, and subagents. So projection on
   Claude Code cannot cause a member to arrive twice.
3. **Codex has a clean channel for Subagents only.** The existing `config` passthrough can send
   `-c agents.<name>.description=…` and `-c agents.<name>.config_file="<absolute host path>"`. These
   land in the session-flags config layer, which wins over a user or project role of the same name.
   A role file sets the model, the reasoning effort, and the developer instructions. It cannot set
   `sandbox_mode`, approval, or writable roots: the child agent keeps the parent's permissions.
4. **Codex has no channel outside the worktree for Skills or Commands.** `codex exec` takes its Skill
   roots from config-layer folders, `~/.agents/skills`, the repository's `.agents/skills`, and the
   plugin cache in `$CODEX_HOME`. The extra-roots request exists only on the app server. `-c
   skills.config` can only turn a Skill off. Codex has no Command store at this revision: it converts
   plugin commands into Skills. Codex already reads two of the three Authoring trees by itself
   (`~/.agents/skills` and `<repo>/.agents/skills`). Only the private workspace overlay is out of reach.
5. **Cursor has one candidate channel, on thin evidence.** `agent --plugin-dir <path>` is a global
   option that loads a local Cursor Plugin with `skills/`, `agents/`, and `commands/`. The docs do not
   say that it works with `agent acp`, or that it lasts for one session only. The ACP `session/new`
   request carries only `cwd` and `mcpServers`. A live probe must confirm `--plugin-dir` before a
   design depends on it.
6. **Do not relocate a config home.** `CLAUDE_CONFIG_DIR` moves `~/.claude` and `~/.claude.json`,
   which holds the account details. `CODEX_HOME` moves `auth.json` and the keyring key that Codex
   derives from that path. Both replace the user's home and hide the login. `CURSOR_CONFIG_DIR` is
   documented only for `cli-config.json`.
7. **Side finding: the Cursor descriptor writes into the worktree today.** It declares an empty
   `transport`, so the runtime uses Workspace instruction projection. TanStack's bootstrap then writes
   `<checkout>/AGENTS.md` and links `CLAUDE.md` and `GEMINI.md` to it. A runtime test asserts this
   file. The ACP adapter already prepends system prompts to the prompt text, so a
   `system-prompt` channel exists for Cursor too **(inference that it suits the Run)**.

---

## Summary table

"Adds" means the channel leaves the user's config home and login in place. "Ambient" lists the stores
the Harness reads by itself in the way cogwork launches it today.

| Harness | Kind | Channel outside the worktree | Adds or replaces | Ambient stores it also reads | Evidence |
|---|---|---|---|---|---|
| Claude Code | Skill | `--plugin-dir <dir>` (`skills/`), name `plugin:skill` | Adds, one session | None in a cogwork Run (`--setting-sources ""`); managed Skills still load | CLI help; CLI reference; Agent SDK features page |
| Claude Code | Subagent | `--agents <json-or-file>`; or plugin `agents/` | Adds, one session | None in a cogwork Run; managed agents (priority 1) still load | Sub-agents page; CLI help |
| Claude Code | Command | `--plugin-dir <dir>` (`commands/`) | Adds, one session | None in a cogwork Run | Plugins reference; `.claude` directory page |
| Codex | Skill | None for `codex exec` | — | `~/.agents/skills`, `$CODEX_HOME/skills`, `/etc/codex/skills`, `.codex/skills` and `.agents/skills` from project root to cwd, enabled plugins | `ext/skills/src/host_roots.rs` |
| Codex | Subagent | `-c agents.<name>.description` and `-c agents.<name>.config_file=<host path>` | Adds; session layer wins by name | `$CODEX_HOME/agents/**/*.toml`, `[agents.*]` in `config.toml`, `<repo>/.codex/agents` (trusted only), built-ins | `core/src/config/agent_roles.rs`; `core/src/agent/role.rs` |
| Codex | Command | None (no Command store) | — | None; plugin commands become Skills | `core-plugins/src/command_migration` |
| Cursor | Skill | `--plugin-dir <dir>` (`skills/`) **thin evidence** | Adds **(inference)** | `.agents/`, `.cursor/`, `.claude/`, `.codex/` `skills/` at project and user level; installed plugins | Skills page; parameters page; plugins reference |
| Cursor | Subagent | `--plugin-dir <dir>` (`agents/`) **thin evidence** | Adds **(inference)** | `.cursor/agents`, `.claude/agents`, `.codex/agents` at project and user level | Sub-agents page |
| Cursor | Command | `--plugin-dir <dir>` (`commands/`) **thin evidence** | Adds **(inference)** | Plugin commands; `.cursor/commands` **thin evidence** | Plugins reference; commands page now shows Skills |

---

# Question 4 first — what the adapters pass today

This section comes first, because each later answer names the passthrough that would carry it.

## Claude Code

The descriptor builds one executable string and gives it to the adapter as `claudeExecutable`
([`harness.ts`](../../packages/claude-code/src/harness.ts) `claudeExecutableFor`). The string carries
`--effort`, `--settings <inline JSON>`, and `--mcp-config <inline JSON>`. The adapter splits that
string on spaces (`text.js` `buildArgv`: `config.claudeExecutable.split(" ")`). So no value can hold
a space. The descriptor rejects a space in the settings JSON (`inlineSettingsArgument`) and writes
every space in the MCP JSON as `\u0020`.

Other adapter inputs that the descriptor sets:

- `settingSources: []`. The adapter always emits `--setting-sources <list>`, so the CLI receives
  `--setting-sources ""`. The adapter default is `["project"]`.
- `addDirs` → one `--add-dir` for each shared Git path.
- `disallowedTools`, `cwd: "."`, `authMode: "host"`, `emitDiff: true`.
- System prompts → `--append-system-prompt` (`transport.instructionProjection: "system-prompt"`).

The adapter also accepts `env`, which it merges into the child environment. The descriptor does not
use it. The adapter spawns `claude` from argv held in a JSON file, so `--agents` and `--plugin-dir`
need no shell quoting.

## Codex

The descriptor passes these adapter inputs
([`harness.ts`](../../packages/codex-cli/src/harness.ts) `codexDescriptor`):

- `config` → one `--config '<key>=<value>'` per entry (`text.js` `buildCommand`). The value is
  TOML. Engine ADR 0010 uses this for `mcp_servers.<name>.url` and `bearer_token_env_var`.
- `env` → the child environment only. It carries MCP bearer values.
- `additionalDirectories` → `--add-dir` for shared Git paths.
- `codexExecutable` → a `sh -c` wrapper that adds `--dangerously-bypass-hook-trust` to `exec`.
- `sandboxMode`, `approvalPolicy: "never"`, `modelReasoningEffort`.

Codex splits a `--config` key on every `.` and has no escape. The descriptor therefore refuses an
MCP server name outside `[A-Za-z0-9_-]` (`codexConfigKeySafe`). The same rule applies to an agent
role name in `agents.<name>.*`.

## Cursor via ACP

The descriptor owns the spawn command: `${agentBin} --model ${flag} acp`
([`harness.ts`](../../packages/cursor-acp/src/harness.ts) `openCursorTransport`). Cogwork can add
global CLI options to this string with no adapter change. The ACP client sends only `cwd` and
`mcpServers` in `session/new` and `session/load` (`acp-client.js`). The `acpCompatible` harness
options include `skillsDir`, but that option copies Skills into the checkout, so it is not a channel.

The descriptor sets `transport: {}`. The runtime therefore puts the Instructions into the Workspace
definition, and TanStack's `bootstrap.js` writes them to `<root>/AGENTS.md` with `CLAUDE.md` and
`GEMINI.md` links (`agents-file.js` `writeAgentsFile`). The root is the checkout:
`external-harness-runtime.test.ts` reads `${checkout}/AGENTS.md` after a Run with `transport: {}`.

## Stale claims in the TanStack projection comments

- `ai-codex` `projection.js` says Codex "has no plugin concept" and "no documented project skills
  dir". The installed CLI has `codex plugin`, and Codex source reads `<dir>/.codex/skills`.
- `ai-claude-code` `projection.js` installs plugins at project scope, so the default
  `--setting-sources project` loads them. Cogwork passes an empty list, so that path would not load.

---

# Claude Code

## Channels outside the worktree (Q1)

| Channel | Kinds | Adds or replaces | Headless | Notes |
|---|---|---|---|---|
| `--agents <json>` | Subagents | Adds, one session | Yes | Priority 2: below managed, above project, user, and plugin agents |
| `--agents <file>` with `-p` | Subagents | Adds, one session | Yes | Needs Claude Code 2.1.281 or later. Cogwork accepts 2.1.83 or later today |
| `--plugin-dir <dir-or-zip>` | Skills, Commands, Subagents, hooks, MCP | Adds, one session | Yes | Names are `plugin-name:component`. A folder of plugins needs 2.1.265 or later |
| `--plugin-url <url>` | Same as above | Adds, one session | Yes | Fetches a zip. Not useful for host provision |
| `--add-dir <dir>` | `.claude/skills`, `.claude/commands`, `.claude/agents` of that dir | Adds | Yes | Loads only with the `project` setting source. Also grants file access to that dir |
| `--settings <file-or-json>` | None directly | Adds | Yes | Overrides keys for the session. It cannot declare a Skill or an agent |
| `CLAUDE_CONFIG_DIR` | All user stores | **Replaces** | — | Moves `~/.claude` and `~/.claude.json` (account details). Hides the login **(inference for the macOS keychain entry)** |
| `--bare`, `--safe-mode`, `--restricted` | Turn stores off | — | Yes | `--bare` keeps `--agents`, `--plugin-dir`, and `--add-dir` Skills. It also refuses OAuth and keychain login, so it breaks host login |

Evidence:

- The sub-agents page gives the priority table: managed (1), `--agents` (2), `.claude/agents/` (3),
  `~/.claude/agents/` (4), plugin `agents/` (5). It says CLI-defined subagents "exist only for that
  session and aren't saved to disk".
- The CLI reference says `--plugin-dir` loads a plugin "for this session only".
- `claude --help` (2.1.296) lists `--agents <json-or-file>`, `--plugin-dir`, and `--plugin-url`. Its
  `--bare` text names `--agents` and `--plugin-dir` as the explicit context channels.
- The Skills page says an added directory's `.claude/skills/`, `.claude/commands/`, and
  `.claude/agents/` load, and that "these loads depend on the `project` setting source".

I found no doc that says `--plugin-dir` and `--agents` load when `--setting-sources` is empty. Bare
mode skips plugin discovery and still accepts both flags, so they are independent of setting sources
**(inference, strong)**.

## Ambient stores (Q2)

The `.claude` directory page and the Agent SDK features page list the stores:

| Store | User level | Project level | Setting source that gates it |
|---|---|---|---|
| Skills | `~/.claude/skills/<name>/SKILL.md` | `.claude/skills/` in cwd and each parent up to the repository root | `user` / `project` |
| Commands | `~/.claude/commands/*.md` | `.claude/commands/` | `user` / `project` |
| Subagents | `~/.claude/agents/**/*.md` | `.claude/agents/` in cwd and each parent up to the repository root | `user` / `project` |
| Managed | Managed settings directory: `.claude/skills/`, `.claude/agents/` | — | Always read |
| Plugins | Installed plugins, enabled in settings | Project-scope installs | **(inference)** off without `user` and `project` |

The Agent SDK page states: "pass `settingSources: []`, which limits the agent to what you configure
programmatically." Its table maps `user` to `~/.claude/skills/`, `~/.claude/commands/`, and
`~/.claude/agents/`, and `project` to the project folders. So a cogwork Run on Claude Code reads none
of these stores. Claude Code does not read `.agents/skills` at any level.

Precedence on a name collision:

- **Subagents:** managed, then `--agents`, then project, then user, then plugin. A plugin agent has
  a scoped name such as `my-plugin:reviewer`, so it does not collide with an unscoped name.
- **Skills:** enterprise over personal over project. A Skill wins over a command file with the same
  name. Plugin Skills are namespaced (`/plugin-name:skill-name`), so both load.

## Subagent format (Q3)

A Markdown file with YAML frontmatter, or one entry in the `--agents` JSON object. The JSON entry
takes `prompt` for the body and the same frontmatter fields.

| Field | Use for projection |
|---|---|
| `name` | Required in a file. At most 256 characters. No `:` (reserved for plugin scope). Must not start with `-` |
| `description` | Required |
| `model` | `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit`. Omit it to follow the subagent model order |
| `effort` | `low` to `max`, model-dependent |
| `tools` | Allowlist |
| `disallowedTools` | Denylist, applied first |
| `permissionMode` | `plan`, `default`, `acceptEdits`, and others. **Ignored for plugin subagents** |
| `mcpServers`, `hooks` | **Ignored for plugin subagents** |
| `skills` | Skills to preload |
| `omitClaudeMd` | Starts the subagent without CLAUDE.md files |

A read-only Subagent is `tools: Read, Grep, Glob` (optionally `Bash`), or `disallowedTools: Write,
Edit`, or `permissionMode: plan`. Only `--agents` and file agents honor `permissionMode`. So a
Subagent that needs it must go through `--agents`, not through a plugin.

For ADR [0028](../adr/0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md):
`standard` maps to an omitted `model` or `inherit`. `light` maps to `haiku`.

---

# Codex CLI

## Channels outside the worktree (Q1)

| Channel | Kinds | Adds or replaces | Headless | Notes |
|---|---|---|---|---|
| `-c agents.<name>.description=…` and `-c agents.<name>.config_file="<abs path>"` | Subagents | Adds | Yes | Session-flags layer. The path must be absolute. Uses the existing `config` passthrough |
| `-c agents.default_subagent_model`, `-c agents.default_subagent_reasoning_effort` | Subagent defaults | Adds | Yes | Applies when a spawn call names no model |
| `-c 'skills.config=[{ name = "…", enabled = false }]'` | Turns Skills **off** | Adds | Yes | Session-flags layer. Cannot add a Skill |
| `-p <profile>` | Config | Adds | Yes | The profile file lives at `$CODEX_HOME/<name>.config.toml`, inside the user's home |
| `--add-dir <dir>` | None | Adds | Yes | Writable roots only. It does not add a Skill root |
| `CODEX_HOME` | All user stores | **Replaces** | — | Moves `auth.json`, the keyring key, `skills/`, `agents/`, and `plugins/cache` |
| Plugin install into `$CODEX_HOME/plugins/cache` | Skills, plugin agents | Writes the user's home | — | Persistent, not per Run. Concurrent Runs share it |
| App-server `skills/extraRoots/set` | Skills | Adds | — | Not reachable from `codex exec` flags |

Evidence for the Subagent channel:

- `load_agent_roles` walks every enabled config layer, low to high. It reads the layer's `agents`
  table and the `agents/` folder beside the layer's config file
  (`core/src/config/agent_roles.rs:20-114`).
- The CLI overrides become one `SessionFlags` layer above the user and project layers
  (`config/src/loader/mod.rs:429-435`). A `SessionFlags` layer has no config folder
  (`config/src/state.rs:219-231`), so it contributes roles only through its `agents` table.
- `AgentRoleToml` has `description`, `config_file` (an `AbsolutePathBuf`), and
  `nickname_candidates` (`config/src/config_toml.rs:704-715`).
- A higher layer wins for the same role name and fills its missing fields from the lower one
  (`merge_missing_role_fields`).

I found no test that declares a role through CLI overrides. The path above comes from the source
alone **(thin evidence until a live probe runs it)**.

Evidence for "no Skill channel": `resolve_skill_roots_with_home_dir` builds the roots from the layer
stack, plugin roots, `extra_skill_roots`, and the repository's `.agents/skills`
(`ext/skills/src/host_roots.rs:48-71`). A `SessionFlags` layer has no config folder, so `-c` adds no
root (`host_roots.rs:73-129`). Only the app server calls `set_extra_roots`
(`app-server/src/request_processors/catalog_processor.rs:563`). The `skills.config` rules only
enable or disable a Skill that a root already found (`config/src/skills_config.rs:94-185`).

Two workarounds exist. I do not recommend either:

- **Point `HOME` at a per-Run directory.** Codex finds `~/.agents/skills` through `dirs::home_dir()`
  (`host_roots.rs:35-36`). That function reads `$HOME` on Unix **(inference)**. With `CODEX_HOME`
  set to the real `~/.codex`, the login stays. But every child shell gets the new `HOME` unless
  `-c shell_environment_policy.set.HOME=…` restores it, and `gh`, `git`, and `ssh` read `HOME`.
  This replaces the `~/.agents/skills` view. It does not add to it.
- **Widen `project_root_markers`.** The repository `.agents/skills` scan runs from the project root
  down to cwd (`host_roots.rs:137-185`). A session marker could move the project root to
  `<checkout>.worktrees/`, the parent of every worktree. All Runs of a Workspace share that folder,
  and the change also moves `AGENTS.md` discovery and the project trust key **(inference)**.

## Ambient stores (Q2)

Skill roots (`host_roots.rs:73-185`):

| Root | Scope | Condition |
|---|---|---|
| `$CODEX_HOME/skills` | User | Deprecated, still read |
| `~/.agents/skills` | User | Always |
| `$CODEX_HOME/skills/.system` | System | Bundled cache |
| `/etc/codex/skills` | Admin | System layer |
| `<dir>/.codex/skills` for each project layer | Repo | Read from every layer, also a disabled (untrusted) one |
| `<dir>/.agents/skills` from project root to cwd | Repo | Always |
| Enabled plugins in `$CODEX_HOME/plugins/cache` | Plugin | `[plugins."<name>@<marketplace>"]` in config |

Subagent roles (`agent_roles.rs`): the `[agents.<name>]` tables and `<config folder>/agents/**/*.toml`
in each **enabled** layer. That means `$CODEX_HOME/agents/`, `/etc/codex/agents/`, and
`<repo>/.codex/agents/` for a trusted project only (`state.rs:481-484` filters disabled layers). The
built-in roles are `default`, `explorer`, and `worker`. The `awaiter` role is commented out
(`core/src/agent/role.rs:355-414`). A user role with a built-in name wins over the built-in
(`resolve_role_config`).

Commands: no store. Codex has no `prompts` loader at this revision. On plugin install it converts a
plugin's `commands/` into Skills (`core-plugins/src/command_migration/plugin.rs:25-40`).

Precedence on a name collision:

- **Skills:** none. Codex removes a duplicate only when the path is the same
  (`ext/skills/src/loader/host_merge.rs:232-233`). Two Skills with one name both appear, sorted by
  scope. This matches ADR [0018](../adr/0018-contribution-files-live-in-three-authoring-trees.md):
  "existing harnesses permit duplicate skill names".
- **Subagents:** the higher layer wins: session flags, then project, then user, then system. Within
  one layer, a second role with the same name is a warning and Codex skips it.

## Subagent format (Q3)

A TOML file. It holds `name`, `description`, `nickname_candidates`, and any `config.toml` keys. A
discovered file needs `name` and `developer_instructions`. A file named by `config_file` takes its
name from the declaration (`agent_roles.rs:234-314`). When Codex spawns the role, it applies only a
bounded set of overrides (`core/src/agent/role.rs:37-129`):

| Applied | Not applied |
|---|---|
| `developer_instructions`, `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `personality`, `service_tier` | `sandbox_mode`, `sandbox_workspace_write.*`, `approval_policy`, `model_provider`, base URLs, `mcp_servers`, `notify`, `apps` |
| `features.<x> = false` for shell tool, apps, personality, plugins, memory tool, request-permissions tool | Any feature turned **on** |
| `skills.config` entries that turn a Skill **off** | Entries that turn a Skill on |

Two tests assert this: `apply_role_preserves_parent_sandbox_permissions` and
`apply_role_cannot_expand_parent_authority` (`core/src/agent/role_tests.rs:354-482`). So a role file
with `sandbox_mode = "read-only"` does not make a read-only Subagent at this revision. The child runs
under the parent's sandbox. `features.shell_tool = false` removes the shell, but the patch tool stays
**(inference: the overrides list does not name the patch tool)**.

For ADR 0028: `standard` maps to an omitted `model`. `light` maps to an account-valid slug from the
managed catalog.

---

# Cursor CLI and ACP

## Channels outside the worktree (Q1)

| Channel | Kinds | Adds or replaces | Headless | Notes |
|---|---|---|---|---|
| `--plugin-dir <path>` | Skills, agents, commands, rules, hooks, MCP | Adds **(inference)** | **thin evidence** | Global option. The docs do not say it is session-only or that `agent acp` honors it |
| `--add-dir <path>` | Unknown | Adds | **thin evidence** | "Add an additional workspace root directory". The docs do not say it loads that root's `.cursor/` stores |
| ACP `session/new` | None | — | Yes | Takes `cwd` and `mcpServers` only |
| `~/.cursor/plugins/local/<name>` | Same as a plugin | Writes the user's home | — | Persistent. A symlink to a directory outside this folder is skipped |
| `CURSOR_CONFIG_DIR` | `cli-config.json` | **Replaces** that file's directory | — | Effect on agents, Skills, and login is not documented **(thin evidence)** |

Evidence: the parameters page lists `--plugin-dir` as a global option, and says "Global options can
be used with any command". The `acp` command is hidden from help. `agent acp --help` shows no
options of its own. The ACP page lists the request flow (`initialize`, `authenticate`, `session/new`,
`session/prompt`) and no Skill or agent parameter.

## Ambient stores (Q2)

| Kind | Project level | User level |
|---|---|---|
| Skills | `.agents/skills/`, `.cursor/skills/`, `.claude/skills/`, `.codex/skills/`, and nested copies in subfolders | `~/.agents/skills/`, `~/.cursor/skills/`, `~/.claude/skills/`, `~/.codex/skills/` |
| Subagents | `.cursor/agents/`, `.claude/agents/`, `.codex/agents/` | `~/.cursor/agents/`, `~/.claude/agents/`, `~/.codex/agents/` |
| Commands | Plugin `commands/`; `.cursor/commands/` **thin evidence** (the commands page now shows Skills, and `/migrate-to-skills` converts commands) | Same |
| Plugins | Marketplace installs (project or user scope) | `~/.cursor/plugins/local/` |

Precedence on a name collision:

- **Subagents:** project wins over user, and `.cursor/` wins over `.claude/` or `.codex/`. The docs
  give no rule for a plugin agent.
- **Skills:** the docs give no rule.
- **Plugins:** a marketplace install wins over a local copy of the same name.

## Subagent format (Q3)

A Markdown file with YAML frontmatter:

| Field | Use for projection |
|---|---|
| `name` | Optional. Comes from the file name. Lowercase letters and hyphens |
| `description` | Read by the parent to decide delegation |
| `model` | `inherit` (the default) or a model ID, with bracket options such as `claude-opus-5[effort=high]` |
| `readonly` | `true` gives restricted write permissions: no file edits and no state-changing shell commands |
| `is_background` | `true` runs the subagent without a block on the parent |

The plugins reference documents only `name` and `description` for a plugin agent. It is not known
whether a plugin agent honors `model` and `readonly` **(thin evidence)**.

The Skills page requires a Skill `name` of lowercase letters, numbers, and hyphens, equal to the
folder name. The engine's projected name is `<authority>__<local name>__<hash>`. It uses
`[a-zA-Z0-9_-]` and a base64url hash with capital letters (`packages/engine/src/run-plan.ts:537-550`).
That name breaks Cursor's documented Skill rule. Cursor may still load it **(thin evidence)**.

---

# Duplicates, names, and limits

**Duplicate arrival.** Issue #874 asks that projection does not deliver one member twice under two
names.

- **Claude Code:** no risk in the current launch, because no ambient store loads.
- **Codex:** projected Subagents use the session layer and win by name. Projected Skills are not
  possible. Skills from `~/.agents/skills` and `<repo>/.agents/skills` already arrive under their
  local names, not under projected names.
- **Cursor:** high risk. Cursor reads `~/.agents/skills` and `<repo>/.agents/skills`, which are the
  Settings profile tree and the Workspace input tree. A plugin copy of the same Skill would arrive a
  second time. The docs do not say whether plugin Skills are namespaced.

**Name limits.**

- Codex `-c` keys: `[A-Za-z0-9_-]`. The projected-name alphabet fits.
- Claude Code agent names: no `:`, at most 256 characters, no leading `-`. The projected name fits.
  A plugin adds its own scope prefix.
- Cursor Skill names: lowercase, digits, and hyphens. The projected name does not fit.
- Codex's 128-byte limit applies to tool names. A role name is an argument of the spawn tool, not a
  tool name **(inference)**.

**Provision files.** Each channel takes a host path. `~/.cogwork/` holds no spaces, so a path fits in
the Claude Code executable string. A per-Run directory under the provision root carries the plugin
folder, the `--agents` file, and the Codex role files (ADR 0018 keeps `~/.cogwork/` for provisioned
bytes).

**Side finding: transient adapter files.** The Claude Code adapter writes
`tanstack-claude-run-<id>.mjs`, `tanstack-claude-argv-<id>.json`, and an output-schema file into its
cwd, which is the checkout. It removes them in `finally`. The Codex adapter does the same with
`.tanstack-output-schema-<id>.json`. An agent that runs `git add -A` during the Run can commit them
**(inference)**.

---

# What a live probe must confirm

Each item needs one headless launch against a scratch checkout. None of them is in this note.

1. Claude Code with `--setting-sources ""`: `--plugin-dir <dir>` lists the plugin's Skills and
   Commands, and `--agents <file>` lists the Subagents.
2. Codex `0.166.0` with `-c agents.<n>.description=… -c agents.<n>.config_file=<abs>`: the spawn tool
   offers the role, and the role's `model` applies.
3. Codex `0.166.0`: a role file with `sandbox_mode` still does not change the child's sandbox.
4. Cursor `agent --plugin-dir <dir> --model <m> acp`: the session lists the plugin's Skills, agents,
   and commands, and the plugin is not left installed after the process exits.
5. Cursor: a plugin Skill with the same name as a `~/.agents/skills` Skill arrives once or twice, and
   under which name.

---

## Sources

**Claude Code** (accessed 2026-11-02):
[Subagents](https://code.claude.com/docs/en/sub-agents);
[Skills](https://code.claude.com/docs/en/skills);
[CLI reference](https://code.claude.com/docs/en/cli-reference);
[Settings files and precedence](https://code.claude.com/docs/en/settings);
[Plugins reference](https://code.claude.com/docs/en/plugins-reference);
[The `.claude` directory](https://code.claude.com/docs/en/claude-directory);
[Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features);
[Headless mode](https://code.claude.com/docs/en/headless);
`claude --help`, `claude plugin --help`, `claude agents --help` (2.1.296).

**Cursor** (accessed 2026-11-02):
[Subagents](https://cursor.com/docs/subagents);
[Agent Skills](https://cursor.com/docs/skills);
[Commands page, now Skills](https://cursor.com/docs/context/commands);
[ACP](https://cursor.com/docs/cli/acp);
[CLI parameters](https://cursor.com/docs/cli/reference/parameters);
[CLI configuration](https://cursor.com/docs/cli/reference/configuration);
[Using Agent in CLI](https://cursor.com/docs/cli/using);
[Plugins](https://cursor.com/docs/plugins);
[Plugins reference](https://cursor.com/docs/reference/plugins);
`agent --help`, `agent acp --help`, `agent plugin --help` (2026.08.11-e8db854).

**Codex** (vendored `.repos/codex` at `4aa52f2`, 2026-08-24; `codex --help` and
`codex exec --help` from `codex-cli 0.166.0`):
`codex-rs/ext/skills/src/host_roots.rs`;
`codex-rs/ext/skills/src/loader/host_merge.rs`;
`codex-rs/ext/skills/src/host_service.rs`;
`codex-rs/config/src/skills_config.rs`;
`codex-rs/config/src/config_toml.rs` (`AgentsToml`, `AgentRoleToml`);
`codex-rs/config/src/state.rs`;
`codex-rs/config/src/loader/mod.rs`;
`codex-rs/config/src/types.rs` (`PluginConfig`, `MarketplaceConfig`);
`codex-rs/config/src/shell_environment_policy.rs`;
`codex-rs/core/src/config/agent_roles.rs`;
`codex-rs/core/src/agent/role.rs`, `role_tests.rs`;
`codex-rs/core-plugins/src/store.rs`, `command_migration/plugin.rs`;
`codex-rs/login/src/auth/storage.rs`;
`codex-rs/utils/home-dir/src/lib.rs`;
`codex-rs/app-server-protocol/src/protocol/common.rs`.

**TanStack adapters** (`node_modules`, version 1.0.0):
`@tanstack/ai-claude-code/dist/esm/adapters/{text,projection,claude-run-source}.js`;
`@tanstack/ai-codex/dist/esm/adapters/{text,projection}.js`;
`@tanstack/ai-acp/dist/esm/adapters/{compatible,projection}.js`, `session/acp-client.js`;
`@tanstack/ai-sandbox/dist/esm/{bootstrap,agents-file}.js`.

**This repo:**
[`external-harness-runtime.ts`](../../packages/engine/src/external-harness-runtime.ts);
[`external-harness-runtime.test.ts`](../../packages/engine/src/external-harness-runtime.test.ts);
[`run-plan.ts`](../../packages/engine/src/run-plan.ts);
[`worktree.ts`](../../packages/engine/src/worktree.ts);
[`claude-code/src/harness.ts`](../../packages/claude-code/src/harness.ts);
[`codex-cli/src/harness.ts`](../../packages/codex-cli/src/harness.ts);
[`cursor-acp/src/harness.ts`](../../packages/cursor-acp/src/harness.ts);
engine ADRs [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md)
and [0010](../../packages/engine/docs/adr/0010-codex-cli-is-an-external-harness.md);
ADRs [0018](../adr/0018-contribution-files-live-in-three-authoring-trees.md) and
[0028](../adr/0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md);
[`packages/engine/CONTEXT.md`](../../packages/engine/CONTEXT.md);
[`packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md);
issue [#874](https://github.com/taylorfsteele/cogwork/issues/874).
