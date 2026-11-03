# TanStack AI after 1.0.0: Skills, Subagents, Commands, and Instructions on the external Harnesses

Date: 2026-11-03. All sources accessed on 2026-11-03.

**Scope and method.** Issue [#874](https://github.com/taylorfsteele/cogwork/issues/874) asks the
external Harnesses to project the Skills, Subagents, and Commands of a Run Plan, and to keep the
driven Worktree clean. The note
[`harness-native-projection-channels.md`](./harness-native-projection-channels.md) maps the native
channels of each CLI. It found that TanStack's Workspace projection at 1.0.0 is not a channel: it
writes Skills into the checkout, it has no Subagent kind, and it writes `<root>/AGENTS.md`. This
note asks whether a newer TanStack AI release changes that. It answers four questions:

1. What is the latest published version of each package, and are there new adapter packages?
2. What changed after 1.0.0 for Skills, Subagents, Commands, instruction files, the projection
   root, Codex Skill delivery, Claude Code `agents` / plugins / `settingSources`, and ACP session
   parameters?
3. Does TanStack AI have a harness-agnostic Subagent or Skill type, and how does each adapter
   render it? Can it make a Codex Subagent read-only?
4. What does an upgrade from 1.0.0 cost cogwork?

Sources are primary only:

- The npm registry: `npm view <pkg> versions`, `npm view <pkg> time`, and `npm search`.
- The `TanStack/ai` GitHub repository: release notes (`gh api repos/TanStack/ai/releases`), the
  commit log on `main`, the unreleased files in `.changeset/`, the package `CHANGELOG.md`, the docs,
  and the issue and pull request search.
- Tarballs from `npm pack` into `/tmp/tsai/pack`: `@tanstack/ai-sandbox@1.0.0`,
  `@tanstack/ai-claude-code@1.0.0`, `@tanstack/ai-codex@1.0.0`, `@tanstack/ai-acp@1.0.0`,
  `@tanstack/ai-skills@1.0.0`, `@tanstack/ai-harness@0.1.1`, and `@tanstack/ai@1.0.0` and `1.0.1`.
  Each tarball ships its `src/` folder. File paths below are relative to `package/` in the tarball.
- The vendored Codex source at `.repos/codex`, revision `4aa52f2`, for one timeout constant.
- The cogwork source for the upgrade cost. I installed nothing into the cogwork workspace.

I mark a claim **(inference)** when no source states it. I mark a claim **thin evidence** when only
a weak or indirect source supports it.

---

## TL;DR

1. **No harness package has a release after 1.0.0.** `@tanstack/ai-sandbox`, `ai-claude-code`,
   `ai-codex`, `ai-acp`, `ai-skills`, and `ai-sandbox-local-process` are all at 1.0.0
   (2026-10-22). Cogwork already runs these versions. Only `@tanstack/ai` and a few provider and
   persistence packages moved to 1.0.1 (2026-10-29), with no API change.
2. **`main` has no unreleased change to projection either.** After the 1.0.0 tags, the adapter
   sources changed only in two abort-signal pull requests,
   [TanStack/ai#1976](https://github.com/TanStack/ai/pull/1976) and
   [#1978](https://github.com/TanStack/ai/pull/1978). Every gap that the earlier note found is still
   in the latest code.
3. **The `AGENTS.md` / `CLAUDE.md` overwrite is not fixed and not configurable.** `bootstrap.ts`
   writes `<root>/AGENTS.md` when the Workspace has `instructions`, an `AGENTS.md` file Skill, or
   `scripts`. `writeAgentsFile` then runs `ln -s AGENTS.md CLAUDE.md`. That command fails when the
   repo has a committed `CLAUDE.md`, and the fallback overwrites the file. The name list is a module
   constant.
4. **The projection root is one field, `workspace.root`.** The same value sets the clone root, the
   `AGENTS.md` location, the projection root, and the git baseline and file watch. On the
   local-process provider, a path outside `/workspace` passes through as-is. So the root can point
   outside the checkout, but it moves all of these together. And Codex does not read a
   `.codex/skills` folder outside its project root **(inference)**.
5. **No Workspace Subagent or Command kind exists, and the Claude Code adapter has no `agents` or
   `--plugin-dir` option.** Its options stay `settingSources`, `addDirs`, and `claudeExecutable`.
   The `claudeExecutable` string is still the only way to add `--agents` or `--plugin-dir`.
6. **TanStack has portable types, but they are TanStack-run emulations, not native members.**
   `defineAgent` (in `@tanstack/ai`) becomes a tool through `chat({ subagents })`. `withSkills`
   (in `@tanstack/ai-skills`) adds a Skill catalog to the system prompts and a `load_skill` tool.
   All three CLI adapters send `chat()` tools to the CLI through the host MCP tool bridge and
   send system prompts through their own channel. So both types reach Claude Code, Codex, and
   Cursor with no file in the Worktree **(inference: the source paths agree, but no TanStack test
   covers a CLI adapter with these types)**.
7. **TanStack's one coding-agent "read-only" mode is a whole read-only CLI process.**
   `codingAgents` in `@tanstack/ai-sandbox/harness` makes each CLI a Subagent of a TanStack lead
   model. In `plan` mode it passes `sandboxMode: 'read-only'` to Codex and `permissionMode: 'plan'`
   to Claude Code. It fails closed for an ACP agent. It does not make a native Codex role read-only.
8. **For Codex Skills, the only new route outside the Worktree is `withSkills` over a host
   folder.** It needs no Codex change. It is not a native Skill: the model must call `load_skill`,
   and Codex still loads its own ambient Skills **(inference)**.
9. **The upgrade cost is close to zero.** Bump `@tanstack/ai`, `ai-openai`, `ai-gemini`, and
   `ai-persistence` to 1.0.1. The patches have no breaking change. The next release adds optional
   `{ signal }` arguments to the Sandbox contract. Cogwork's Sandbox wrapper re-declares `clone`,
   `push`, and `pull` with one argument, so it compiles but drops those signals **(inference)**.

---

## Version table

`npm view <pkg> dist-tags` and `npm view <pkg> time`, read on 2026-11-03. "Cogwork" is the
`pnpm-workspace.yaml` catalog.

| Package | Cogwork | Latest | Published | Previous |
|---|---|---|---|---|
| `@tanstack/ai-sandbox` | 1.0.0 | 1.0.0 | 2026-10-22 | 0.5.25 (2026-10-21) |
| `@tanstack/ai` | 1.0.0 | **1.0.1** | 2026-10-29 | 1.0.0 (2026-10-22) |
| `@tanstack/ai-claude-code` | 1.0.0 | 1.0.0 | 2026-10-22 | 0.9.2 (2026-10-21) |
| `@tanstack/ai-codex` | 1.0.0 | 1.0.0 | 2026-10-22 | 0.6.2 (2026-10-21) |
| `@tanstack/ai-acp` | 1.0.0 | 1.0.0 | 2026-10-22 | 0.3.27 (2026-10-21) |
| `@tanstack/ai-skills` | not used | 1.0.0 | 2026-10-22 | 0.1.21 (2026-10-21) |
| `@tanstack/ai-sandbox-local-process` | 1.0.0 | 1.0.0 | 2026-10-22 | 0.2.6 |
| `@tanstack/ai-persistence` | 1.0.0 | **1.0.1** | 2026-10-29 | 1.0.0 |
| `@tanstack/ai-openai`, `ai-gemini` | 1.0.0 | **1.0.1** | 2026-10-29 | 1.0.0 |
| `@tanstack/ai-anthropic` | 1.0.0 | 1.0.0 | 2026-10-22 | — |

New packages from `npm search @tanstack/ai-`:

| Package | Latest | First published | What it is |
|---|---|---|---|
| `@tanstack/ai-harness` | 0.1.1 (2026-10-29) | 0.1.0 on 2026-10-22 | "Build agent harnesses on TanStack AI: long-lived sessions, typed agents, and plugins" |
| `@tanstack/ai-harness-cli` | 0.1.0 (2026-10-22) | 2026-10-22 | "Run a TanStack AI harness from the terminal … ACP, MCP, and an HTTP server" |

The other harness adapters are not new. `@tanstack/ai-opencode` and `@tanstack/ai-grok-build`
are at 1.0.0 and first shipped on 2026-06-30. `@tanstack/ai-grok-build` depends on
`@tanstack/ai-acp`. `@tanstack/ai-code-mode-skills` stays at 0.3.14 (2026-08-10).

---

# Question 1 and 2 — What changed after 1.0.0

## Releases

The GitHub releases after the 1.0.0 batch (2026-10-22) are `@tanstack/ai@1.0.1` and
`@tanstack/ai-harness@0.1.1`, both on 2026-10-29.

- `@tanstack/ai@1.0.1`: [#1904](https://github.com/TanStack/ai/pull/1904) fixes README badges.
  [#1912](https://github.com/TanStack/ai/pull/1912) removes the `@experimental` tags from video
  generation.
- `@tanstack/ai-harness@0.1.1`: [#1913](https://github.com/TanStack/ai/pull/1913) fixes a
  TypeScript 7.1 circularity in `HarnessAgentsOf`.
- `@tanstack/ai-gemini@1.0.1` adds [#1897](https://github.com/TanStack/ai/pull/1897) (built-in
  tools beside function tools). `@tanstack/ai-persistence@1.0.1` changes only its agent Skill docs
  ([#1918](https://github.com/TanStack/ai/pull/1918), [#1921](https://github.com/TanStack/ai/pull/1921)).

None of these touches Skills, Subagents, Commands, instruction files, or projection.

## Unreleased work on `main`

On 2026-11-03, `main` is 37 commits ahead of the `@tanstack/ai-sandbox@1.0.0` tag. The commits that
change `packages/{ai-sandbox,ai-claude-code,ai-codex,ai-acp,ai-skills}/src` are:

| Commit | Pull request | Files in the adapter packages |
|---|---|---|
| `5f62940bb` | [#1976](https://github.com/TanStack/ai/pull/1976) "stop the work under a run when the run aborts" | `ai-claude-code/src/adapters/text.ts` (+3 −1), `ai-codex/src/adapters/text.ts` (+3 −1), `ai-acp/src/agent/index.ts`, `ai-sandbox/src/runner.ts`, `snapshot-tools.ts` |
| `4caefd7cb` | [#1978](https://github.com/TanStack/ai/pull/1978) "optional abort signals for agents, sandboxes, and MCP" | `ai-sandbox/src/contracts.ts`, `git-exec.ts`, `tool-bridge.ts` |

`ai-skills/src` has no commit after the tag. The pending changesets for these packages
(`.changeset/`) are:

- `abort-cli-agent-tool-bridge-claude-code.md` and `…-codex.md` (patch): "The host tool bridge now
  gets the run signal from `chat()`."
- `abort-acp-question-elicitation.md` (patch): the ACP *agent* side sends `$/cancel_request` for an
  open question form.
- `ai-sandbox-abort-signal-agents.md` (minor): "New optional signals on the sandbox contract:
  `git.clone({ signal })`, `git.push(dir, { signal })`, `git.pull(dir, { signal })`,
  `snapshot(label, { signal })`, `fork({ signal })`, and `ports.connect(port, { signal })`."
- `ai-sandbox-tool-bridge-call-signal.md` (minor): `ToolBridgeCore.callTool(name, args, { signal })`.
- `abort-sandbox-spawn-ndjson.md` (patch): `spawnNdjson` kills the agent process when the consumer
  stops reading early.

## Issues and pull requests

I searched `TanStack/ai` issues and pull requests for: `subagent`, `skills`, `skills outside
workspace`, `AGENTS.md`, `CLAUDE.md`, `agents file`, `writeAgentsFile`, `instructions overwrite`,
`worktree`, `projection`, `settingSources`, `plugin-dir`, `skillsDir`, `codex skills`, and
`agents codex`.

- **No issue or pull request asks for Skills outside the Workspace, a Workspace Subagent kind, a
  Command kind, or a configurable instruction file.** No issue reports the `AGENTS.md` or
  `CLAUDE.md` overwrite.
- The `subagent` results are all about TanStack's own `defineAgent` children: limits, resume, and
  persistence ([#1438](https://github.com/TanStack/ai/pull/1438),
  [#1509](https://github.com/TanStack/ai/pull/1509), [#1723](https://github.com/TanStack/ai/pull/1723),
  [#1879](https://github.com/TanStack/ai/pull/1879); open issue
  [#1878](https://github.com/TanStack/ai/issues/1878)).
- [#1113](https://github.com/TanStack/ai/issues/1113) (closed 2026-08-25) asked to expose
  `--setting-sources` and to forward the init message's Skill list.
  [#1153](https://github.com/TanStack/ai/pull/1153) shipped both. The 1.0.0 adapter forwards
  `skills: sdkMessage.skills ?? []` (`src/stream/translate.ts:662`). A Run can use that list to
  confirm which Skills Claude Code loaded **(inference)**.
- [#1771](https://github.com/TanStack/ai/pull/1771) added `codingAgents` (see Question 3).
- [#1081](https://github.com/TanStack/ai/issues/1081) and [#1094](https://github.com/TanStack/ai/pull/1094)
  (August 2026) fixed headless Daytona runs. The sandbox changelog says "Nested skills project by
  name." That change is in 1.0.0 already.

## Current state at the latest version (1.0.0), by topic

Because no release followed 1.0.0, this section describes the latest code. It confirms the gaps in
[`harness-native-projection-channels.md`](./harness-native-projection-channels.md) against source.

### Skills

`WorkspaceSkill` (`src/workspace.ts:70-82`) has four kinds: `file`, `agent-skill`, `mcp`, and
`git`. Each adapter projector writes under `projection.root`:

| Kind | Claude Code (`ai-claude-code/src/adapters/projection.ts`) | Codex (`ai-codex/src/adapters/projection.ts`) | ACP (`ai-acp/src/adapters/projection.ts`) |
|---|---|---|---|
| `git` | Link to `<root>/.claude/skills/<name>`, else `cp -r` | Link to `<root>/.codex/skills/<name>`, else `cp -r` | Link to `<root>/<skillsDir>/<name>`; warn and skip with no `skillsDir` |
| `agent-skill` | Warn and skip | Warn and skip | Warn and skip |
| `mcp` | Write `<root>/.mcp.json` | Write `<root>/.codex/config.toml` | Pass in `session/new` `mcpServers` |
| `file` | Bootstrap writes `<root>/<path>` | Same | Same |

The default `gitSkill` clone folder is `<root>/.tanstack-skills/<repo>` (`src/agents-file.ts`
`resolveGitSkillDir`). The projection marker is `<root>/.tanstack-projected-<hash>`
(`src/middleware.ts:908`). So every Skill kind except `mcp` on ACP puts files in the checkout.

### Subagents and Commands

No Workspace kind exists for either. `WorkspaceDefinition` (`src/workspace.ts:117-145`) has
`source`, `packageManager`, `setup`, `scripts`, `skills`, `instructions`, `plugins`, `secrets`, and
`root`. `scripts` are named shell commands that bootstrap lists in `AGENTS.md`. They are not
Harness Commands.

### Instruction files

`bootstrapWorkspace` (`src/bootstrap.ts:120-141`) sets the `AGENTS.md` content from, in order:
`workspace.instructions` when it is not empty, else a `fileSkill` whose path is `AGENTS.md`. Then
`mergeAgentsContent` appends a `## Workspace scripts` section when `workspace.scripts` is set. If
the result is not empty, `writeAgentsFile(handle, root, content)` runs (`src/agents-file.ts:124-141`):

1. `handle.fs.write(<root>/AGENTS.md, content)`. This replaces a committed `AGENTS.md`.
2. For each name in `SYMLINK_NAMES = ['CLAUDE.md', 'GEMINI.md']`, it runs
   `ln -s 'AGENTS.md' '<name>'`. The command has no `-f`. If the target exists, `ln` fails.
3. On a non-zero exit, it writes `content` to `<root>/<name>`. This replaces a committed
   `CLAUDE.md` or `GEMINI.md`.

`SYMLINK_NAMES` is a module constant, and `writeAgentsFile` takes no option for it. So the only
ways to stop the writes are: leave `instructions` empty, add no `AGENTS.md` file Skill, and leave
`scripts` unset. The third trigger is new to this note. A future Workspace `scripts` entry in
cogwork would write `AGENTS.md` even under `system-prompt` instruction projection **(inference
from the code path; cogwork sets no `scripts` today)**.

### Projection root

One field, `workspace.root` (default `/workspace`), drives all of these:

- The bootstrap clone target, the `AGENTS.md` folder, and the folder for `file` Skills
  (`src/bootstrap.ts:64-147`).
- The projection root and marker that the adapter projectors use (`src/middleware.ts:893-909`).
- The git baseline (`git rev-parse HEAD`) and the file watcher root (`src/middleware.ts:855-959`).
- The snapshot restore root (`src/middleware.ts:806-808`).

`resolveHarnessCwd` (`src/harness-cwd.ts`) maps `/workspace` and `/workspace/…` to the
local-process handle id, which is the bound folder. It returns any other path unchanged. So on
local-process, `workspace.root` can name a host folder outside the checkout. But then the git
baseline and the watcher look at that folder, not the checkout. The CLI's working folder is a
separate adapter option (`cwd`), so the CLI still runs in the checkout **(inference)**.

Cogwork already overrides the projection capability: `satisfiedProjection`
(`packages/engine/src/external-harness-runtime.ts:335-353`) provides a projection whose marker is
`<root>/.git`, so the projector returns before it writes. Cogwork could provide a projection with
its own `root` the same way, and leave `workspace.root` alone. That moves only the projector writes.
It does not help Codex: Codex reads `.codex/skills` only for project layers from the project root
down to the cwd, so a `.codex/skills` folder outside the checkout is never read
(`codex-rs/ext/skills/src/host_roots.rs:137-185`, from the earlier note) **(inference)**. It helps
Claude Code only with `--add-dir <folder>` and the `project` setting source, and cogwork passes
`--setting-sources ""`.

### Codex Skill delivery

Unchanged. The projector comment still says "Codex has no documented project skills dir" and
"Codex has no plugin concept" (`ai-codex/src/adapters/projection.ts:13-17`). The earlier note shows
both claims are out of date for `codex-cli 0.166.0`. `CodexTextConfig`
(`ai-codex/src/adapters/text.ts`) has `cwd`, `sandboxMode`, `approvalPolicy`,
`modelReasoningEffort`, `skipGitRepoCheck`, `networkAccessEnabled`, `webSearchMode`,
`additionalDirectories`, `codexExecutable`, `authMode`, `env`, and `config`. No option adds a Skill
root.

### Claude Code `agents`, plugins, and `settingSources`

`ClaudeCodeTextConfig` (`ai-claude-code/src/adapters/text.ts:76-123`) has `cwd`, `permissionMode`,
`allowedTools`, `disallowedTools`, `addDirs`, `maxTurns`, `settingSources`, `systemPromptMode`,
`claudeExecutable`, `streamPartials`, `env`, `authMode`, and `emitDiff`. There is no `agents`,
`pluginDirs`, or extra-arguments option.

- `settingSources` defaults to `['project']`. The adapter always emits `--setting-sources <list>`
  (`text.ts:285-294`).
- `claudeExecutable` is still split on spaces (`text.ts:281`). This is how cogwork can add
  `--agents <file>` and `--plugin-dir <dir>` with no adapter change, if no path has a space.
- Workspace `plugins` run `claude plugin install <name> --scope project` in the checkout
  (`projection.ts:186-206`). Under `--setting-sources ""` the CLI would not load a project-scope
  plugin **(inference, as in the earlier note)**.

### ACP session parameters

`startAcpSession` sends only `cwd` and `mcpServers` in `session/new` and `session/load`
(`ai-acp/src/session/acp-client.ts:181-203`). The harness options still include `skillsDir`
(`ai-acp/src/adapters/compatible.ts:131-139`), which links `gitSkill`s into the checkout. The
1.0.0 release adds `createAcpAgent` and `serveAcp` under `@tanstack/ai-acp/agent` and pins
`@agentclientprotocol/sdk` to `~1.8.0`. That is the agent side: it serves a TanStack harness to an
editor. It adds nothing to the client side that cogwork uses for Cursor.

---

# Question 3 — Harness-agnostic Subagent and Skill types

TanStack AI 1.0 has three portable types. None of them writes a native Harness member. Each one
runs in TanStack code and reaches the CLI as a tool or as system prompt text.

## `defineAgent` and `chat({ subagents })` (`@tanstack/ai`)

`DefinedAgent` (`src/activities/chat/agents/define-agent.ts`) has `name`, `description`, `run`,
and optional `inputSchema` and `produces`. `run` gets a context with `ctx.chat`, `ctx.forward`, and
`ctx.keys`. It usually starts a child `chat()` with any adapter. In tool mode, `chat()` adds one
synthetic tool for each agent (`createSyntheticSubagentTools`, `src/activities/chat/index.ts:6462`).
The file says: "In tool mode, the parent model writes it when it calls this agent's tool."

All three CLI adapters provision a host MCP tool bridge for the `chat()` tools:
`ai-claude-code/src/adapters/text.ts:516`, `ai-codex/src/adapters/text.ts:349`, and
`ai-acp/src/adapters/compatible.ts:452-458`. The bridge's MCP server name is `tanstack`
(`ai-sandbox/src/tool-bridge.ts:38`). So a `defineAgent` given to a Run's `chat()` reaches each CLI
as the MCP tool of that name **(inference: no TanStack test covers a CLI adapter as the parent of a
`defineAgent`)**.

How each adapter renders it:

| Harness | Rendering | Notes |
|---|---|---|
| Claude Code | MCP tool `mcp__tanstack__<tool>` from `--mcp-config <file>` | The adapter writes `.tanstack-mcp-bridge-<runId>.json`, which holds the bearer token, into the cwd (the checkout) and deletes it after the Run (`text.ts:547-561`) |
| Codex | MCP tool from `--config mcp_servers.tanstack.url=…` and `http_headers` | The bearer token is in argv (`text.ts:279-280`). Codex's default MCP tool timeout is 300 s (`codex-rs/codex-mcp/src/rmcp_client.rs:98`). A longer child run needs `mcp_servers.tanstack.tool_timeout_sec` through `config` **(inference)** |
| Cursor (ACP) | MCP server in `session/new` `mcpServers` | Cursor's own tool timeout is not documented **(thin evidence)** |

This is not a native Subagent. The CLI sees one more MCP tool. It does not see a Claude Code
`--agents` entry, a Codex role, or a Cursor agent file. The child runs in the engine process, with
the adapter that `run` picks. A Run Plan that projects a Subagent this way gets an emulation, which
is the "semantic equivalent" option in the #874 triage.

## `codingAgents` (`@tanstack/ai-sandbox/harness`, for `@tanstack/ai-harness`)

`codingAgents({ sandbox, agents, workspace? })` (`ai-sandbox/src/harness.ts`) is a harness plugin.
It turns each coding CLI into a `defineAgent` with one `task` input. The lead is a TanStack model
under `defineHarness`, not a CLI. The docs page "Delegate to coding agents" says: "`codingAgents`
gives the lead model one tool per coding agent."

Read-only behavior (`harness.ts:43-46`, `148-158`):

- In the harness `plan` mode, the plugin merges `planModelOptions`, else a default:
  `'claude-code': { permissionMode: 'plan' }` and `codex: { sandboxMode: 'read-only' }`.
- Any other adapter has no default. The call fails closed with "cannot run in plan mode: it has no
  planModelOptions". This includes `acpCompatibleText`, so Cursor needs an explicit option.

So TanStack makes a Codex child read-only only by starting a separate `codex exec` process with
`--sandbox read-only`. That process is the whole child. It is not a role inside the parent Codex
session, and it does not change the fact from the earlier note: a native Codex role cannot set
`sandbox_mode`. Cogwork could get a read-only Codex Subagent the same way, with `defineAgent`
running a second `codexText(…, { sandboxMode: 'read-only' })` behind the bridge. That costs a
second CLI process and its own login check, the 300 s tool timeout, and Codex's native spawn and
wait tools **(inference)**.

`@tanstack/ai-harness` is 0.x and is a different runtime: a long-lived TanStack session that owns
the conversation. Cogwork drives the CLI as the main agent of a Run, so `codingAgents` itself does
not fit the external Harness runtime **(inference)**.

## `withSkills` (`@tanstack/ai-skills`)

The README says: "`withSkills` renders a short catalog of the skills you offer into the system
prompt and gives the model a `load_skill` tool." Sources are `inlineSkill`, `skillDirectory` (in
`/node`, which walks a host folder of `SKILL.md` files), `staticSkills`, or a custom
`SkillSource`. A second tool, `read_skill_resource`, reads files under `references/` or `assets/`
(`src/tools/read-resource.ts`). The middleware adds its prompt in `onConfig` to
`config.systemPrompts` (`src/middleware.ts:173-229`).

How the system prompt reaches each adapter:

| Harness | System prompt channel | Tool channel |
|---|---|---|
| Claude Code | `--append-system-prompt` (`ai-claude-code/src/adapters/text.ts:341-351`) | Host MCP bridge |
| Codex | Prepended to the prompt text (`ai-codex/src/adapters/text.ts:364-369`) | Host MCP bridge |
| Cursor (ACP) | Prepended to the prompt text (`ai-acp/src/adapters/compatible.ts:323-327`) | Host MCP bridge in `mcpServers` |

So `withSkills(skillDirectory(<host folder>))` delivers Skills to all three CLIs with no file in
the Worktree **(inference: the source paths agree; the TanStack tests I found use API adapters)**.
Limits:

- The CLI does not treat these as its own Skills. The model must call `load_skill`. Claude Code's
  `/skill` names, Codex's `$skill` mentions, and Cursor's Skill picker do not list them **(inference)**.
- Codex still loads `~/.agents/skills` and `<repo>/.agents/skills` by itself. A member in those
  trees can arrive twice: once native and once in the catalog **(inference)**.
- A Skill script runs only if the agent can reach its path. On local-process the host folder is
  readable, so `load_skill` can name absolute paths **(inference)**.
- The `@tanstack/ai-skills/harness` `skills({ dirs })` plugin turns each Skill into a `/<name>`
  command. It works only in a `@tanstack/ai-harness` session, not in a CLI Run. TanStack has no
  Command type that a CLI adapter renders.

## Answers per adapter

| Harness | Native Subagent through TanStack | Portable Subagent (`defineAgent`) | Native Skill outside the Worktree through TanStack | Portable Skill (`withSkills`) |
|---|---|---|---|---|
| Claude Code | None. Cogwork can add `--agents` through `claudeExecutable` | MCP tool **(inference)** | None. Cogwork can add `--plugin-dir` through `claudeExecutable` | Catalog in `--append-system-prompt`, `load_skill` tool **(inference)** |
| Codex | None. Cogwork can add `-c agents.<name>.*` through `config` | MCP tool; read-only only as a second CLI process **(inference)** | None | Catalog in the prompt, `load_skill` tool **(inference)** |
| Cursor (ACP) | None | MCP tool **(inference)** | None | Catalog in the prompt, `load_skill` tool **(inference)** |

---

# Question 4 — Upgrade cost

Cogwork's catalog pins every harness package at 1.0.0, which is the latest. So the upgrade is a
patch bump of four packages:

| Package | From | To | Breaking | Effect on cogwork |
|---|---|---|---|---|
| `@tanstack/ai` | 1.0.0 | 1.0.1 | No | README badges; `@experimental` tags removed from video generation |
| `@tanstack/ai-openai` | 1.0.0 | 1.0.1 | No | Same two changes |
| `@tanstack/ai-gemini` | 1.0.0 | 1.0.1 | No | Adds built-in tools beside function tools on Gemini 3 |
| `@tanstack/ai-persistence` | 1.0.0 | 1.0.1 | No | Agent Skill docs only |

Cost of the next release (from `.changeset/`, not yet on npm):

- `@tanstack/ai-sandbox` gets a **minor** release with optional `{ signal }` arguments on
  `git.clone`, `git.push`, `git.pull`, `snapshot`, `fork`, and `ports.connect`. Cogwork wraps the
  local-process handle in `sandboxWithCurrentEnvironment`
  (`packages/engine/src/external-harness-runtime.ts:766-791`). That wrapper re-declares `clone`,
  `push`, and `pull` with one argument. A function with fewer parameters still satisfies the
  contract, so the typecheck passes, but the wrapper drops the new signal **(inference)**. To keep
  the signal, pass the second argument through.
- `spawnNdjson` kills the agent process when the reader stops early. This is a behavior change.
  It makes a cancelled Run stop sooner **(inference)**.
- The Claude Code and Codex bridge patches make a stopped Run abort bridged tools. Cogwork bridges
  no tool today, so nothing changes until it does **(inference)**.

To use `withSkills`, cogwork adds `@tanstack/ai-skills@1.0.0`. To use `codingAgents`, it adds
`@tanstack/ai-harness@0.1.x`, which is a 0.x API and a different runtime model. Neither is an
upgrade; each is a design change for #874.

---

# What this means for #874

These are options, not decisions. Each one comes from the evidence above **(inference throughout)**.

- **Do not wait for TanStack.** No release, pending changeset, issue, or pull request moves toward
  native Skills, Subagents, or Commands outside the Workspace. The native channels in the earlier
  note stay the plan: Claude Code `--agents` and `--plugin-dir` through `claudeExecutable`, Codex
  `-c agents.<name>.*` through `config`, and a Cursor `--plugin-dir` probe.
- **Fix the Cursor instruction write now.** Set the Cursor descriptor's
  `transport.instructionProjection` to `"system-prompt"`. The ACP adapter already prepends system
  prompts. Keep `workspace.scripts` unset on every descriptor, because it also triggers the write.
- **Codex Skills have one route outside the Worktree: an emulated channel.** `withSkills` over the
  provisioned host folder carries the private workspace overlay that Codex cannot read natively.
  The Run Plan must record it as an emulation, not as a native projection. The duplicate-arrival
  policy must cover the two Authoring trees that Codex reads by itself.
- **A read-only Codex Subagent is possible only as a separate read-only Codex process behind a
  tool.** If #874 needs read-only Subagents on Codex, this is the only mechanism, and it has the
  costs listed in Question 3.
- **Upstream asks, if wanted:** a `writeAgentsFile` option for the names it links, or a skip when
  a target exists; a projection root separate from the clone and watch root; and an `agents` /
  `pluginDirs` option on `ClaudeCodeTextConfig`. No issue exists for any of them.

---

## Thin evidence and unverified claims

- `defineAgent` and `withSkills` with a CLI adapter as the parent. The source paths agree, but I
  found no TanStack test or example for this combination.
- How the three CLIs treat the bridged `load_skill` result: whether the model calls it without a
  native Skill prompt.
- Whether cogwork's one-argument wrapper still typechecks against the next `@tanstack/ai-sandbox`
  contract. It should, by TypeScript's parameter rules, but the release is not out.
- Cursor's MCP tool timeout for a long bridged child run.
- That `workspace.root` outside `/workspace` gives a working Run. I read the path mapping, but I did
  not run it.
- That Codex never reads a `.codex/skills` folder outside its project root. This rests on the
  vendored Codex revision `4aa52f2`, not on `codex-cli 0.166.0`.

---

## Sources

**npm registry** (read 2026-11-03): `npm view <pkg> versions --json`, `dist-tags`, and `time --json`
for `@tanstack/ai-sandbox`, `@tanstack/ai`, `@tanstack/ai-claude-code`, `@tanstack/ai-codex`,
`@tanstack/ai-acp`, `@tanstack/ai-skills`, `@tanstack/ai-sandbox-local-process`,
`@tanstack/ai-harness`, `@tanstack/ai-harness-cli`, `@tanstack/ai-opencode`,
`@tanstack/ai-grok-build`; `npm search @tanstack/ai- --searchlimit 100`.

**TanStack/ai GitHub** (read 2026-11-03):
releases `@tanstack/ai@1.0.0`, `@tanstack/ai@1.0.1`, `@tanstack/ai-sandbox@1.0.0`,
`@tanstack/ai-claude-code@1.0.0`, `@tanstack/ai-codex@1.0.0`, `@tanstack/ai-acp@1.0.0`,
`@tanstack/ai-skills@1.0.0`, `@tanstack/ai-harness@0.1.0`, `@tanstack/ai-harness@0.1.1`,
`@tanstack/ai-openai@1.0.1`, `@tanstack/ai-gemini@1.0.1`, `@tanstack/ai-persistence@1.0.1`;
the compare `@tanstack/ai-sandbox@1.0.0...main`; per-path commit history since 2026-10-22;
commits [`5f62940bb`](https://github.com/TanStack/ai/commit/5f62940bb) and
[`4caefd7cb`](https://github.com/TanStack/ai/commit/4caefd7cb);
`.changeset/abort-cli-agent-tool-bridge-claude-code.md`, `abort-cli-agent-tool-bridge-codex.md`,
`abort-acp-question-elicitation.md`, `ai-sandbox-abort-signal-agents.md`,
`abort-sandbox-spawn-ndjson.md`, `ai-sandbox-tool-bridge-call-signal.md`;
`packages/ai-sandbox/CHANGELOG.md`; `docs/harness/coding-agents.md`;
issues [#1081](https://github.com/TanStack/ai/issues/1081),
[#1113](https://github.com/TanStack/ai/issues/1113), [#1878](https://github.com/TanStack/ai/issues/1878);
pull requests [#1094](https://github.com/TanStack/ai/pull/1094), [#1153](https://github.com/TanStack/ai/pull/1153),
[#1236](https://github.com/TanStack/ai/pull/1236), [#1438](https://github.com/TanStack/ai/pull/1438),
[#1509](https://github.com/TanStack/ai/pull/1509), [#1723](https://github.com/TanStack/ai/pull/1723),
[#1756](https://github.com/TanStack/ai/pull/1756), [#1771](https://github.com/TanStack/ai/pull/1771),
[#1840](https://github.com/TanStack/ai/pull/1840), [#1879](https://github.com/TanStack/ai/pull/1879),
[#1897](https://github.com/TanStack/ai/pull/1897), [#1904](https://github.com/TanStack/ai/pull/1904),
[#1912](https://github.com/TanStack/ai/pull/1912), [#1913](https://github.com/TanStack/ai/pull/1913),
[#1918](https://github.com/TanStack/ai/pull/1918), [#1921](https://github.com/TanStack/ai/pull/1921),
[#1976](https://github.com/TanStack/ai/pull/1976), [#1978](https://github.com/TanStack/ai/pull/1978).

**Tarballs** (`npm pack` into `/tmp/tsai/pack`):
`@tanstack/ai-sandbox@1.0.0` `src/{workspace,projection,agents-file,bootstrap,middleware,harness-cwd,harness,tool-bridge}.ts`;
`@tanstack/ai-claude-code@1.0.0` `src/adapters/{text,projection}.ts`, `src/provider-options.ts`,
`src/stream/{translate,sdk-types}.ts`;
`@tanstack/ai-codex@1.0.0` `src/adapters/{text,projection}.ts`;
`@tanstack/ai-acp@1.0.0` `src/adapters/{compatible,projection}.ts`, `src/session/acp-client.ts`;
`@tanstack/ai-skills@1.0.0` `README.md`, `src/{index,middleware}.ts`,
`src/tools/{load-skill,read-resource}.ts`, `src/node/index.ts`;
`@tanstack/ai@1.0.1` `src/activities/chat/agents/{define-agent,spawn}.ts`,
`src/activities/chat/index.ts`; `@tanstack/ai-harness@0.1.1` `package.json`.

**Codex** (vendored `.repos/codex` at `4aa52f2`): `codex-rs/codex-mcp/src/rmcp_client.rs`;
`codex-rs/ext/skills/src/host_roots.rs` (through the earlier note).

**This repo:**
[`harness-native-projection-channels.md`](./harness-native-projection-channels.md);
[`external-harness-runtime.ts`](../../packages/engine/src/external-harness-runtime.ts);
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml);
[`packages/engine/CONTEXT.md`](../../packages/engine/CONTEXT.md);
issue [#874](https://github.com/taylorfsteele/cogwork/issues/874).
