# How t3code and opencode deliver Skills, Subagents, and Commands

Date: 2026-11-03. All sources accessed on 2026-11-03.

**Scope and method.** Issue [#874](https://github.com/taylorfsteele/cogwork/issues/874) asks the
engine to project the Skills, Subagents, and Commands of a Run Plan into each external Harness, and
to keep the driven worktree clean. [`harness-native-projection-channels.md`](./harness-native-projection-channels.md)
maps the native channels of Claude Code, Codex, and Cursor. This note asks how two neighbor products
solve the same problem:

- **t3code** (pingdotgg) is a GUI that drives Codex, Claude Code, Cursor, opencode, and other agents.
  Its job is close to the cogwork engine's job.
- **opencode** is an open-source coding agent with its own agent, Skill, and command system. It can
  also drive Claude Code as a model provider.

For each product, the note answers five questions: the subagent definition format, Skill discovery
and delivery, the delivery channel per Harness (t3code only), the UX, and ambient against explicit
capability.

Sources are the source code of the two products, read from the vendored clones after a
fast-forward pull on 2026-11-03:

- `.repos/t3code` at `cefb544af3c9` (branch `main`, 2026-11-02).
- `.repos/opencode` at `ce8ca3084eac` (branch `dev`, 2026-11-03).
- One check in `.repos/codex` at `4aa52f2` (2026-08-24), the same revision as the earlier note.
- The Claude Agent SDK page [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features),
  for the default of `settingSources`.

Paths below are relative to the repository root of each product. I mark a claim **(inference)**
when no source states it. "No call found" means a search of the source found no use; it is not
proof of absence.

---

## TL;DR

1. **t3code supplies no Skills, Subagents, or Commands to any Harness.** It supplies only its own
   MCP server and its own instructions. Each Harness finds Skills, agents, and commands in the
   user's own config by itself. t3code scans the same stores to show them in the UI.
2. **t3code does not get Skills to Codex by a channel.** It drives `codex app-server`, lists Skills
   with `skills/list`, and rewrites a mention to `$name` text. It does not call
   `skills/extraRoots/set`, and it sends no `skill` input item. Codex resolves the mention against
   its own roots. t3code writes nothing into the worktree for this.
3. **t3code makes a read-only child with a separate thread, not with a Codex agent role.** Its
   `delegate_task` MCP tool starts a new t3code child thread with a runtime mode equal to or
   narrower than the parent's. On Codex, the mode `approval-required` sends
   `sandboxPolicy: readOnly` and `approvalPolicy: untrusted` in each `turn/start`. Native Codex
   subagents keep the parent's sandbox.
4. **t3code drives Cursor through `@cursor/sdk` 1.2.0, not through ACP.** It passes
   `settingSources: [project, user, team, mdm, plugins]`, so Cursor reads the user's Skills, agents,
   and plugins by itself. t3code adds its MCP server through the SDK `mcpServers` option.
5. **t3code has no subagent file format.** A t3code child is a tool call: a task, a target
   (provider instance, vendor model slug, effort), a role from a fixed list, and two modes. The role
   only adds the sentence "Act as the `<role>` sub-agent for this task."
6. **opencode has its own subagent format, and it is not Claude Code's.** An agent is a Markdown
   file with YAML frontmatter in `.opencode/agents/` or `~/.config/opencode/agents/`, or a JSON
   entry. The fields are `model` (`provider/model#variant`), `mode`, `permissions` (allow, deny, or
   ask per action and resource), `steps`, `hidden`, and others. opencode does not read
   `.claude/agents`.
7. **Both products use the SKILL.md format for Skills.** opencode reads `.opencode/skills`,
   `.claude/skills`, and `.agents/skills` at user and project level, plus paths and URLs from
   config. opencode delivers Skills through its own `skill` tool and an `<available_skills>` list.
8. **opencode's Claude Code provider is the explicit pattern.** It starts Claude Code with
   `settingSources: []`, `skills: []`, and `tools: []`. It gives Claude opencode's tools, including
   the `skill` and `subagent` tools, through one in-process MCP server. opencode's Skills and
   Subagents then work the same way on every model.
9. **UX differs.** t3code shows Skills per provider instance and per working directory, with a
   source badge (App, Repo, Project, Personal, System, Provider). opencode shows one merged list
   per kind in its `@` popover, with no source field in its Skill schema.
10. **Neither product guarantees a Harness-native capability before a turn starts.** t3code lets
    each Harness find what it finds. opencode checks its own registry: a prompt that attaches an
    unknown Skill fails with `SkillNotFoundError` before the model runs.

---

## Summary table

| Concern | t3code on Codex | t3code on Claude Code | t3code on Cursor | opencode |
|---|---|---|---|---|
| Transport | `codex app-server` JSON-RPC | Claude Agent SDK `^0.3.284` | `@cursor/sdk` 1.2.0 | Is the Harness |
| Skills supplied by the product | None | None | None | Its own registry; built-ins `opencode`, `report` |
| Skills the Harness reads | Codex roots (`skills/list`) | SDK default sources: user, project, local | Cursor setting sources | `.opencode/skills`, `.claude/skills`, `.agents/skills`, config paths and URLs |
| Skill mention on send | `$name` text | `/name` as the last text block | `/name` | `skill` tool, or a prompt `skills` attachment |
| Subagents supplied | None (native ones stay ambient) | None | None | Built-ins `general`, `explore`; config files |
| Product-owned child | `delegate_task` → new thread | Same | Same | `subagent` tool → child session |
| Read-only child | `turn/start` `sandboxPolicy: readOnly` | `permissionMode: dontAsk` for a read-only sandbox policy | `sandboxOptions`, `autoReview` | `permissions` rules |
| MCP | Per-thread `config` `mcp_servers.t3-code` | `mcpServers` option | SDK `mcpServers` | Config `mcp` |
| Instructions | `turn/start` `additionalContext` | `systemPrompt` preset with `append` | SDK options **(inference)** | AGENTS.md and config instructions |
| Writes into the worktree | No write path found | No write path found | No write path found | Plan files go to `~/.opencode/plan` |

---

# t3code

## Architecture in one paragraph

The t3code server runs one adapter per provider under `apps/server/src/orchestration-v2/Adapters/`
and `packages/provider-*`. Each adapter opens a provider session and starts threads and turns. Before
the session opens, the server issues an MCP credential and gives the Harness one authenticated HTTP
MCP server, `t3-code`. That server carries t3code's orchestration tools: `delegate_task`,
`task_status`, `create_threads`, `t3_thread_*`, and others
(`docs/orchestration-v2/orchestrator-mcp-server.md`, sections "Transport And Authentication" and
"Provider Injection"). The doc states: "These are T3 orchestration operations, not provider-native
sub-agent APIs."

## Q1 — Subagent definition format

t3code has no subagent definition file. A search for `.claude/agents`, `.codex/agents`,
`.cursor/agents`, `agent_roles`, and `config_file` in `apps/server/src` and `packages` found no
reader or writer. A t3code child is one `delegate_task` call:

| Field | Meaning | Source |
|---|---|---|
| `task` | The prompt. The child gets no parent history | `packages/contracts/src/orchestratorMcp.ts:168-196`; doc "Purpose" |
| `target` | `providerInstanceId`, `driverKind`, `model`, `options` (for example `{effort:'max'}`), `environmentId`, `projectId` | `orchestratorMcp.ts:96-126` |
| `role` | `implementation`, `research`, `review`, `design`, `test`, `general` | `orchestratorMcp.ts:138-145` |
| `runtimeMode` | `inherit`, `approval-required`, `auto-accept-edits`, `auto`, `full-access` | `orchestratorMcp.ts:129, 189-194` |
| `interactionMode` | `inherit`, `plan`, `default` | `orchestratorMcp.ts:132-135` |
| `isolation` | `shared` (parent checkout) or `worktree` (new checkout from the parent commit) | `orchestratorMcp.ts:173-178` |

- **The role is text only.** `taskPrompt` prefixes "Act as the `<role>` sub-agent for this task."
  for any role except `general` (`apps/server/src/mcp/delegatedTaskModes.ts`, `taskPrompt`).
- **The model choice is a vendor model slug.** The caller picks a provider instance and a model from
  the list that `orchestrator_capabilities` returns. When a provider publishes a model list, a
  requested model must be on it (doc "Policy And Idempotency"). A provider change with no model uses
  that provider's first advertised model (doc "`delegate_task`"). t3code has no level such as
  `standard` or `light`.
- **Modes never widen.** `resolveRuntimeMode` and `resolveInteractionMode` refuse a child mode that
  is broader than the parent's (`runtime_mode_escalation_denied`,
  `interaction_mode_escalation_denied`). An inherited mode that the target does not offer steps
  down to the broadest mode it offers (`delegatedTaskModes.ts:36-88`).
- **t3code does not adopt Claude Code's agent format or a shared agent format.** Native subagents of
  each Harness still run. t3code only observes them: the Codex adapter declares
  `supportsSubagents`, `canWaitForSubagents`, and `canCloseSubagents`
  (`CodexAdapterV2.ts:297-303`), and the Claude adapter declares `supportsSubagents`
  (`ClaudeAdapterV2.ts:448-453`).

## Q2 — Skills: discovery and delivery

t3code discovers Skills only to show them and to rewrite mentions. Each Harness loads and runs the
Skill itself. Every provider snapshot carries `skills` and `slashCommands` for one working directory
(`packages/contracts/src/server.ts:110-133`). A Skill entry has `name`, `description`, `path`,
`scope`, `enabled`, `displayName`, `shortDescription`, `userInvocationOnly`, and `userInvocable`.

| Harness | How t3code lists Skills | Roots | Source |
|---|---|---|---|
| Codex | App-server request `skills/list { cwds: [cwd] }` | Whatever Codex reads (see the earlier note) | `apps/server/src/provider/CodexProvider.ts:556, 647-656` |
| Claude Code | Own file scan that mirrors the CLI | `<config dir>/skills`, `<cwd>/.claude/skills`, `.claude/skills` of each `--add-dir` in the launch arguments, enabled plugins from `plugins/installed_plugins.json` | `apps/server/src/provider/Drivers/ClaudeSkills.ts:487-587` |
| Cursor | Own file scan, nested to depth 10, with budgets | `.cursor/skills`, `.agents/skills`, `.codex/skills`, `.claude/skills` under the cwd and under `$HOME`, then `~/.cursor/skills-cursor` (system) | `packages/provider-cursor/src/server/skills.ts:226-271` |
| opencode | opencode server's Skill list | opencode's roots | `packages/provider-opencode/src/server/v2/adapter.ts:3342-3360` |

- The Claude scan also reads `skillOverrides` and `enabledPlugins` from the user, project, local,
  and managed settings files, in the CLI's order (`ClaudeSkills.ts:122-144, 238-288`). The first
  name wins, "matching Claude Code's precedence of user skills over project skills"
  (`ClaudeSkills.ts:486-565`).
- The Cursor scan lets a user or project Skill win over a system Skill of the same name
  (`skills.ts:244-262`). It hides a Skill whose `metadata.surfaces` does not include `cli`
  (`skills.ts:96-112`).

Delivery on send, per Harness:

- **Codex:** `codexSkillMentionText` changes any currency-sigil mention (`€review`) to `$review`,
  because "Codex only parses `$name` as a skill mention" (`CodexAdapterV2.ts:417-423, 3283`). The
  turn input is plain `text`.
- **Claude Code:** `planClaudeSkillDispatch` sends the last known Skill mention as `/name` at the
  start of the last text block, because Claude "expands one skill per message only when `/name`
  starts the text block". An earlier mention of a user-only Skill gets the note
  `[The user invoked this skill. Follow the instructions at: <path>]`
  (`apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts:3-58`).
- **Cursor:** `rewriteCursorSkillMentions` changes `$name` to `/name`, but only for names in the
  scanned set (`skills.ts:295-307`; `adapter.ts:2281-2300`).
- **opencode:** t3code sends known mentions as explicit `skills: [{ id }]` prompt attachments
  (`v2/adapter.ts:3399-3411`).

## Q3 — Delivery per Harness

### Codex

t3code spawns `codex app-server`, followed by the user's launch arguments
(`apps/server/src/provider/codexLaunchArgs.ts:12-15`; `CodexProvider.ts:514`). The environment
variable `T3CODE_CODEX_LAUNCH_ARGS` can replace them (`codexLaunchArgs.ts:3-8`). Then it uses
app-server requests:

| Kind | Channel | Source |
|---|---|---|
| MCP servers | Per-thread `config` on `thread/start`, `thread/resume`, `thread/fork`: `mcp_servers.t3-code` and `mcp_servers.t3-code-direct` with an `Authorization` header. The comment says "Override only T3's servers so launch-argument MCP servers survive." | `CodexAdapterV2.ts:1356-1411, 7059-7071` |
| Other config | Same `config`: `tools.update_plan.enabled = true`, `mcp_optional_startup_grace_ms = 10000`, and `shell_environment_policy.set.<thread env>` | `CodexAdapterV2.ts:1356-1358, 1390-1395` |
| Instructions | `turn/start` `additionalContext`, entries of kind `application`, each at most 4,000 bytes. The comment says model-catalog mode text overrides client `developer_instructions`, so t3code does not use that field | `apps/server/src/provider/CodexDeveloperInstructions.ts:10-60`; `CodexAdapterV2.ts:775-799` |
| Plan mode | `turn/start` `collaborationMode: { mode, settings }` | `CodexAdapterV2.ts:810-817` |
| Sandbox and approval | `turn/start` `sandboxPolicy`, `approvalPolicy`, `approvalsReviewer`, from the runtime mode or from an explicit runtime policy | `CodexAdapterV2.ts:703-765` |
| Skills | None supplied. Mention rewrite only | See Q2 |
| Subagents | None supplied. Native Codex subagents are observed | `CodexAdapterV2.ts:297-303` |
| Slash commands | t3code's own list: `compact`, `goal`, `feedback` | `CodexProvider.ts:872-884` |

**No Skill channel.** The generated client knows `skills/extraRoots/set`
(`packages/effect-codex-app-server/src/_generated/meta.gen.ts:36`), but no call was found in the
server. The app-server `UserInput` type has a `{ type: "skill", name, path }` item
(`_generated/schema.gen.ts:32549`). t3code does not send it. It would not help a path outside the
roots: Codex selects a structured Skill input only when the path matches a Skill that it already
loaded (`.repos/codex` `codex-rs/skills/src/selection.rs:33-80`;
`codex-rs/ext/skills/src/selection.rs:21-46`).

**`CODEX_HOME`.** The setting `homePath` becomes `CODEX_HOME` (`CodexProvider.ts:476-482`). The
setting `shadowHomePath` makes an "auth overlay": a second home in which every entry of the shared
home is a symlink, including `skills/` and `plugins/`, while `auth.json` stays a private real file
(`apps/server/src/provider/Drivers/CodexHomeLayout.ts:18-41, 350-445`;
`packages/contracts/src/settings.ts:657-662`). Its purpose is a second account. It keeps the user's
Skills. It does not add Skills.

**Read-only children on Codex.** The runtime mode sets the sandbox of each turn:

| Runtime mode | `approvalPolicy` | `sandboxPolicy` |
|---|---|---|
| `approval-required` | `untrusted` | `readOnly` |
| `auto-accept-edits` | `on-request` | `workspaceWrite` |
| `auto` | `on-request` (reviewer `auto_review`) | `workspaceWrite` |
| `full-access` | `never` | `dangerFullAccess` |

Source: `codexRuntimeModeTurnDefaults` (`CodexAdapterV2.ts:703-742`). So a read-only child is a
separate t3code thread that runs at `approval-required`. The contract tells the model: "Narrow modes
pause for human approval, not read-only" (`orchestratorMcp.ts:189-193`). The reason: under
`untrusted`, Codex can ask the user to approve an escalation **(inference from the approval
policy)**. t3code does not change the sandbox of a native Codex subagent, and the earlier note shows
that a Codex role file cannot change it either.

### Claude Code

t3code uses the Claude Agent SDK (`apps/server/package.json:37`, `^0.3.284`). `makeClaudeQueryOptions`
builds the options (`ClaudeAdapterV2.ts:1552-1683`):

- `systemPrompt: { type: "preset", preset: "claude_code", append }`. The append holds runtime
  instructions, the t3code orchestration instructions, and any `--append-system-prompt` text from
  the launch arguments.
- `mcpServers` with the `t3-code` HTTP server, and `allowedTools` with `mcp__t3-code__*`
  (doc "Claude Agent SDK V2"; `ClaudeAdapterV2.ts:1782-1810`).
- `permissionMode` from the runtime mode; `additionalDirectories` with the cwd, the attachments
  folder, and every `--add-dir`; `settings`; `env`; `extraArgs` for other launch arguments.
- **No `settingSources`, `agents`, `plugins`, or `skills` option.** No call was found.

The SDK page states: "Omitting `settingSources` is equivalent to `["user", "project", "local"]`."
Those sources load user and project Skills, commands, subagents, CLAUDE.md, and hooks. So on Claude
Code, all three kinds come from the user's own `~/.claude` and the project's `.claude`. The
capabilities probe passes the same three sources explicitly, to read slash commands from
`initializationResult().commands` (`apps/server/src/provider/ClaudeProvider.ts:192-214, 350, 388`).

A custom home becomes `CLAUDE_CONFIG_DIR`. The comment says: "Changing HOME hides macOS Keychain
credentials; use CLAUDE_CONFIG_DIR to keep login access"
(`apps/server/src/provider/Drivers/ClaudeHome.ts:33-46`).

Read-only on Claude: a runtime policy with a `readOnly` sandbox maps to `permissionMode: "dontAsk"`.
`approval-required` maps to `"default"`, `auto-accept-edits` to `"acceptEdits"`, and `full-access`
to `"bypassPermissions"` (`ClaudeAdapterV2.ts:2595-2620`).

### Cursor

t3code drives Cursor through the Cursor SDK, `@cursor/sdk` 1.2.0
(`packages/provider-cursor/package.json:52`), not through `agent acp`. `makeCursorAgentOptions`
builds (`packages/provider-cursor/src/server/adapter.ts:287-322`):

- `local.settingSources: ["project", "user", "team", "mdm", "plugins"]`, with the comment "The SDK
  loads no CLI settings unless `settingSources` is supplied."
- `local.cwd`, `local.autoReview`, `local.sandboxOptions.enabled`, `local.enableAgentRetries`.
- `mode: "plan"` or `"agent"` from the interaction mode.
- `mcpServers` with the `t3-code` server. The doc says send-level servers replace only the
  create-time inline set, and "ambient servers from `settingSources` ... stay available"
  (doc "Cursor Agent SDK V2").

`cursorRuntimeAgentPolicy` maps the runtime mode to `autoReview` and `sandboxEnabled`
(`adapter.ts:176-200`). Side text generation, such as titles, uses `settingSources: []`
(`packages/provider-cursor/src/server/textGeneration.ts:113`). t3code passes no agent definitions to
Cursor. Cursor reads its own `.cursor/agents` and related stores **(inference from the setting
sources; t3code does not read them)**.

Other ACP agents (Grok, Antigravity, Kiro, ACP Registry agents) use `packages/provider-acp`. ACP
carries only `mcpServers` in `session/new`, `session/load`, and `session/fork`. For those agents,
t3code uses its own child threads for subagents (doc "Grok ACP V2", "ACP Registry V2").

### Worktree writes

No projection write into the worktree was found. Reads of `AGENTS.md` and `CLAUDE.md` exist for
commit-message context (`apps/server/src/git/GitManager.ts:824-842`). t3code treats a Harness write
into the workspace as a defect: Antigravity 1.4.2 to 1.4.5 "create or overwrite
`skills/system/run-workflow/SKILL.md` in the workspace", so t3code disables that agent's
`run_workflow` tool on those versions (`apps/server/src/provider/acp/AntigravityAcpSupport.ts:65-101`).

## Q4 — UX

- **Per provider instance and per working directory.** The client keeps one workspace snapshot per
  environment, provider instance, and cwd, with a 5-minute TTL, a retry cooldown, and at most three
  attempts (`packages/client-runtime/src/providerSkills.ts:121-353`;
  `packages/contracts/src/server.ts:125-135`). When the user changes provider, the list changes.
- **Source badges.** The composer menu shows a badge for each Skill: App, Repo, Project, Personal,
  System, or Provider (`apps/web/src/components/chat/ComposerCommandMenu.tsx:268-294`). The kind
  comes from the path (`/.codex/plugins/`, `/.agents/plugins/` give App) or from the scope
  (`providerSkills.ts:62-90`).
- **One name, one entry.** The menu removes duplicate names, hides disabled Skills and Skills with
  `user-invocable: false`, and hides a slash command that has the same name as a visible Skill
  (`providerSkills.ts:21-60`).
- **A missing capability.** A mention of an unknown Skill stays plain text on Claude Code and
  Cursor (both rewrite only known names). `orchestrator_capabilities` lists unavailable providers
  with the reason, such as a missing executable or missing authentication. `delegate_task` then
  fails with `provider_unavailable` or `model_unavailable` (doc "`orchestrator_capabilities`",
  "Policy And Idempotency"). t3code also leaves out instructions for tools that are not available,
  because they "would steer the model away from its remaining automation"
  (`CodexDeveloperInstructions.ts:23-32`).

## Q5 — Ambient or explicit

t3code is explicit for its own MCP server, its instructions, its child threads, and the sandbox of
each turn. It is ambient for Skills, Subagents, and Commands on every Harness. It scans the same
stores to fill the UI, but it does not check before a turn that the Harness will load a given Skill.
On Codex, the list comes from the Harness itself (`skills/list`), so the UI and the Harness agree
**(inference)**. On Claude Code and Cursor, the UI list comes from t3code's own scan, which can
differ from what the Harness loads **(inference)**.

---

# opencode

opencode is the Harness. It owns discovery and delivery inside one process. The V2 core is
`packages/core`. Internal plugins load in a fixed order (`packages/core/src/plugin/internal.ts:235-298`).

## Q1 — Agent and subagent definition format

**Locations.** Config "directory" entries are the system config folder, the global config folder
(`~/.config/opencode`, or `OPENCODE_CONFIG_DIR`), and each `.opencode/` folder from the project root
down to the cwd (`packages/core/src/config.ts:266-337`; `packages/core/src/config/discovery.ts:59-168`;
`packages/cli/src/server-process.ts:122-134`). In each directory entry, the agent loader reads:

- `agent/**/*.md` and `agents/**/*.md` as agents;
- `mode/*.md` and `modes/*.md` as primary agents
  (`packages/core/src/config/plugin/agent.ts:22-27, 134-145`).

The file path, without the folder prefix and `.md`, is the agent ID (`agent.ts:153-157`). A JSON
`agents` map in `opencode.json` is the other form (`packages/core/src/config/normalize.ts:156`).
opencode does not read `.claude/agents`: "`.claude` is only read for skills"
(`server-process.ts:127`).

**Fields (V2).** The body becomes `system` (`agent.ts:180`). The frontmatter fields are
(`packages/schema/src/config/agent.ts`):

| Field | Meaning |
|---|---|
| `model` | `provider/model` or `provider/model#variant`, or `{ providerID, model, variant }` (`packages/schema/src/config/model.ts`) |
| `mode` | `subagent`, `primary`, or `all` |
| `permissions` | A ruleset: `{ action, resource, effect }`, with effect `allow`, `deny`, or `ask` (`packages/schema/src/permission.ts:60-67`) |
| `description`, `hidden`, `color`, `steps`, `disabled`, `request`, `system` | Delegation text, menu visibility, step limit, removal, provider request headers and body |

**Fields (V1, still read).** A file with V1 keys goes through migration: `model`, `variant`,
`temperature`, `top_p`, `prompt`, `tools` (deprecated, becomes `permission`), `disable`,
`description`, `mode`, `hidden`, `options`, `color`, `steps`, `maxSteps`, `permission`. `tools`
entries `write` and `patch` become `edit` (`packages/core/src/v1/config/agent.ts:12-66`). The
public docs show this V1 shape (`packages/web/src/content/docs/agents.mdx:201-232`).

**Read-only.** opencode expresses read-only with permission rules, not with a flag:

- The built-in `explore` subagent denies `*`, then allows `shell`, `grep`, `glob`, `webfetch`,
  `websearch`, `read`, and `external_directory`. It asks before a read of `*.env`. Its prompt says
  "Shell commands MUST be read-only" (`packages/core/src/plugin/agent.ts:7-17, 74-93`). So the shell
  limit is in the prompt, not in a rule **(inference from the rules)**.
- The `plan` primary agent denies `edit` except under `~/.opencode/plan/*`, outside the worktree
  (`packages/core/src/plugin/plan.ts:30-41`).
- The `general` subagent denies `question` and `subagent` (`plugin/agent.ts:63-72`).

**Model choice.** A vendor ID, not a level. The `subagent` tool picks the model in this order: the
tool call's `model`, then the agent's `model`, then the parent's model
(`packages/core/src/tool/plugin/subagent.ts:168-184`). The tool checks that a requested model is an
available chat model and that the variant exists (`subagent.ts:75-103`). The tool description tells
the model "NEVER set this unless the user explicitly asks" (`subagent.ts:37-40`).

**Other subagent rules.** Nesting stops at `experimental.subagent_depth`, default 1
(`subagent.ts:135-139`). A `primary` agent cannot run as a subagent (`subagent.ts:142-143`). The
tool description lists the subagents that the current agent's permissions allow
(`subagent.ts:282-309`).

**Format adoption.** opencode uses Markdown with YAML frontmatter, like Claude Code, but with its
own fields and locations. It does not read Claude Code agent files. agentskills.io defines Skills
only, so it has no bearing on agents **(inference)**.

## Q2 — Skills

**Roots** (later sources can replace earlier ones with the same ID):

| Root | Loader | Source |
|---|---|---|
| Built-in `opencode` and `report` (virtual `skill://` paths) | `SkillPlugin` | `packages/core/src/plugin/skill.ts:24-48` |
| `.claude/skills` and `.agents/skills` in `~/.claude`, `~/.agents`, and each `.claude/` and `.agents/` folder from the project root down to the cwd | `ConfigCompatibilityPlugin` | `config/plugin/compatibility.ts:41-58`; `config/discovery.ts:69-70, 82, 152-166` |
| `skill/` and `skills/` in each config directory entry | `ConfigSkillPlugin` | `config/plugin/skill.ts:86-91` |
| Config `skills: [...]`: absolute or relative paths, `~/` paths, or `http(s)` URLs that `SkillDiscovery` pulls | `ConfigSkillPlugin` | `config/plugin/skill.ts:92-104, 108-120` |

The Skill registry is a map by ID, so a later `add` replaces an earlier one
(`packages/core/src/skill.ts:122-140`). The compatibility plugin runs before the native Skill plugin
(`plugin/internal.ts:277-292`). So an `.opencode` Skill wins over a `.claude` or `.agents` Skill with
the same ID **(inference from plugin order)**. The environment variables
`OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` turn off the `.claude` roots
(`server-process.ts:127-131`).

**File format.** The ID is the folder name. `name` defaults to the ID. opencode reads `description`,
`metadata`, and `disable-model-invocation`. `metadata["opencode/autoinvoke"]` or
`disable-model-invocation` removes the Skill from the model's list
(`packages/core/src/config/plugin/skill-file.ts:10-61`). The docs list the Agent Skills fields
`name`, `description`, `license`, `compatibility`, and `metadata`, and a name rule
`^[a-z0-9]+(-[a-z0-9]+)*$` (`packages/web/src/content/docs/skills.mdx:34-60`). The V2 parser does
not apply that rule (`skill-file.ts`).

**Delivery to the model.**

1. **A list in the instructions.** `SkillInstructions` renders `<available_skills>` with `id`,
   `name`, and `description` for each Skill that the merged agent and session permissions do not
   deny and that has a description and auto-invoke on. When the set changes, it sends a delta
   ("New skills are available...", "...are no longer available and must not be used")
   (`packages/core/src/skill/instructions.ts:16-80`).
2. **A `skill` tool.** It takes `id`, asserts the `skill` permission for that ID, and returns a
   `<skill_content>` block with the body, the base directory, and up to 10 sampled file paths
   (`packages/core/src/tool/plugin/skill.ts:12-70`; `packages/core/src/skill.ts:40-94`).
3. **A user attachment.** A prompt can carry `skills: [{ id }]`. opencode puts the same
   `<skill_content>` into the conversation. An unknown ID fails with `SkillNotFoundError`
   (`packages/core/src/session/prompt.ts:58-74`).

**Commands.** Markdown files in `command/` or `commands/` of each config directory entry. The body
is `template`. The fields are `description`, `agent`, `model`, and `subagent` (`subtask` is a
deprecated alias) (`packages/core/src/config/plugin/command.ts:119-150`;
`packages/schema/src/config/command.ts`). A JSON `commands` map is the other form
(`normalize.ts:123`). opencode does not read `.claude/commands` (`server-process.ts:127`).

## How opencode drives Claude Code

The `claude-agent` provider runs the user's `claude` through the Agent SDK. The design goal: "all
of opencode UX stays the same, and claude code becomes another provider"
(`specs/v2/claude-agent-provider.md`, "Overview"). The base options are
(`packages/core/src/plugin/provider/claude-agent/claude/query-options.ts:53-111`):

- `settingSources: []`, `settings: { disableAllHooks: true }`, `strictMcpConfig: true`,
  `skills: []`, `tools: []`, `permissionMode: "dontAsk"`, `allowedTools: ["mcp__opencode__*"]`,
  `verbatimPrompts: true`.
- Environment: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  `DISABLE_AUTO_COMPACT=1`, `ENABLE_TOOL_SEARCH=false`, and others. It clears `CLAUDE_CODE_SIMPLE`,
  `CLAUDE_CODE_EFFORT_LEVEL`, and `MCP_TOOL_TIMEOUT`.
- `systemPrompt` from opencode, and one in-process MCP server `opencode` that carries every
  opencode tool for the session (`query-options.ts:95-104`).

The spec states the policy. "Settings files in `~/.claude` and the project's `.claude` folder,
CLAUDE.md files, hooks, MCP servers and skills" are off, because "opencode has its own versions of
these". "opencode's compaction and subagents are used, not Claude Code's". "If opencode's tools
cannot be given to Claude, the request fails. It never falls back to Claude Code's tools."
(`claude-agent-provider.md`, "Tools", "Turned Off", and the list after "Set by opencode").

## Channels outside the worktree for opencode itself

cogwork does not drive opencode today. For completeness:

- `OPENCODE_CONFIG_CONTENT` adds one inline config document (`server-process.ts:133`;
  `config.ts:287-299`). That document can list `skills` paths (`config/plugin/skill.ts:92-104`) and
  `agents` and `commands` maps (`normalize.ts:123, 156`). It adds to the user's config; its rank
  among the other layers is not checked here **(inference)**.
- `OPENCODE_CONFIG` names one more config file. `OPENCODE_CONFIG_DIR` replaces the global config
  folder (`server-process.ts:122-134`).
- t3code sets `OPENCODE_CONFIG_CONTENT` to `"{}"` when the user sets nothing
  (t3code `packages/provider-opencode/src/server/OpenCodeRuntime.ts:43-61, 538`).

## Q4 — UX

- **One merged list per kind.** The app composer's `@` popover groups suggestions as `skill`,
  `agent`, `session`, `reference`, `resource`, `recent`, and `file`, in that order. Commands are a
  separate `/` list (`packages/app/src/composer/editor/interaction.ts:206-257`).
- **No source badge.** `Skill.Info` has `id`, `name`, `description`, `autoinvoke`, `path`, and
  `content`, and no scope or source field (`packages/schema/src/skill.ts:26-34`). So the UI cannot
  show where a Skill came from **(inference from the schema)**.
- **A missing capability.** The `subagent` tool fails with `Unknown agent: <name>`, and its input
  description tells the model that an unknown subagent name probably means a model
  (`subagent.ts:31-34, 140-141`). An unknown or unavailable model gets a message that points to the
  models tool (`subagent.ts:83-103`). The `skill` tool fails with "Unable to load skill"
  (`tool/plugin/skill.ts:29-49`). When no Skill is available, the list says "No skills are currently
  available." (`skill/instructions.ts:30-32`).

## Q5 — Ambient or explicit

opencode reads ambient stores (`~/.claude/skills`, `.agents/skills`, and others), but it puts every
capability through its own registry, permission check, and tool. A user-attached Skill is checked
before the model call. On the Claude Code provider, opencode turns off everything that Claude Code
would find by itself and supplies its own versions. That is fully explicit delivery.

---

# What this means for issue #874

All items in this section are **(inference)**: they apply the findings to cogwork, and no source
states them.

1. **The closest product does not solve Codex Skills either.** t3code lives with Codex's own roots.
   It lists them with `skills/list` and only mentions them. No neighbor product shows a Skill channel
   outside the worktree for `codex exec`.
2. **Read-only Codex Subagents need a separate process, not a role.** t3code gets a read-only child
   by a new thread with a narrower per-turn sandbox. For cogwork, the matching shape is a child Run
   or a child `codex exec` with `--sandbox read-only`, not a `-c agents.<name>` role.
3. **opencode shows the engine-owned option.** An engine MCP tool that loads a Skill by ID, plus a
   Skill list in the instructions, gives the same behavior on every Harness and writes nothing into
   the worktree. That answers the triage question "may an adapter project a semantic equivalent".
   The cost: the Skill is not native, so Harness features such as Claude's `/name` expansion do not
   apply.
4. **Both products keep the user's ambient stores on.** t3code inherits them on purpose. opencode
   inherits them for Skills. cogwork's Claude Code launch with `settingSources: []` is closer to
   opencode's `claude-agent` provider than to t3code.
5. **A shadow `CODEX_HOME` is a pattern t3code already runs.** It symlinks every entry of the real
   home. A per-Run copy with a private `skills/` folder could add Skills, but t3code does not use it
   for that. The keyring key that Codex derives from the home path (earlier note) is a risk that a
   probe must check.
6. **Neither product uses Claude Code's `--agents`, `plugins`, or `--plugin-dir`.** Neither has a
   portable subagent format. cogwork must define its own and project it per Harness.

---

## Sources

**t3code** (`.repos/t3code` at `cefb544af3c9`, 2026-11-02):
`docs/orchestration-v2/orchestrator-mcp-server.md`;
`apps/server/package.json`;
`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`;
`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`;
`apps/server/src/provider/CodexProvider.ts`;
`apps/server/src/provider/CodexDeveloperInstructions.ts`;
`apps/server/src/provider/codexLaunchArgs.ts`;
`apps/server/src/provider/ClaudeProvider.ts`;
`apps/server/src/provider/Drivers/CodexHomeLayout.ts`;
`apps/server/src/provider/Drivers/ClaudeSkills.ts`;
`apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts`;
`apps/server/src/provider/Drivers/ClaudeHome.ts`;
`apps/server/src/provider/acp/AntigravityAcpSupport.ts`;
`apps/server/src/git/GitManager.ts`;
`apps/server/src/mcp/delegatedTaskModes.ts`;
`apps/web/src/components/chat/ComposerCommandMenu.tsx`;
`packages/contracts/src/orchestratorMcp.ts`;
`packages/contracts/src/server.ts`;
`packages/contracts/src/settings.ts`;
`packages/client-runtime/src/providerSkills.ts`;
`packages/effect-codex-app-server/src/_generated/meta.gen.ts`, `schema.gen.ts`;
`packages/provider-cursor/package.json`;
`packages/provider-cursor/src/server/adapter.ts`, `skills.ts`, `textGeneration.ts`;
`packages/provider-opencode/src/server/OpenCodeRuntime.ts`, `v2/adapter.ts`.

**opencode** (`.repos/opencode` at `ce8ca3084eac`, 2026-11-03):
`specs/v2/claude-agent-provider.md`;
`packages/cli/src/server-process.ts`;
`packages/core/src/config.ts`;
`packages/core/src/config/discovery.ts`;
`packages/core/src/config/normalize.ts`;
`packages/core/src/config/plugin/agent.ts`, `command.ts`, `compatibility.ts`, `skill.ts`,
`skill-file.ts`;
`packages/core/src/v1/config/agent.ts`;
`packages/core/src/plugin/internal.ts`, `agent.ts`, `plan.ts`, `skill.ts`;
`packages/core/src/plugin/provider/claude-agent/claude/query-options.ts`;
`packages/core/src/skill.ts`;
`packages/core/src/skill/instructions.ts`;
`packages/core/src/tool/plugin/skill.ts`, `subagent.ts`;
`packages/core/src/session/prompt.ts`;
`packages/schema/src/config/agent.ts`, `command.ts`, `model.ts`;
`packages/schema/src/permission.ts`;
`packages/schema/src/skill.ts`;
`packages/app/src/composer/editor/interaction.ts`;
`packages/web/src/content/docs/agents.mdx`, `skills.mdx`.

**Codex** (`.repos/codex` at `4aa52f2`, 2026-08-24):
`codex-rs/skills/src/selection.rs`;
`codex-rs/ext/skills/src/selection.rs`.

**Claude Agent SDK** (accessed 2026-11-03):
[Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features).

**This repo:**
[`harness-native-projection-channels.md`](./harness-native-projection-channels.md);
issue [#874](https://github.com/taylorfsteele/cogwork/issues/874).
