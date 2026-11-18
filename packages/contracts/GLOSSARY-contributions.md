# Contracts glossary: Contributions

Part of the [contracts glossary](./GLOSSARY.md).

**Contribution kind**:
One of the five types a Plugin may bundle and Customize may show: **MCP server, Skill, Subagent, Rules, Hook**. Command is not a kind, and Cogwork does not read `commands/` files (ADR 0037). The test is that a contribution kind is authored by a human as a file and renders as a row in Customize. Everything else an agent receives is engine-owned and appears only as a Run Plan member — Tools, Connections, Middleware, Operating Instructions, Work Context, Sandbox Policy, Harness are all deliberately *not* contribution kinds.
Only the kinds that **execute or connect** carry a setting. **MCP server** has one — on or off, written as a default and nowhere else. **Skill, Rules and Subagent** have none at all: they exist or they do not, and the Authoring tree a file sits in says everything an on / off could say (ADR 0018). **Hook** is deferred — it stays a named kind with its setting question open, because no cross-harness projection has been designed. Everything else about a contribution lives in its file. Turning it on for one Workflow or one Operation is not expressed here; that is **binding**, an Operation setting.
_Avoid_: Capability, Run Plan member (the two lists differ — Rules is a kind but resolves into Instructions; Tools is a member but is never contributed), per-Operation enablement (say binding)

**Connection**:
The established, authenticated binding to one external system, keyed by **system and account** (`linear/acme`, `github/octocat`, `slack/TKHST7M4Z`) — engine-owned, and not a contribution kind. It is never the credential itself: its record lives in the Control store (id, system, account, status) and its secret or source marker in the Credential store, reaching a Run over a channel that is never persisted to the run ledger or event log. Both a Plugin's contributions and the Engine's own ports — the issue tracker, the source control provider — authenticate through one and reference it **by id**. A Plugin may *require* a Connection; it may never define one.
Every **output action** acts through the person's Connection for its app, so a Workflow acts as the person.
**A Connection has no Scope**, and reference is not scoping: it is machine-level, a workspace references one, and a repository can never connect or override one. One grant serves every port on one account. At connect time, the system itself has to accept the credential before anything is written. GitHub and Slack report the account from the accepted credential; a person never types it. Linear keeps its typed account. At run time, the Credential store acquires the current credential from the selected source. A refused connect or re-connect leaves the credential it would have replaced untouched. Removal cascades to each Plugin that requires it and leaves a bound workspace *dangling*; a grant revoked outside Cogwork is a readiness state, not a removal. See ADR 0017.
_Avoid_: Plugin (a Plugin requires a Connection, never contains one), credential (that is the secret it holds), MCP server, contribution kind, provider key (that one buys inference, not access to the work), Integration, connector

**Connection readiness**:
The Engine-owned conclusion that a Connection is established, unrevoked, and usable. It is an **input** to MCP server readiness for a contributed server that requires one, and it stands alone for an Engine port, where it gates that port's Trigger source. Deliberately **not** generalized: there is no `Readiness` umbrella, because the two are not peers — one feeds the other.
_Avoid_: Readiness (unqualified), MCP server readiness, established (one of its inputs)

**Tool**:
A typed function an agent may call during a Run. A Tool may be engine-owned, provider-native, or exposed by an MCP server, but its source remains explicit.
_Avoid_: MCP server (one server may expose many Tools)

**Skill**:
A discoverable package of instructions and supporting resources an agent may use during a Run. It remains distinct from mandatory Operating Instructions.
_Avoid_: Operating-instructions package, MCP server, Plugin, Command (retired — ADR 0037)

**MCP server**:
One configured Model Context Protocol server instance made available to a Run so its Tools, resources, and prompts can be used, identified by a Cogwork-owned `McpServerId`. It retains the verified MCP Registry name/version as provenance when available; runtime `serverInfo` is observed metadata, never the configured identity.
_Avoid_: MCP skill, Tool, Connection, Plugin

**MCP server readiness**:
The Engine-owned conclusion that a configured MCP server is enabled, launchable or reachable, authenticated, protocol-compatible, exposes the expected MCP features, and can be projected by the selected Harness. Its *authenticated* input is **Connection readiness** when the server requires a Connection. Required servers must be ready before a Run Plan is accepted; clients use the same result and reason to show Operation availability.
_Avoid_: Installed, runtime `serverInfo`, UI-only validation

**Rules**:
Reusable advisory guidance contributed at any scope, authored as markdown with frontmatter carrying glob-based path scoping and an always-apply flag. A contribution kind that is *not* a Run Plan member — Rules resolve into Instructions.
Rules are advisory and can never satisfy a required need. They are **not** guaranteed to leave Operating Instructions unweakened: the Engine collects Rules and does not read them — it decides on / off, whether the globs match, and where in the ladder — so what a model does with the text is the author's business, not an Engine gate (ADR 0018). Instruction precedence, general to specific: global Rules → repo `AGENTS.md` → repo Rules → private-overlay Rules → Operating Instructions, last and highest.
The frontmatter shape is a considered borrow from Cursor and Claude Code, which arrived at it independently — not a standard. `AGENTS.md` specifies a filename and closest-wins and nothing more.
_Avoid_: Operating Instructions (those are mandatory and engine-authored), Skill, prompt

**Middleware**:
An engine-owned interceptor around the model loop lifecycle, portable across owned-runtime Runs and distinct from Hooks interpreted by an external Harness. **Engine-only, and not a contribution kind** — a Plugin-shipped Middleware would run code inside the model loop, crossing ADR 0006's data-not-code line.
_Avoid_: Hook, Operating Instructions, contribution kind

**Hook**:
A Harness-native lifecycle extension projected only when the selected Harness supports it. A Hook does not become Middleware merely because both react to lifecycle events.
_Avoid_: Middleware

**Subagent**:
A named agent definition available for delegation by a parent agent. It remains a distinct Run Plan field even when a Harness projects it as a Tool. A person writes one as `agents/<name>.md` in an **Authoring tree**: YAML frontmatter with a required `name` (lowercase letters, digits, and hyphens, equal to the file name), a required `description`, an optional `tools` list (a YAML list or a comma-separated string), and an optional `metadata.model-level` (a **Model level**; absent means `standard`), then the prompt as the body. A file that does not decode still reaches the Run Plan, with the reason. A vendor `model` value is one such reason; `model: inherit` is not.
_Avoid_: Tool, Harness, Operation

**Sandbox policy**:
The allow, ask, and deny rules governing Tools, file writes, and network access during a Run.
_Avoid_: Middleware, Harness execution boundary
