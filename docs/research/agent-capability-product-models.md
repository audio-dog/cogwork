# Agent capability and configuration product models

Resolves [Research capability and Plugin models in Cursor, Codex, and Claude Code](https://github.com/colonylabs/cogwork/issues/136), part of [Wayfinder: unify settings, Plugins, and agent capabilities](https://github.com/colonylabs/cogwork/issues/124).

Research date: 2026-08-20. Sources are current first-party product documentation.

## Question

How do Cursor, Codex, and Claude Code model Plugins, skills, instructions, MCP servers, commands,
hooks, subagents, scope, enablement, versioning, provenance, and the capabilities available to an
agent? Which patterns fit Cogwork, and what cannot safely be delegated to an external Harness?

## Findings

1. **A Plugin is consistently a distribution and setup unit, not a new kind of runtime
   capability.** Cursor Plugins bundle rules, skills, agents, commands, MCP servers, and hooks;
   OpenAI Plugins combine skills with optional MCP-backed connections; Claude Code Plugins bundle
   skills, agents, hooks, MCP servers, and related components. All three keep the contributed parts
   visible as distinct component types after installation.
2. **The products converge on broad, shared, and private-per-repository inputs.** Checked-in project
   files are first-class everywhere. Claude Code additionally names the missing Cogwork use case
   directly: `local` configuration belongs to one repository but lives outside shared project
   configuration.
3. **Resolution is type-specific.** Instructions concatenate or merge; named MCP servers and
   subagents select one winner; hooks usually accumulate; skills may coexist or use namespaces.
   One universal "closest scope wins" rule would misrepresent all three products.
4. **Availability, enablement, and use are separate states.** An installed Plugin can be disabled;
   an MCP server can exist but be disconnected or unauthenticated; a skill can be discoverable but
   never selected. None of these states proves that a required capability was supplied to a Run.
5. **External Harness controls are uneven.** Claude Code exposes the strongest headless isolation
   flags. Cursor ACP can supply MCP servers to a session but otherwise relies heavily on ambient
   Cursor discovery. Codex has layered config and repository discovery, but no documented input that
   supplies an exact, complete capability inventory for one Run.
6. **Cogwork must resolve and validate required capabilities before Harness dispatch.** Prompt text
   can guide an agent; it cannot enforce the presence of a tool, Connection, executable, or
   compatible Harness feature.

## Observed product models

### Comparison

| Concern | Cursor | Codex | Claude Code |
| --- | --- | --- | --- |
| Plugin shape | Cursor Plugin: rules, skills, agents, commands, MCP, hooks. Agent Plugin: portable skills and MCP. | Skills plus optional MCP server/connector and UI; Codex-only hooks can also be included. | Skills, agents, hooks, MCP, LSP, monitors, executables, limited default settings. |
| Primary management surface | **Customize** manages Plugins and individual components at user, workspace, and team scopes. | **Plugins** installs packages; Skills, MCP, hooks, config, and agents also have dedicated surfaces/files. | `/plugin` discovers and manages packages; `/hooks`, `/mcp`, `/agents`, `/status`, and `/doctor` expose individual systems. |
| Shared repository input | `.cursor/*`, nested `AGENTS.md`, project-scoped Plugin install. | `.codex/*`, nested `AGENTS.md`, `.agents/skills`. | `.claude/*`, `.mcp.json`, `CLAUDE.md`, project-scoped Plugin install. |
| Private repository input | Workspace-scoped items are exposed in Customize, but most documented local files divide only into user and project. | Project config and component files are normally repository-local; no distinct documented private repository scope. | Explicit `local` scope: `.claude/settings.local.json`, plus project-keyed local MCP configuration in `~/.claude.json`. |
| Global personal input | User rules, skills, agents, hooks, MCP, Plugins. | User config, instructions, skills, agents, hooks, MCP, Plugins. | User settings, instructions, skills, agents, hooks, MCP, Plugins. |
| Enablement | Component toggles and rule activation modes; disabled MCP servers do not load. | Local skill enablement by file path; hooks feature flag; MCP enabled state; Plugin install/enable/remove. | Plugin enable/disable, MCP project approval, skill invocation policy, hook policy. |
| Conflict behavior | Rules merge with Team → Project → User precedence; nested instructions become more specific; details for duplicate skills are not documented. | Config selects by precedence; `AGENTS.md` concatenates root to leaf; duplicate skills are not merged and may both appear; hooks merge. | Settings override/merge by data type; MCP and subagents select one winner; instructions concatenate; hooks merge; Plugin skills are namespaced. |
| Version/provenance | Versioned manifests; Git-backed team marketplaces refresh automatically or manually; marketplace updates are reviewed. Customize filters by scope. | Versioned `.codex-plugin/plugin.json`; public, workspace, and personal catalog sources; local marketplaces for development. Current public docs do not specify a comparable resolved-version algorithm. | Explicit version or source commit SHA drives cache/update detection. `plugin list` reports version, marketplace, and enabled state; `plugin details` inventories components and token cost. |
| Runtime inspection | Customize shows configured state; MCP tooling shows configured tools. | `/mcp`, `/hooks`, `/skills`, and settings surfaces inspect parts independently. | `/status`, `/doctor`, `/mcp`, `/hooks`, `plugin list`, and `plugin details` expose source and health by subsystem. |

### Cursor

Cursor makes the strongest product case for one model with two levels of UX. Its Customize page can
install and manage Plugins, skills, MCP servers, subagents, rules, commands, and hooks and filter them
by user, workspace, or team scope. Plugins remain composable bundles: the same page exposes the
contributed MCP servers, rules, and skills individually. MCP servers can be disabled without
uninstalling their Plugin, and disabled servers do not load or appear in chat
([Customize](https://cursor.com/docs/customize-cursor),
[Plugins](https://cursor.com/docs/plugins)).

Cursor has two Plugin formats. The portable Agent Plugins standard packages skills and MCP servers
with a root `plugin.json`; Cursor Plugins add Cursor-specific rules, agents, commands, hooks, and
variables through `.cursor-plugin/plugin.json`. The manifest has a version, identity, description,
and author. Installation targets project or user scope. Team marketplaces add Default Off, Default
On, and Required installation modes. Required Plugins cannot be removed. Git-backed team
marketplaces can refresh automatically, and Cursor manually reviews every public Plugin update
([Plugins](https://cursor.com/docs/plugins)).

The component systems retain their own scope and activation rules:

- Project rules are versioned `.cursor/rules/*.mdc` files. They can be always active, selected by
  the agent, matched to file globs, or manually invoked. User rules apply globally. Team rules can
  be optional or enforced and merge with project and user rules in Team → Project → User order.
  Nested `AGENTS.md` instructions combine with parents; the more specific file takes precedence
  ([Rules](https://cursor.com/docs/rules)).
- Skills load from both `.agents/skills` and `.cursor/skills` at project and user levels. Cursor
  also scans Claude and Codex compatibility directories. A skill can be invoked for one message or
  kept active as a Custom Mode ([Skills](https://cursor.com/docs/skills)).
- Subagents load from project or user directories, including Cursor, Claude, and Codex-compatible
  locations. Cursor exposes each custom agent to the parent as a tool. Subagents normally inherit
  all parent MCP tools, while cloud subagents use team-configured cloud MCP servers instead of the
  local session's servers ([Subagents](https://cursor.com/docs/subagents)).
- MCP servers can be project-local (`.cursor/mcp.json`), user-global (`~/.cursor/mcp.json`),
  marketplace-installed, team-distributed, or registered dynamically by an extension. Customize
  combines personal, workspace, and team servers and handles OAuth setup
  ([MCP](https://cursor.com/docs/mcp)).
- Hooks exist at project, user, team, and enterprise locations. Their JSON has a schema version and
  supports `failClosed` for a hook whose failure must block an action
  ([Hooks](https://cursor.com/docs/hooks)).

Cursor's effective runtime state is still partly ambient. Cursor ACP creates or resumes a session
for a working directory and accepts an `mcpServers` list on `session/new`, but the official ACP docs
also say that project/user `.cursor/mcp.json` files are discovered and that team MCP servers are not
supported in ACP mode. ACP documents modes and permission requests, not a per-session inventory of
rules, skills, subagents, commands, hooks, and installed Plugin versions
([Cursor ACP](https://cursor.com/docs/cli/acp)).

### Codex

OpenAI separates distribution from local authoring. A Plugin is an installable package containing
skills, an MCP server, or both; supported surfaces can also receive hooks and optional UI. ChatGPT
and Codex share one universal public Plugin directory, with OpenAI, workspace, and personal
catalog sections. Codex CLI has a Plugin browser and requires a new session after installation;
the IDE extension does not currently support Plugins
([Plugins](https://learn.chatgpt.com/docs/plugins),
[Plugin architecture](https://developers.openai.com/plugins/concepts/plugins),
[Build Plugins](https://developers.openai.com/codex/build-plugins)).

Local capability authoring uses explicit layers:

- Config resolves CLI overrides, trusted project `.codex/config.toml` files from root to current
  directory, a selected profile file, user config, system config, then defaults. Project config is
  prevented from changing machine-owned provider, authentication, notification, profile, and
  telemetry keys. The CLI, IDE extension, and ChatGPT desktop app on the same Codex host share the
  config and MCP layers
  ([Config basics](https://developers.openai.com/codex/config-file/config-basic),
  [Config reference](https://developers.openai.com/codex/config-file/config-reference),
  [MCP](https://developers.openai.com/codex/extend/mcp)).
- `AGENTS.md` is an ordered instruction chain. Codex reads one global file and then one file per
  directory from the project root to the working directory. Later, more specific instructions are
  appended after broader instructions
  ([AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md)).
- Skills follow the open Agent Skills format and load from `.agents/skills` between the current
  directory and repository root, `$HOME/.agents/skills`, an admin directory, and built-ins. Skills
  use progressive disclosure and can be explicit or model-selected. Duplicate names do not merge;
  both may appear. The initial skill index has a context budget and can omit entries when the set is
  too large. A user-config entry can disable a skill by its exact file path. Optional skill metadata
  can declare MCP dependencies, but the documentation describes metadata and selection, not a
  required-capability startup gate
  ([Build skills](https://developers.openai.com/codex/build-skills)).
- Custom agents are personal TOML files under `~/.codex/agents` or project files under
  `.codex/agents`. They are full config layers for spawned sessions and can specialize model,
  effort, sandbox, instructions, and other settings
  ([Subagents](https://developers.openai.com/codex/agent-configuration/subagents)).
- Hooks load beside active config layers and from enabled Plugins. All matching hooks merge; config
  precedence does not replace lower-layer hooks. Command hooks require hash-based review when new
  or changed, and managed hooks can be made mandatory
  ([Hooks](https://developers.openai.com/codex/hooks)).

Codex gives a strong shared-host experience, but it does not document a single per-Run input that
names the complete resolved set of instructions, skills, Plugins, hooks, subagents, and MCP tools.
Its local skill discovery can intentionally omit items from the model's initial index under context
pressure. Cogwork therefore cannot treat "present in a discovered Codex directory" as proof that a
required capability was available to the agent.

### Claude Code

Claude Code has the most explicit configuration and provenance model. General settings have managed,
command-line, local, project, and user scopes. Managed policy wins; otherwise the closer scope wins
for scalar values, while array settings merge and deduplicate. `/status` reports active sources and
`/doctor` validates schema and resolution problems
([Settings](https://code.claude.com/docs/en/settings),
[Debug configuration](https://code.claude.com/docs/en/debug-your-config)).

Its private repository scope directly matches the proposed Cogwork Private Workspace Overlay:

- `.claude/settings.json` is shared project configuration.
- `.claude/settings.local.json` is gitignored configuration for one user in one project.
- Local MCP entries are stored under that project's path in `~/.claude.json`; project MCP entries
  live in checked-in `.mcp.json`; user entries apply everywhere.
- `CLAUDE.local.md` adds private project instructions after shared `CLAUDE.md`; managed, user,
  project, and nested instructions otherwise concatenate from broad to specific
  ([Memory and instructions](https://code.claude.com/docs/en/memory),
  [MCP](https://code.claude.com/docs/en/mcp)).

Resolution remains component-specific:

- Skills exist at enterprise, personal, project, and Plugin scopes. Enterprise overrides personal,
  personal overrides project, and Plugin skills use a namespace. Legacy custom commands now use the
  same runtime mechanism as skills; a skill wins if both share a name
  ([Skills](https://code.claude.com/docs/en/slash-commands)).
- MCP duplicate names resolve Local → Project → User → Plugin → hosted connector. A project MCP
  server requires approval. A missing required environment variable makes the configuration fail
  to parse
  ([MCP](https://code.claude.com/docs/en/mcp)).
- Subagents resolve Managed → session CLI input → Project → User → Plugin. Definitions can restrict
  tools, preload skills, and add subagent-only MCP servers. A missing or disabled preloaded skill is
  skipped with a debug warning, not treated as a blocking requirement
  ([Subagents](https://code.claude.com/docs/en/sub-agents)).
- Hooks can come from user, project, local, managed, Plugin, skill, or agent sources. All matching
  hooks run. `/hooks` reports each hook's source; managed policy can exclude non-managed hooks
  ([Hooks](https://code.claude.com/docs/en/hooks)).

Claude Code Plugins use the same user, project, local, and managed scopes. Project installation is
checked in; local installation is private to one repository. `plugin list` reports version,
marketplace, and enabled state; `plugin details` inventories contributed components and projected
token cost. Update detection resolves the Plugin version from its manifest, marketplace entry,
source commit SHA, or `unknown`, in that order. Marketplaces provide catalogs, dependency install,
automatic updates, and source policies
([Plugin reference](https://code.claude.com/docs/en/plugins-reference),
[Install Plugins](https://code.claude.com/docs/en/discover-plugins),
[Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)).

For headless projection, Claude Code is the closest of the three to an engine-controlled input. Its
CLI can choose setting sources, add an overriding settings document, restrict built-in tools, and
use `--strict-mcp-config` so only explicitly supplied MCP servers load. Those switches can isolate
much of a Run, but they still do not express one versioned inventory covering every component or a
general "this capability is required" contract
([CLI reference](https://code.claude.com/docs/en/cli-usage)).

## Recommendations for Cogwork

These recommendations are inferences from the observed models, not descriptions of the products.

### 1. One state model, two product surfaces

Use **Plugins** for discovery, installation, Connection setup, update state, and removal. Use
**Customize** to inspect and alter the typed capabilities each Plugin contributes. A change in
either surface must update the same underlying records. Cursor demonstrates that this is legible;
OpenAI demonstrates that it also works for a non-developer catalog.

### 2. Treat a Plugin as a versioned source, not an activation scope

A Plugin record should own stable identity, source, resolved version, install state, update state,
and its contributed capability identities. Each capability should retain its type and provenance.
Do not copy Plugin contents into a second mutable global skill home: materialize an immutable
version once and have resolution point at it.

### 3. Model ownership, target, source, and activation separately

The minimum local-first targets are:

- personal inputs that apply across Workspaces;
- checked-in Workspace inputs;
- a private Workspace Overlay owned by the current user and stored outside the repository;
- Runtime Host and administrator inputs for machine-owned constraints;
- per-Run overrides generated by the Engine, not edited as long-lived settings.

Every effective entry should retain where it came from: Plugin/version, managed Cogwork record,
checked-in file, private overlay, or Harness built-in. A future remote store can change record
ownership and synchronization without changing these targets.

### 4. Define resolution per capability type

Do not force all inputs through one precedence algorithm:

- Ordered instruction sources concatenate, with explicit order and provenance.
- Identity-keyed MCP servers, subagents, and commands select one winner and report shadowed entries.
- Hooks accumulate; deterministic order and blocking/failure behavior must be explicit.
- Skills remain independently addressable. Duplicate display names need stable qualified identities,
  not path-copy precedence.
- Plugin requirements and administrator policy constrain the result; they are not ordinary overrides.

Customize should show the effective value, its source, shadowed/conflicting entries, and why it is
active.

### 5. Make the Engine the enforcement point

Before dispatch, the Engine should resolve a frozen capability snapshot for the Run and validate:

- every required capability resolves to one compatible version;
- required Connections are authenticated and allowed;
- required local executables exist on the Runtime Host;
- the selected Harness can project or natively provide each required capability type;
- policy has not removed anything required.

Failure must stop before the agent starts. A prompt that says "use Granola" and a skill that declares
an MCP dependency are useful guidance but not enforcement.

### 6. Negotiate Harness features and project only what is supported

Each Harness runner should declare projection features such as explicit MCP injection, isolated
settings sources, explicit instruction layers, skill materialization, hook control, subagent control,
and runtime introspection.

- Cursor ACP can receive explicit MCP servers, but other components need a controlled filesystem or
  Plugin environment. Team MCP parity cannot be assumed in ACP.
- Codex needs a controlled config/component environment plus explicit instruction assembly; ambient
  user discovery must not be the correctness path.
- Claude Code can use strict MCP and selected settings sources, but Cogwork still needs its own
  preflight and record of what it asked the Harness to load.

If a required capability cannot be projected, the Engine should reject the Run as incompatible. It
must not silently fall back to ambient Harness discovery.

### 7. Record requested, projected, and observed state

The Run should retain three related views:

1. **Resolved:** what Cogwork decided the Run requires and allows.
2. **Projected:** what the Harness runner was instructed to load, including versions and generated
   paths/config.
3. **Observed:** what the Harness can report as connected or loaded after startup.

This distinction gives useful diagnostics without claiming that a Harness can prove model adherence.
It also makes drift visible: a required MCP server can be resolved but fail projection, or be
projected but fail authentication.

## Sources

### Cursor

- [Customize](https://cursor.com/docs/customize-cursor)
- [Plugins](https://cursor.com/docs/plugins)
- [Rules](https://cursor.com/docs/rules)
- [Skills](https://cursor.com/docs/skills)
- [Subagents](https://cursor.com/docs/subagents)
- [Hooks](https://cursor.com/docs/hooks)
- [MCP](https://cursor.com/docs/mcp)
- [Cursor ACP](https://cursor.com/docs/cli/acp)

### OpenAI Codex

- [Plugins](https://learn.chatgpt.com/docs/plugins)
- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [Build Plugins](https://developers.openai.com/codex/build-plugins)
- [Build skills](https://developers.openai.com/codex/build-skills)
- [Config basics](https://developers.openai.com/codex/config-file/config-basic)
- [Config reference](https://developers.openai.com/codex/config-file/config-reference)
- [AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md)
- [Subagents](https://developers.openai.com/codex/agent-configuration/subagents)
- [MCP](https://developers.openai.com/codex/extend/mcp)
- [Hooks](https://developers.openai.com/codex/hooks)

### Claude Code

- [Extension overview](https://code.claude.com/docs/en/features-overview)
- [Settings](https://code.claude.com/docs/en/settings)
- [Debug configuration](https://code.claude.com/docs/en/debug-your-config)
- [Memory and instructions](https://code.claude.com/docs/en/memory)
- [Skills](https://code.claude.com/docs/en/slash-commands)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [Plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Install Plugins](https://code.claude.com/docs/en/discover-plugins)
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [CLI reference](https://code.claude.com/docs/en/cli-usage)
