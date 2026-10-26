# Research: how agents author automations

Resolves [#778](https://github.com/colonylabs/cogwork/issues/778), part of the
[Customizable Workflows map (#656)](https://github.com/colonylabs/cogwork/issues/656).

**Question**: how do shipped tools let a coding agent author an automation on a person's behalf,
and what does each one read and write? For each tool: the document the agent produces and its
schema; what the agent reads first; how validation errors reach the agent; whether the person
approves before the automation turns on; and how a UI edits the same document.

All claims were read on 2026-10-26. Per the disposition's **What a tool writes to disk outranks what
it says**, disk artifacts on this machine come first, then vendored source, then official docs.
Load-bearing primary sources: `~/.cursor/skills-cursor/automate/SKILL.md` and the Cursor MCP
catalog under `~/.cursor/projects/<project>/mcps/`; the vendored Codex source at `.repos/codex`
(commit `4aa52f2`, 2026-08-24) and `~/.codex/config.toml`; `~/.claude/settings.json`,
`<repo>/.claude/settings.json`, and the Claude Code hooks and settings docs; the n8n source under
`packages/@n8n/ai-workflow-builder.ee`; Zapier's MCP docs; the `github/gh-aw` source and docs.
Each claim cites its source inline.

---

## 1. Summary table

| Tool | Document the agent produces | Agent reads first | Validation reaches the agent as | Person approves before live | UI edits the same document |
|---|---|---|---|---|---|
| Cursor Automations | `WorkflowData` proto JSON (`name`, `description`, `workflow.{triggers,actions,prompts,model,...}`) passed as `prefillWorkflowData` | The `/automate` skill (tables of trigger and action keys) and the MCP catalog on disk | It does not. The editor decodes with `ignoreUnknownFields` and renders a blocked card; the skill forbids the agent from inventing a validator | Yes, twice: tool approval on `open_automation`, then Save in the editor | The Automations editor; the same document is a Terraform resource |
| n8n AI Workflow Builder | Workflow JSON: `{ name, nodes, connections }`, applied as a list of typed operations | Node-type catalog via `search_nodes` / `node_details`; community templates as examples; a documentation tool | Two tools the agent calls, `validate_structure` and `validate_configuration`, return violation lists as text and state | Yes. The builder edits the canvas; the person reviews credentials, tests, saves and activates | The n8n canvas; the builder and the person edit one `workflowJSON` |
| Zapier (Copilot, MCP) | Zap steps in the editor's draft; for Next Gen Zaps, a TypeScript source file plus trigger config in a **draft** | The `zapier:build-workflows` skill; `discover_zapier_actions`, `search_triggers`, `get_trigger_fields`, `get_trigger_field_choices` | `run_workflow_draft` returns test errors; the agent fixes and reruns | Conversational only. The agent itself calls `publish_workflow_draft` and `enable_workflow`; Copilot has an "Ask as you build" mode | Workflow Manager (visual and code views); Zap editor |
| GitHub Agentic Workflows (Copilot) | `.github/workflows/<name>.md` (YAML frontmatter + Markdown body) compiled to `<name>.lock.yml` | The `agentic-workflows` skill installed by `gh aw init`; a bundled JSON Schema | `gh aw compile` fails on schema, expression-safety and lint errors in the agent's terminal | Yes. Both files go through a commit and pull request; the activation job rejects a stale lock file | Any editor on the Markdown; a WASM compiler playground; community graphical editors |
| Claude Code | `hooks` in `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`; plugin `hooks/hooks.json` | The settings `$schema` on schemastore; the docs | A startup dialog for the **person** (Settings Error / Warning); `claude doctor` lists rejected entries. Nothing structured reaches the agent | No for user and local files: a file watcher reloads hooks on save. Project files wait for folder trust | `/config` for a few keys; `/hooks` is read-only |
| Codex | `[[hooks.<Event>]]` tables in `config.toml` or `.codex/hooks.json`; `hooks.state.<key>.{enabled,trusted_hash}` | `hooks/list`, `config/read` (with layers and origins), the generated JSON Schema | `config/value/write` and `config/batchWrite` return typed `ConfigWriteErrorCode`s with messages; `hooks/list` returns `warnings` and `errors` | Yes. A new or changed hook is `untrusted` or `modified` and does not run until the person trusts its hash; `.codex/` is read-only to the agent in the sandbox | TUI hooks browser and startup review write `trusted_hash` through the same `config/batchWrite` |

---

## 2. Cursor Automations

### The document

The agent builds a `WorkflowData` object and hands it to the `cursor-app-control.open_automation`
tool as `prefillWorkflowData`. The tool's input schema types that field as an open object
(`"type": "object"`, `"additionalProperties": {}`), so the tool contract does not constrain the
payload (`~/.cursor/projects/Users-taylorsteele-sites-cogwork/mcps/cursor-app-control/tools/open_automation.json`).
The skill defines the shape: "canonical proto JSON with full enum names (e.g.
`GIT_PULL_REQUEST_ACTION_OPENED`)", with a skeleton of `name`, `description`, and
`workflow.{triggers, actions, prompts, model, agentOptions, memoryEnabled}`; triggers are a
oneof over twelve keys (`cron`, `git`, `slackTrigger`, `slackReactionAdded`, `slackChannelCreated`,
`emailReceived`, `microsoftTeamsTrigger`, `microsoftTeamsChannelCreated`, `linear`, `webhook`,
`pagerduty`, `sentry`); actions are `prComment`, `slack`, `readSlack`, `requestReviewers`,
`manageCheckRun`, `mcp` (`~/.cursor/skills-cursor/automate/SKILL.md`, "YAML output shape" and
"Tools"). The same document is public as the Terraform resource `cursor_platform_workflow`, whose
schema lists `trigger` and `action` blocks with the same keys in snake case, plus `enabled`,
`scope`, `model_selection`, and read-only `id`, `created_at`, `updated_at`
([Terraform registry](https://registry.terraform.io/providers/cursor/cursor/latest/docs/resources/platform_workflow);
[Cursor docs, Service accounts](https://cursor.com/docs/automations)).

Nothing about an automation is written to disk on this machine. `~/.cursor/` holds the skill, a
`hooks.json` (`version: 1`, hooks keyed by event with `command`, `failClosed`, `timeout`), and the
MCP catalog. The automation itself lives in Cursor's cloud and the tool description says the
prefill "is not put in a URL or browser storage" (`open_automation.json`).

### What the agent reads first

The skill, in full: it carries the trigger and action key tables, the PCD completeness matrix,
the MCP existence and auth gates, and the YAML skeleton. For MCP actions the skill tells the agent
to read `SERVER_METADATA.json` and write its `serverName`, never its `serverIdentifier`
(`SKILL.md`, "MCP existence gate"). On this machine the catalog is at
`~/.cursor/projects/<project>/mcps/<serverIdentifier>/` with `SERVER_METADATA.json`, optional
`STATUS.md`, `INSTRUCTIONS.md`, and one JSON Schema per tool under `tools/` — not at
`~/.cursor/mcps/` as the skill states. The disk wins; the skill's path is stale. The skill also
tells the agent to discover picker-backed values (repos through `gh`, Slack channels through the
Slack MCP) before it asks the person (`SKILL.md`, "Discover before ask").

### How validation errors reach the agent

They do not. The editor "decodes triggers with `ignoreUnknownFields: true`, silently drops unknown
keys, and renders the result as an unconfigurable 'Configure trigger' card that blocks save"
(`SKILL.md`, "Trigger oneof keys are exhaustive"). The agent runs an internal checklist against the
skill's tables and is told: "**Do not invent inline JSON-schema validators** or shell snippets for
automation YAML — they drift from proto shape and can falsely fail valid drafts" (`SKILL.md`,
"Validation check"). So the only validator is the editor, and it reports to the person, not the
agent.

### Person approves before live

Yes, in three layers. The skill requires a plain-language draft table, an approval, then a
readiness question before it opens the editor (`SKILL.md`, "Glass finish path"). The tool call
itself "require[s] tool approval before the data is trusted by the form" (`open_automation.json`).
Then the person saves in the editor; the docs list "Save and activate the automation" as the last
step ([Cursor docs](https://cursor.com/docs/automations), "Getting started"). The skill is
creation-only: it "does not list, get, inspect, update, or search existing Cursor Automations from
chat" (`SKILL.md`, "House rules").

### UI edits the same document

The Automations editor at cursor.com and in the Agents Window, and the Terraform provider, both
operate on the same record ([Cursor docs](https://cursor.com/docs/automations); Terraform
registry). The agent can reopen an existing one by `automationId` with `view: edit | view | runs`
(`open_automation.json`).

---

## 3. n8n AI Workflow Builder

### The document

n8n's workflow JSON. The builder's state holds `workflowJSON: SimpleWorkflow` where
`SimpleWorkflow = Pick<IWorkflowBase, 'name' | 'nodes' | 'connections'>`
(`packages/@n8n/ai-workflow-builder.ee/src/types/workflow.ts`). The agent does not write that
object directly; its tools emit typed operations — `addNodes`, `updateNode`, `removeNode`,
`setConnections`, `mergeConnections`, `removeConnection`, `renameNode`, `setName`, `clear` —
collected in `workflowOperations` and applied by a separate node in the graph
(`src/workflow-state.ts`, `operationsReducer`; `src/types/workflow.ts`, `WorkflowOperation`).
Each node is addressed by `nodeType` plus an exact `nodeVersion`
(`src/tools/add-node.tool.ts`, `baseSchema`).

### What the agent reads first

A catalog and examples. `search_nodes` searches `parsedNodeTypes` by name or by connection type
(`src/tools/node-search.tool.ts`); `node_details` returns a node type's parameters;
`get_node_configuration_examples` and `get_node_connection_examples` pull real configurations and
Mermaid diagrams from community templates (`src/tools/get-node-examples.tool.ts`);
`get_documentation` is listed first in the tool registry (`src/tools/builder-tools.ts`). The docs
say node definitions, parameters, connections and the current workflow are sent to the model;
credential details are not ([n8n docs](https://docs.n8n.io/advanced-ai/ai-workflow-builder/),
"AI model and data handling").

### How validation errors reach the agent

Two tools the agent calls after it edits. `validate_structure` runs `validateConnections` and
`validateTrigger` and returns "Found N structure issues:" with one line per violation, and stores
the violations in state (`src/tools/validate-structure.tool.ts`). `validate_configuration` runs
`validateAgentPrompt`, `validateTools`, `validateFromAi`, `validateParameters`
(`src/tools/validate-configuration.tool.ts`). Both tool descriptions say "Call after
creating nodes/connections to check for issues." Tool input errors come back as a `ValidationError`
with the Zod issues attached (both files). The checks live in `src/validation/checks` and run
against the effective workflow including pending operations (`getEffectiveWorkflow()`).

### Person approves before live

Yes. The builder edits the open canvas. The docs' third step is "Review and refine the generated
workflow: Review required credentials and other parameters"; "Execute and refine" is a button the
person clicks ([n8n docs](https://docs.n8n.io/advanced-ai/ai-workflow-builder/)). Activation is
the normal n8n save and toggle; the builder has no publish tool.

### UI edits the same document

The canvas. The builder's operations and the person's edits land on one `workflowJSON`
(`src/workflow-state.ts`). `getBuilderToolsForDisplay` exists so the UI can render past tool calls
when a session reloads (`src/tools/builder-tools.ts`).

---

## 4. Zapier: Copilot, MCP, and Next Gen Zaps

Zapier has three surfaces. Zapier Copilot authors classic Zaps inside the Zap editor. Zapier MCP
exposes actions to any MCP client, and with early access, **workflow tools** that build Next Gen
Zaps. Zapier Agents is being folded into AI by Zapier
([Zapier help, Start an agent from a Zap](https://help.zapier.com/hc/en-us/articles/35859160812685-Start-an-agent-from-a-Zap)).

### The document

Copilot: the Zap itself — trigger and action steps with connected accounts and field mappings,
built in the editor's draft ([Zapier help, Use the power of AI to generate Zap workflows](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows)).

Next Gen Zaps: **TypeScript code**. "Your agent writes the workflow's TypeScript code, saves it to a
draft"; `update_workflow_draft` "saves source, connections, trigger configuration, dependencies,
and the runtime version to an open draft"; the code has a 200,000-character limit
([Create your first Next Gen Zap](https://docs.zapier.com/mcp/get-started/build-a-workflow.md);
[How tools work](https://docs.zapier.com/mcp/overview/how-tools-work), "Workflow tools"). A
published draft becomes "a new immutable workflow version" (same page, `publish_workflow_draft`).

### What the agent reads first

A skill, then a catalog. "Before building or modifying a workflow, your agent reads the
`zapier:build-workflows` skill with `get_zapier_skill`. Several workflow tools link to this skill
directly in their descriptions" ([How tools work](https://docs.zapier.com/mcp/overview/how-tools-work)).
Trigger discovery is four tools: `search_triggers`, `get_trigger_fields`,
`get_trigger_field_choices`, `get_trigger_run`; actions come from `discover_zapier_actions` and
`inspect_zapier_actions`, which returns each enabled action "with what you need to run them"
(same page). The agent answers with a build plan — apps, connections, trigger, steps — for the
person to review before it writes code
([Create your first Next Gen Zap](https://docs.zapier.com/mcp/get-started/build-a-workflow.md), step 1).

### How validation errors reach the agent

By test run. `run_workflow_draft` "test-runs a draft's current source without publishing it";
"Your agent reports the test result, including any errors. If the test fails, it fixes the code
and retests" (same two pages). There is no separate static validator in the tool list.

### Person approves before live

Not by mechanism. The agent calls `publish_workflow_draft` and confirms the trigger "claimed
successfully and is `active`"; the person's approval is of the plan in chat
([Create your first Next Gen Zap](https://docs.zapier.com/mcp/get-started/build-a-workflow.md),
steps 1 and 3). Copilot offers "Ask as you build", where it "will not perform any actions without
your confirmation", versus "Auto-build"; in both, the person clicks Publish to turn the Zap on
([Use the power of AI...](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows)).
On the execution side, AI by Zapier has a per-tool "Require approval before running" toggle, off by
default ([Add tools to your AI by Zapier step](https://help.zapier.com/hc/en-us/articles/45863491098893-Add-tools-to-your-AI-by-Zapier-step)),
and managed-mode MCP servers let the owner pin field values so "Zapier sends that value on every
call and ignores any value your MCP client sends"
([Configure your actions](https://docs.zapier.com/mcp/manage/configure-your-actions)).

### UI edits the same document

The Workflow Manager, with "visual and code views", edits the published Next Gen Zap; the agent
edits it with the same workflow tools
([Create your first Next Gen Zap](https://docs.zapier.com/mcp/get-started/build-a-workflow.md),
"Managing your Next Gen Zap"). Copilot and the person share the Zap editor.

---

## 5. GitHub Copilot and GitHub Actions

GitHub's current official path for "a coding agent authors an Actions workflow" is GitHub Agentic
Workflows (`gh aw`, public preview). GitHub recommends it over calling Copilot CLI in a plain
`run:` step ([Automating tasks with Copilot CLI and GitHub Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions)).

### The document

A Markdown file in `.github/workflows/` with YAML frontmatter (`on`, `permissions`,
`safe-outputs`, `engine`, `tools`, `network`) and a natural-language body, compiled to a
`.lock.yml` GitHub Actions workflow; both files are committed
([Creating GitHub Agentic Workflows](https://docs.github.com/en/copilot/how-tos/github-agentic-workflows/creating-github-agentic-workflows)).
The frontmatter is validated against a bundled JSON Schema
(`pkg/parser/schemas/main_workflow_schema.json` in `github/gh-aw`;
[Compilation Process](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/compilation-process.md), Phase 1).
The body is loaded at run time, so prose edits need no recompile; frontmatter edits do
([Working with workflows](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/setup/working-with-workflows.mdx)).
`safe-outputs` "separate action requests from execution: the agent requests actions through
structured output, and separate permission-controlled jobs execute permitted requests", each with
a `max`
([Safe Outputs](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/safe-outputs.md)).

### What the agent reads first

`gh aw init` "adds skills, instructions, and a custom agent related to agentic workflow authoring";
the person prompts `/agentic-workflows Create a new workflow that ...`
([Creating GitHub Agentic Workflows](https://docs.github.com/en/copilot/how-tos/github-agentic-workflows/creating-github-agentic-workflows)).
That skill is a router that loads `.github/aw/create-agentic-workflow.md` and sibling guides
(`.github/skills/agentic-workflows/SKILL.md` in `github/gh-aw`).

### How validation errors reach the agent

Through the compiler. "The agent will create the workflow, and compile the workflow using the
GitHub CLI" (GitHub docs, above). `gh aw compile` validates the frontmatter against the schema,
validates expression safety, warns when the prompt names a tool the configuration denies, and runs
lint rules where "Error findings fail compilation; warnings remain advisory"
([Compilation Process](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/compilation-process.md)).

### Person approves before live

Yes. "Review the workflow, then ask the agent to commit and push the files"; updates go through "a
pull request and verify GitHub Actions checks" (GitHub docs, above). The compiled `activation` job
"validates lock file freshness", so a Markdown edit that skipped compilation does not run
([Compilation Process](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/compilation-process.md), "Job Types").

### UI edits the same document

Any text editor edits the Markdown. GitHub lists an experimental WASM compiler playground and
community graphical editors
([Workflow Editors](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/editors.mdx)).

---

## 6. Claude Code

### The document

JSON settings files. Hooks live under `hooks` in `~/.claude/settings.json`,
`.claude/settings.json`, `.claude/settings.local.json`, managed policy, plugin `hooks/hooks.json`,
and skill or subagent frontmatter
([Claude Code hooks docs](https://code.claude.com/docs/en/hooks), "Hook locations"). The shape is
event → matcher group → handler list. On this machine: `~/.claude/settings.json` has `PreToolUse`
and `PostToolUse` groups with `matcher: "*"` and a `command` handler; the repo's
`.claude/settings.json` has `SessionStart` and `CwdChanged` groups and declares
`"$schema": "https://json.schemastore.org/claude-code-settings.json"`; the installed
`security-guidance` plugin's `hooks/hooks.json` uses `if`, `asyncRewake`, `rewakeMessage` fields
and `${CLAUDE_PLUGIN_ROOT}` paths. Plugin manifests carry `name`, `version`, `description`
(`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/security-guidance/.claude-plugin/plugin.json`).

### What the agent reads first

Nothing is prescribed. The agent edits the file with its file tools. The `$schema` line "points to
the published JSON schema for Claude Code settings, which gives you autocomplete and inline
validation in VS Code, Cursor, and any other editor"; the schema "can lag behind the newest CLI
releases" ([settings docs](https://code.claude.com/docs/en/settings)).

### How validation errors reach the agent

They reach the person. "Settings Error: a user, project, or local file has invalid JSON or a value
the schema rejects. At the start of an interactive session Claude Code shows a dialog that lets you
fix the file with Claude's help, exit, or continue"; "Settings Warning: only individual entries
fail, such as ... an unknown hook event name. Claude Code skips those values"; `claude doctor`
lists rejected entries ([settings docs](https://code.claude.com/docs/en/settings), "Fix a broken
settings file"). A `ConfigChange` hook event fires when a settings file changes, so an operator can
audit or block edits ([hooks docs](https://code.claude.com/docs/en/hooks), "ConfigChange").

### Person approves before live

Mostly no. "Claude Code watches your settings files and reloads them when they change, so it
applies most edits to the running session without a restart, including edits to `permissions`,
`hooks`" ([settings docs](https://code.claude.com/docs/en/settings), "When edits take effect");
"Direct edits to hooks in settings files are normally picked up automatically by the file watcher"
([hooks docs](https://code.claude.com/docs/en/hooks)). The gate that exists is folder trust for
committed project files: "Some of what you commit waits until each teammate trusts the folder"
([settings docs](https://code.claude.com/docs/en/settings)). "There is no way to disable an
individual hook while keeping it in the configuration" ([hooks docs](https://code.claude.com/docs/en/hooks),
"Disable or remove hooks"). Administrators can lock hooks with `allowManagedHooksOnly`.

### UI edits the same document

`/config` writes a short list of personal options to the same files; `/hooks` "open[s] a read-only
browser for your configured hooks" labelled by source
([settings docs](https://code.claude.com/docs/en/settings), "Use the /config menu";
[hooks docs](https://code.claude.com/docs/en/hooks), "The /hooks menu").

---

## 7. Codex

### The document

TOML tables in `config.toml` or a JSON `hooks.json`. `HooksFile { description?, hooks: HookEventsToml }`
and `HooksToml { <events>, state: BTreeMap<String, HookStateToml> }` with
`HookStateToml { enabled?, trusted_hash? }`; the struct derives `JsonSchema` and
`deny_unknown_fields` (`codex-rs/config/src/hook_config.rs`). On this machine
`~/.codex/config.toml` holds `[[hooks.PreToolUse]]`, `[[hooks.PostToolUse]]`, `[[hooks.Stop]]`
tables and a `[hooks.state]` table whose keys are
`"<source path>:<event>:<group>:<handler>"`, for example
`"/Users/.../sites/cogwork/.codex/hooks.json:pre_tool_use:0:0"`, each with `trusted_hash =
"sha256:..."` and, for user hooks, `enabled = true`. The repo's `.codex/hooks.json` uses the same
event → matcher → `hooks[]` shape as Claude Code, with `type`, `command`, `timeout`,
`statusMessage`. Hooks from TOML and from `hooks.json` "converge on the same trust identity" because
the hash is of a normalized identity, not source text
(`codex-rs/hooks/src/engine/discovery.rs`, `hook_hash`).

Config layers have numeric precedence: packaged defaults −10, MDM 0, system 10, enterprise 15,
user 20 (profile 21), project 25, session flags 30, legacy managed 40/50
(`codex-rs/config/src/config_layer_source.rs`). Project `.codex/` config, hooks and exec policies
load only when the project is trusted; otherwise the loader records "To load project-local config,
hooks, and exec policies, add <key> as a trusted project in <user config file>"
(`codex-rs/config/src/loader/mod.rs`, `disabled_reason_for_decision`).

### What the agent reads first

The app server exposes `config/read` (effective config, per-key `origins`, optional `layers`),
`hooks/list` (every discovered hook with `key`, `sourcePath`, `source`, `enabled`, `currentHash`,
`trustStatus`, plus `warnings` and `errors`), and `codex app-server generate-json-schema` for the
whole protocol (`codex-rs/app-server/README.md`, "Message Schema", `config/read`, `hooks/list`).

### How validation errors reach the agent

As typed error codes. Writes go through `config/value/write` or `config/batchWrite` and fail with
`ConfigWriteErrorCode::{ConfigLayerReadonly, ConfigRequirementReadonly, ConfigVersionConflict,
ConfigValidationError, ConfigPathNotFound, ConfigSchemaUnknownKey, UserLayerNotFound}` and a
message (`codex-rs/app-server-protocol/src/protocol/v2/config.rs`). The write path parses the key
path, refuses managed keys, merges, then runs `validate_config` on the user layer and again on the
effective merged config before it writes (`codex-rs/app-server/src/config_manager_service.rs`,
`apply_edits`). `expected_version` gives optimistic concurrency: "Configuration was modified since
last read. Fetch latest version and retry." (same file). Hook load failures are collected as
`warnings` in `hooks/list` rather than thrown (`discovery.rs`, `record_load_failure`).

### Person approves before live

Yes, by two mechanisms. First, the sandbox keeps `.codex`, `.agents` and `.git` under a writable
root read-only "to ensure that folders containing files that could be modified to escalate the
privileges of the agent ... are not modified by the agent"; `.codex` is protected "even before the
directory exists so first-time creation still goes through the protected-path approval flow"
(`codex-rs/protocol/src/protocol.rs`, `WritableRoot`; `codex-rs/protocol/src/permissions.rs`,
`default_read_only_subpaths_for_writable_root`). Second, trust: an unmanaged hook is `Untrusted`
when no hash is stored, `Modified` when the stored hash differs, `Trusted` when it matches, and
only `Managed | Trusted` handlers are dispatched (`discovery.rs`, `hook_trust_status` and the
`handlers.push` guard). "Only trusted unmanaged hooks become runnable"
(`codex-rs/app-server/README.md`). `--dangerously-bypass-hook-trust` is the escape hatch
(`codex-rs/cli/src/main.rs`).

### UI edits the same document

The TUI's startup review offers "Review hooks", "Trust all and continue", "Continue without
trusting" when any hook `needs_review` (`codex-rs/tui/src/startup_hooks_review.rs`,
`codex-rs/tui/src/hooks_rpc.rs`). Trusting writes `hooks.state.<key>.trusted_hash = <currentHash>`
through the same `config/batchWrite` with `mergeStrategy: upsert` and `reloadUserConfig: true`
(`hooks_rpc.rs`, `write_hook_trusts`); disabling upserts `enabled: false`
(`codex-rs/app-server/README.md`). "Hooks are returned even when disabled so clients can render and
re-enable them" (same). Writes are allowed only to the user `config.toml` ("Only writes to the user
config are allowed", `config_manager_service.rs`); the agent's own hook declaration in a project
`hooks.json` and the person's trust decision therefore live in two files.

---

## 8. Convergences and borrows

Per **Record the strength of a borrow**: a standard has a spec to link; a convergence is the same
shape from independent implementations with no spec between them; a borrow is one vendor's choice.

### Standards

- **JSON Schema** for the document or its tool contract: Codex derives `JsonSchema` for
  `HooksFile` and the whole app-server protocol; Claude Code publishes its settings schema on
  schemastore; gh-aw bundles `main_workflow_schema.json`; Cursor's tool inputs are JSON Schema
  draft 2020-12. Cursor's `WorkflowData` payload itself has no published schema beyond the
  Terraform provider's.
- **MCP** as the surface the agent calls: Cursor (`cursor-app-control`), Zapier (meta-tools and
  workflow tools), and Codex (`mcp_tool` hook handlers).

### Convergences

1. **The agent writes a draft; a separate deterministic step turns it on.** Cursor: prefill →
   tool approval → editor Save. n8n: operations → canvas → person saves and activates. Zapier Next
   Gen: `create_workflow` ("durable workflow container") → draft → `publish_workflow_draft` →
   `enable_workflow`. gh-aw: Markdown → `compile` → commit → PR. Codex: declaration → `untrusted`
   → person writes `trusted_hash`. Five of six. Claude Code is the exception: the file watcher
   makes an edit live on save, and the doc's own answer to "a hook you did not expect" is a
   `ConfigChange` hook or `allowManagedHooksOnly`.
2. **Approval binds to a content identity, not to a moment.** Codex hashes the normalized hook
   (`trusted_hash`, `Modified` on drift). gh-aw commits a lock file and rejects a stale one at
   activation. Zapier publishes immutable versions. Codex also carries `expected_version` and
   `ConfigVersionConflict` for concurrent editors. Three independent implementations. This is the
   disposition's **Approval names what it approves** observed in the wild.
3. **The agent reads a typed catalog plus a prose skill, never the schema alone.** Cursor: skill
   tables + `SERVER_METADATA.json`. n8n: `search_nodes` / `node_details` + template examples +
   `get_documentation`. Zapier: `zapier:build-workflows` skill + `search_triggers` /
   `get_trigger_fields` / `get_trigger_field_choices`. gh-aw: `agentic-workflows` skill + schema.
   Codex: `hooks/list` + `config/read`. Every tool that has a chat agent ships a skill; every tool
   with a large catalog ships a search tool over it. Picker-backed values (channels, repos,
   enum field values) are discovered, not typed by the person (Cursor "Discover before ask";
   Zapier `get_trigger_field_choices`; n8n `get_resource_locator_options`).
4. **Validation is a deterministic function with a structured result the agent can read.** n8n
   returns violation lists from two tools. Codex returns typed error codes and collects load
   failures as `warnings`. gh-aw fails `compile` with lint findings by severity. Zapier returns
   test-run errors. Four of six. The two gaps are instructive: Cursor's editor silently drops
   unknown keys and the skill forbids a local validator; Claude Code shows the error to the person
   in a dialog and only `claude doctor` lists what was rejected.
5. **Credentials never enter the document.** n8n does not send credential details to the model;
   Cursor's `mcp` action names a server, auth happens in chat before prefill; Zapier actions run
   through the owner's connections by id; Codex and Claude hooks reference commands and env-var
   names. This matches the convergence already recorded under **A bundle names a secret; the
   engine holds it**.
6. **The write surface is a document, and the UI and the agent share it.** Every tool has one
   record the UI edits: Cursor's editor and Terraform resource, n8n's canvas, Zapier's Workflow
   Manager, gh-aw's Markdown, Claude's settings files, Codex's `config.toml`. No tool keeps a
   separate "agent-authored" store.

### Borrows (one vendor's choice; taste, and taste runs both ways)

- **Zapier: the workflow document is TypeScript source.** Code, not data. It buys a test run as the
  only validator and a 200,000-character limit. It is evidence *against* the shape for Cogwork,
  which has already chosen **Data over code** (ADR 0006).
- **gh-aw: Markdown body loaded at run time, frontmatter compiled.** Prose changes without a
  recompile; structure changes need one. One vendor, and tied to GitHub Actions' file-based model.
- **Cursor: plain-language-only chat, no YAML shown, draft table then handoff to the editor.** A UX
  stance, and the creation-only rule is a product limit, not a design.
- **Codex: a startup "Review hooks / Trust all / Continue without trusting" dialog**, and the split
  of declaration (any layer) from trust state (user layer only). Both are specific to a file-based
  config model with untrusted project files.
- **Claude Code: file-watcher reload with no per-hook disable.** One vendor, and the docs route
  around it with `disableAllHooks` and `ConfigChange`.
- **n8n: two validators, structure then configuration**, and an operations log reduced onto one
  JSON. The split is useful vocabulary; it is one vendor's.

---

## 9. Implications for Cogwork

For the **Workflow document** (one schema-validated definition the UI, shipped defaults and a
future chat agent all produce through the same command RPC) and the **agent-authoring seam** (what
an agent reads, writes, and gets back). Sources named per the disposition; items marked
*(unsourced)* are reasoning, not prior art.

1. **The seam is a command RPC that takes the whole document, not a file the agent edits.**
   Convergence 6 says UI and agent share one record; Codex and Claude show what file-based sharing
   costs: a watcher, a trust hash per hook, a read-only `.codex/`, and two files for one hook.
   Cogwork already owns the Control store and a client RPC, so the document goes through
   `workflow.save` (name provisional) and the store is the authority (**Name the authority; derive
   the rest**; ADR 0006). The current `Workflow` type in
   `apps/desktop/src/renderer/src/features/workflow-model.ts` is the right starting shape; it moves
   to `@cogwork/contracts` as a `Schema` so the daemon validates it, not the renderer.
2. **Save returns validation as data the agent can act on.** Codex's `ConfigWriteErrorCode` plus
   message, n8n's violation lists, and gh-aw's severity-ranked findings all give the agent a
   structured result in the same turn. Return `{ path, message, severity }` entries in the response
   (**Report a normal failure as data**; **Build the environment, not the prompt**). Follow n8n's
   two classes: *structure* (every Question combination is routed — `uncovered()` already computes
   this; every `CatalogChoice` resolves; hand-offs name an Operation that exists) and *readiness*
   (a Trigger or Action behind a Connection that is not ready). Cursor's silent drop of unknown
   keys is the anti-pattern to design against: the schema rejects unknown keys and says which.
3. **A saved Workflow is a draft until a person enables it, and approval binds to content.**
   Convergence 1 and 2. `Workflow.enabled` already exists; the agent's RPC saves with
   `enabled: false`, and only the UI flips it. Store the hash or version of the enabled document;
   a later agent save returns the Workflow to draft the way Codex marks a hook `Modified`
   (**Approval names what it approves**). Add `expectedVersion` to the save command so a UI edit
   and an agent edit cannot overwrite each other (Codex `ConfigVersionConflict`). *(unsourced:
   whether a defaults-shipped Workflow starts enabled is a product call; nothing above decides it.)*
4. **The agent reads a catalog RPC and a skill before it writes.** Convergence 3. The catalog is
   `workflow-catalog.ts` moved behind the daemon as `workflow.catalog` (name provisional): Trigger
   and Action groups, their options, `agentInputs`, the `connectorOnly` items with their
   Connection's readiness, and the Workspace's Operations for hand-off. The skill carries the
   examples and the authoring rules, as Cursor's `/automate` and Zapier's `build-workflows` do.
   Option values that the person would otherwise type (label names, Slack channels, statuses)
   should be discoverable through the same catalog rather than free text (Cursor "Discover before
   ask"; Zapier `get_trigger_field_choices`).
5. **The document should carry references, not display copies.** n8n addresses a node by
   `nodeType` + `nodeVersion`; Cursor's Terraform resource names an MCP server by `server_id`;
   Codex names a hook by a key. Today `CatalogChoice` denormalizes `groupName`, `icon` and
   `agentInputs` into the Workflow. An agent-authored document that carries display fields the
   engine owns will drift from the catalog. Keep `{ groupId, itemId, optionName }` in the document
   and derive the rest at read time *(unsourced inference from the three cited shapes)*.
6. **Credentials stay out.** Convergence 5 and the existing **A bundle names a secret; the engine
   holds it**. A Workflow names a Connection; the engine binds it at dispatch. Nothing new to build.
7. **Do not borrow:** TypeScript as the document (Zapier; against ADR 0006), live-on-save (Claude
   Code; against convergence 1), silent key dropping (Cursor; against item 2), and a startup trust
   dialog (Codex; it exists because declaration and trust live in different files, which item 1
   removes).
8. **Agent-managed repair is a later Workflow, not engine behaviour.** Zapier's "agentically
   managed by default: an agent watches its runs and can apply some fixes without your approval"
   ([Create your first Next Gen Zap](https://docs.zapier.com/mcp/get-started/build-a-workflow.md))
   is one vendor's choice and conflicts with **The engine constrains the model**. Noted, not
   proposed; it matches the Feldspar research's "agent proposes, human approves a structure change"
   deferral (`docs/research/feldspar-workflow-ideas.md`, §4).
