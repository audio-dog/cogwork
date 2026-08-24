# TanStack AI's vocabulary: what it actually calls things

Date: 2026-08-24.

**Purpose.** An authoritative map of TanStack AI's own naming, so cogwork can align its domain
vocabulary to TanStack AI rather than inventing parallel umbrella terms. Every claim below is
tied to a doc page or a shipped type declaration.

**Sources.** The official docs at `https://tanstack.com/ai/latest/docs/`, read from their source
of truth — the `docs/` tree of `TanStack/ai` at `main` (`c7c3f950`, 2026-08-24, "docs: regenerate
API documentation" #1234). The nav map is
[`docs/config.json`](https://raw.githubusercontent.com/TanStack/ai/main/docs/config.json). Where
the docs are silent, type declarations are read from installed packages in this repo:
`@tanstack/ai@0.46.0`, `@tanstack/ai-sandbox@0.3.4` under `node_modules/.pnpm/`. npm `latest` at
time of writing: `@tanstack/ai@0.49.1`, `@tanstack/ai-sandbox@0.5.1`,
`@tanstack/ai-code-mode-snippets@0.4.4`, `@tanstack/ai-codex@0.5.0`, `@tanstack/intent@0.3.6` —
so both the docs and the installed packages trail npm. This is a 0.x ecosystem that renames
things; §12 records one rename that already happened.

Everything under "Documented" is quoted or paraphrased from a cited page. Everything under
"Inference" is mine.

---

## 0. Synthesis: the umbrella nouns (answer first)

**TanStack AI has no single umbrella noun for "the things you give an agent."** It keeps the
concepts flat and separately named — `tools`, `skills`, `plugins`, `scripts`, `instructions`,
`secrets` are six sibling keys on two config objects, never rolled up into one collective type or
one collective name. The closest thing to a collective is the *verb*, **provisioning**, and one
internal type name, **`WorkspaceSkill`**.

Four findings, in order of how load-bearing they are:

**1. "Skill" is the umbrella for provisioned agent environment, and it is deliberately broad.**
`defineWorkspace({ skills: [...] })` takes an array whose members include an MCP server and an
arbitrary file. The docs name this explicitly:

> "`skills` is an array of skill values that provision capabilities into the agent's environment.
> There are four builders, each describing a different kind of capability"
> — [sandbox/provisioning](https://tanstack.com/ai/latest/docs/sandbox/provisioning)

The four builders are `agentSkill`, `gitSkill`, `mcpSkill`, `fileSkill`. The union type is
`WorkspaceSkill`, documented in-source as "A unit of agent guidance/config projected into the
harness's native format" (`@tanstack/ai-sandbox@0.3.4` `dist/esm/workspace.d.ts`). So an MCP
server *is a kind of skill* in TanStack AI's model. That is the single most important naming
decision here.

**2. "Provisioning" is the collective *activity*, not a collective *noun for a thing*.**

> "Provisioning is how you hand the in-sandbox agent everything beyond the working tree: typed
> secrets, skill repos, MCP servers, plugins, and a universal instruction file."
> — [sandbox/provisioning](https://tanstack.com/ai/latest/docs/sandbox/provisioning)

Note the sentence enumerates five kinds rather than naming one category. There is no
`Provisioning` type, no `provisioning: {...}` key, and no `provision()` function. The page title is
`Provisioning (Advanced)`; the API is still `defineWorkspace`. The operative verb inside it is
**projection** (`projectWorkspace()`, `WorkspaceProjection`, `ProjectionCapability`). Full
treatment, including how it compares to cogwork's own "skill-provision", is §5.

**3. "Capability" is used, but for three narrow, unrelated, technical things — never as the
umbrella.** Using it as a general collective would collide:
- `createCapability<T>()('name')` — a typed middleware dependency-injection slot with
  `requires` / `provides` / `optionalRequires` and compile-time coverage checking
  ([advanced/middleware#capabilities](https://tanstack.com/ai/latest/docs/advanced/middleware)).
  Concrete instances: `SandboxCapability`, `SandboxPolicyCapability`, `LocksCapability`.
- `defineSandboxPolicy({ capabilities: { fileWrite, network } })` — "coarse, non-command
  capability gates" ([sandbox/policy](https://tanstack.com/ai/latest/docs/sandbox/policy)).
- Prose only, in one place: "Provider Skills are hosted, provider-managed **capability bundles**"
  ([tools/provider-skills](https://tanstack.com/ai/latest/docs/tools/provider-skills)) — and the
  provisioning quote above, "provision capabilities into the agent's environment."

**4. "Extension" is essentially absent.** Across the whole docs tree it appears only as
"[OTel] Extension points", "MCP Apps is a ratified MCP **extension**", "the persistence
**extension point**", and Grok's "Video Editing and Extension". It is never a noun for a
user-supplied unit of agent capability.

**Where TanStack AI deliberately avoids an umbrella.** The sandbox docs repeatedly split rather
than merge, and say so:
- The [Sandboxes Overview](https://tanstack.com/ai/latest/docs/sandbox/overview) frames a run as
  "**The three moving parts**" — Provider (*where*), Workspace (*what the agent sees*), Harness
  adapter (*which agent runs*) — three names, no fourth collective one.
- [sandbox/workspace](https://tanstack.com/ai/latest/docs/sandbox/workspace) splits itself from
  provisioning by hand: "This page covers the working tree itself: `source`, `packageManager`,
  `setup`, and `scripts`. Secrets, skills, and MCP servers live on Provisioning." Same object,
  two pages, two vocabularies, no merged term.
- [sandbox/tools](https://tanstack.com/ai/latest/docs/sandbox/tools) refuses to merge host tools
  with MCP skills: "This page is about your own host tools, bridged back to the orchestrator. If
  instead you want to give the agent third-party MCP servers … Those are declared on the
  workspace, see Provisioning."
- [tools/tools](https://tanstack.com/ai/latest/docs/tools/tools) refuses to merge app tools with
  provider-native ones: "Looking for provider-native tools like Anthropic web search … See
  Provider Tools."

**Practical guidance for aligning cogwork.** Use `skill` as the umbrella for anything provisioned
into an agent's environment (including MCP servers). Use `provisioning` for the act. Do **not**
coin "capability" as a collective — it is already spoken for three times over. Do **not** coin
"extension." Keep `tool`, `script`, `plugin`, `instructions`, `secret` as distinct sibling nouns
rather than rolling them up; TanStack AI's own docs treat every attempt to merge them as a thing
to explicitly disambiguate. One caveat on borrowing the word "provision": TanStack AI provisions
*into the checkout*, cogwork's ADR 0007 deliberately provisions *outside* it — same verb, opposite
destination (§5.5).

---

## 1. Core loop

**Entry point: `chat(options)`.** Returns an async iterable of `StreamChunk` (typed as
`ChatStream`). Sibling activity entry points are `summarize()`, `generateImage()`,
`generateVideo()`, `generateSpeech()`, `generateTranscription()`, `generateAudio()`,
`realtimeToken()` — one per **activity**, which is the word the docs use for this axis: "Every AI
activity — chat, summarization, image generation, speech, transcription, video — is a separate
import" ([comparison/vercel-ai-sdk](https://tanstack.com/ai/latest/docs/comparison/vercel-ai-sdk)).

Option keys ([api/ai](https://tanstack.com/ai/latest/docs/api/ai)):

| Key | Notes |
| --- | --- |
| `adapter` | e.g. `openaiText('gpt-5.2')`. Required. |
| `messages` | mixed `UIMessage \| ModelMessage` array |
| `tools?` | array of tools |
| `context?` | "Typed runtime context passed to server tools and middleware" |
| `systemPrompts?` | `string[]` |
| `agentLoopStrategy?` | default `maxIterations(5)` |
| `middleware?` | array of chat middleware |
| `abortController?` | |
| `modelOptions?` | provider-native options; **renamed from `providerOptions`**; sampling params live here |
| `threadId?` / `runId?` / `parentRunId?` | AG-UI ids |
| `outputSchema?` | structured output (§8) |
| `mcp?` | `{ clients, connection, lazyTools, onDiscoveryError }` (§3) |
| `interrupts?` | registry of `defineInterrupt()` definitions (§7) |
| `resume?` | resumable-stream continuation |
| `stream?` | `true` for the streaming structured-output path |

**The loop itself is "the agentic cycle."** Page title
[chat/agentic-cycle](https://tanstack.com/ai/latest/docs/chat/agentic-cycle); the page also says
"agent loop" and counts **iterations**, defined as *model turns*, not tool calls. Loop control is
`agentLoopStrategy`, "a function that receives `{ iterationCount, finishReason, messages,
toolCallCount, lastTurnToolCallCount }` and returns `true` to allow another iteration". Built-ins:
`maxIterations`, `untilFinishReason`, `combineStrategies`.

**No `maxToolCalls` strategy on `main`.** "There is no built-in `maxToolCalls` strategy. Cap tools
with middleware" — `onBeforeToolCall` for a per-turn cap, `onShouldContinue` for a cumulative
budget. The recipe function in the docs is labelled "App-owned policy — not a library export."
(Installed 0.42 *did* export `maxToolCalls`; see the version caveat in
`docs/research/tanstack-ai-audit.md`.)

**Threads and runs** are the framing nouns for a stream, and they come from AG-UI, not TanStack:
"A **thread** (`threadId`) is the conversation … A **run** (`runId`) is one execution inside it"
([chat/streaming#threads-and-runs](https://tanstack.com/ai/latest/docs/chat/streaming)). One
agentic cycle, however many iterations, is one run.

## 2. Tools

**Umbrella noun: `tool`. There is no broader one.** The vocabulary:

| Term | What it is |
| --- | --- |
| `toolDefinition(config)` | the isomorphic definition step; config keys `name`, `description`, `inputSchema`, `outputSchema?`, `needsApproval?`, `lazy?`, `metadata?` |
| `.server(fn)` / `.client(fn)` | the implementation step, producing a `ServerTool` / `ClientTool` |
| `ToolDefinition`, `ToolDefinitionConfig`, `ToolDefinitionInstance`, `Tool`, `ToolConfig` | exported interfaces ([reference/interfaces](https://tanstack.com/ai/latest/docs/reference/interfaces/ToolDefinition)) |
| `ToolExecutionContext` | second arg to `.server()`: `{ context, toolCallId, emitCustomEvent }` |
| `ToolCall`, `ToolCallPart`, `ToolResultPart` | message parts |
| `ToolCallState` / `ToolResultState` | two separate state sets, see below |
| `InferToolInput` / `InferToolOutput` / `InferToolName` | type helpers |

**"Isomorphic tool system"** is the term of art for define-once/implement-per-environment
([tools/tools](https://tanstack.com/ai/latest/docs/tools/tools)). Categories the docs name
separately, never merged: **server tools**, **client tools**, **hybrid tools**, **provider tools**
(provider-native like web search / code execution), **native tools** (what an in-sandbox agent has
on its own: "Bash, file edits, and search"), **bridged tools** (host `chat()` tools proxied into a
sandbox over a host-side MCP tool-proxy, gated by "a **random per-run bearer token**").

**States** — two sets, and the docs call this out as canonical
([tools/tool-architecture](https://tanstack.com/ai/latest/docs/tools/tool-architecture)): call
states on the `tool-call` part are `awaiting-input`, `input-streaming`, `input-complete`,
`approval-requested`, `approval-responded`; result states on the sibling `tool-result` part are
`streaming`, `complete`, `error`.

**Lazy tools.** `lazy: true` on a definition; "Tools marked with `lazy: true` are **not** sent to
the LLM upfront. Instead, a synthetic `__lazy__tool__discovery__` tool is created"
([tools/lazy-tool-discovery](https://tanstack.com/ai/latest/docs/tools/lazy-tool-discovery)). The
feature is "lazy tool discovery"; the comparison page also calls it "progressive disclosure."

**Tool registry.** `ToolRegistry` exists but is narrow — it is the Code Mode + snippets return
value, "Mutable registry containing all tools. Pass to `chat()` via `tools:
toolsRegistry.getTools()`"
([code-mode/code-mode-with-snippets](https://tanstack.com/ai/latest/docs/code-mode/code-mode-with-snippets)).
Plain `chat()` has no registry; you pass a `tools` array.

## 3. Skills — three unrelated meanings, and TanStack knows it

"Skill" is TanStack AI's most overloaded word. Three distinct senses, each with its own page,
each cross-linking to disclaim the others.

### 3a. Workspace skills (`defineWorkspace({ skills })`) — the provisioning sense

Four builders from `@tanstack/ai-sandbox`
([sandbox/provisioning](https://tanstack.com/ai/latest/docs/sandbox/provisioning)):

| Builder | What it provisions (docs' own table) |
| --- | --- |
| `agentSkill(name)` | "A named public skill (portable placeholder; Claude Code warns and skips it, so use `gitSkill` instead)." |
| `gitSkill({ repo, secret?, into? })` | "A skill repo cloned into the workspace, with optional auth and clone path." |
| `mcpSkill(name, config)` | "A third-party MCP server, with URL and headers." |
| `fileSkill({ path, content })` | "An arbitrary file written into the workspace." |

Union type `WorkspaceSkill` with `kind: 'file' | 'agent-skill' | 'mcp' | 'git'`
(`@tanstack/ai-sandbox@0.3.4` `dist/esm/workspace.d.ts`).

**`mcpSkill` is exactly this and nothing more:** a declaration that a third-party MCP server
should be wired into the in-sandbox agent's own config, projected per harness — "Claude Code →
`.mcp.json`, Codex → `.codex/config.toml`, OpenCode → `opencode.json`". `acpCompatible` is the
outlier and the docs flag it as an advantage: `mcpSkill` is "Passed to the agent over **ACP
natively** via `newSession`'s `mcpServers` … No config file — that's the ACP advantage over
file-based harnesses"
([adapters/acp-compatible](https://tanstack.com/ai/latest/docs/adapters/acp-compatible)). Header
values may be `SecretRef`s or `bearer(ref)`, resolved at projection time. Crucially, `mcpSkill` is
*not* the same mechanism as `chat({ mcp: { clients } })` (§10) — the docs draw the line explicitly:
"These MCP servers are third-party services you point the agent at. Bridging your **own app's host
tools** into the agent … is a different mechanism."

**Relation to SKILL.md is direct, and it is a filesystem convention, not an API.** "Each projector
walks the cloned repo for folders that contain `SKILL.md`. A nested pack (`skills/foo/SKILL.md`)
is linked under the skill name `foo`. A flat clone with `SKILL.md` at the root uses the clone
name. You do not write `ln -s` by hand." `gitSkill` defaults to cloning into
`.tanstack-skills/<repo-basename>`. Related exported helpers: `discoverSkillDirs`,
`resolveGitSkillDir`, `DiscoveredSkillDir` (`@tanstack/ai-sandbox` index).

**Degradation is warn-and-skip, not throw:** "A concept a given CLI lacks (for example, `plugins`
on Codex) **emits a warning and is silently skipped** rather than throwing."

### 3b. Provider Skills — the hosted sense

> "Provider Skills are hosted, provider-managed capability bundles that the model loads on demand
> and runs inside the provider's server-side sandbox. You reference them by a skill ID; the
> provider handles installation and execution."
> — [tools/provider-skills](https://tanstack.com/ai/latest/docs/tools/provider-skills)

Not a top-level option. "Skills are **inert without an execution tool**" — they nest inside a
provider tool: Anthropic `codeExecutionTool(config, { skills })` with entries typed
`AnthropicContainerSkill` (`{ type: 'anthropic' | 'custom', skill_id, version? }`, max 8); OpenAI
`shellTool({ environment: { type: 'container_auto', skills } })` with entries typed
`SkillReference` (`{ type: 'skill_reference', skill_id, version? }`, Responses API only).
"Only **hosted, managed-by-id** skills are wired by these factories."

### 3c. Agent Skills (TanStack Intent) — the authoring sense

> "Agent Skills are markdown documents (`SKILL.md`) that ship inside npm packages and tell AI
> coding agents how to use a library correctly … The format is an open standard supported by
> Claude Code, Cursor, GitHub Copilot, Codex, and others."
> — [getting-started/agent-skills](https://tanstack.com/ai/latest/docs/getting-started/agent-skills)

Installed with `npx @tanstack/intent@latest install`, which writes an `intent-skills` YAML block of
`{ task, load }` mappings into `AGENTS.md`. Skills live at
`node_modules/<package>/skills/<skill-name>/SKILL.md` and "route to each other." Shipped skills:
`ai-core`, `ai-persistence`, `tanstack-ai-memory`, `ai-mcp`, `ai-sandbox`, `ai-code-mode`.

### 3d. What "skill" is *not* any more

Code Mode's runtime code library used to be called skills and was renamed. See §12.

## 4. Sandbox, workspace, and Scripts

**Three moving parts** ([sandbox/overview](https://tanstack.com/ai/latest/docs/sandbox/overview)):
**provider** (`localProcessSandbox`, `dockerSandbox`, `sbxSandbox`, `daytonaSandbox`,
`vercelSandbox`, Sprites — "A provider owns the isolation primitive: where the harness actually
runs"), **workspace** (`defineWorkspace`), **harness adapter** (which agent runs).
`defineSandbox({ id, provider, workspace, policy, lifecycle, hooks, fileEvents })` binds them;
`withSandbox(definition)` is "the `chat()` middleware that turns it on for a run."

`defineWorkspace` keys: `source` (`githubRepo` / `gitSource` / `localSource` / `{type:'local'}` /
`{type:'none'}`), `packageManager`, `setup`, `scripts`, `skills`, `plugins`, `instructions`,
`secrets`. `setup` accepts a string array or a builder callback with `serial` / `parallel` over "a
**persistent shell**". `instructions` is written to `AGENTS.md`, with `CLAUDE.md` / `GEMINI.md` as
symlinks. One more key exists in the type but appears in no docs page: `root?: string`, "Workspace
root inside the sandbox. Defaults to `/workspace`" (`dist/esm/workspace.d.ts` L125–126) — the
portable root every provisioned path is built from (§5).

### Scripts — what a Script actually is

**Documented** ([sandbox/workspace#scripts](https://tanstack.com/ai/latest/docs/sandbox/workspace#scripts)):

> "`scripts` is a map of named commands the agent and user can invoke by name, without restating
> the full command line each time"

```ts
defineWorkspace({
  source: githubRepo({ repo: 'owner/app' }),
  scripts: { test: 'pnpm test', build: 'pnpm build', typecheck: 'pnpm test:types' },
})
```

and, closing the page:

> "These are surfaced as named commands rather than freeform shell, which also gives
> [Policy](https://tanstack.com/ai/latest/docs/sandbox/policy) a stable name to allow, ask about,
> or deny."

Policy reinforces it from the other side: "Prefer the named workspace scripts (`pnpm test`,
`pnpm build`) in your `allow` list. They give the policy stable names to match rather than
freeform shell."

**Undocumented mechanics** (read from `@tanstack/ai-sandbox@0.3.4`, because the docs never say
*how* a script is "surfaced"):

- The type is bare: `scripts?: Record<string, string>` — "Named commands the agent/user can
  invoke (e.g. `{ test: 'pnpm test' }`)" (`dist/esm/workspace.d.ts`).
- **A Script is not a tool.** There is no `run_script` tool, no script executor, and nothing in
  the package's public exports that runs one. Scripts have no runtime of their own.
- **How the agent learns about them: prose in `AGENTS.md`.** `formatWorkspaceScriptsSection`
  (exported from the package root) renders a `## Workspace scripts` markdown section as a sorted
  list of `- name → command`, and `mergeAgentsContent` appends it to the `instructions` body
  before `bootstrapWorkspace` writes the file (`dist/esm/agents-file.js`, `dist/esm/bootstrap.js`).
- **How policy consumes them: alias expansion.** `commandAliases(command, scripts)` returns "All
  equivalent forms of a command line when workspace scripts are defined: the literal command, its
  expanded script value, and any script name that expands to the same value."
  `evaluateCommand(command, policy, scripts)` matches patterns against every alias form: "policy
  patterns may match either a script name or its expanded command value (and vice versa for the
  command under test)" (`dist/esm/policy.d.ts`). Both are public exports of `@tanstack/ai-sandbox`.
- **The exact rendered form.** `formatWorkspaceScriptsSection` produces literally:

  ```text
  ## Workspace scripts

  - build → pnpm build
  - test → pnpm test
  ```

  Sorted by name; empty map renders `''`. `mergeAgentsContent(base, scripts)` joins it to the
  `instructions` body with a blank line, and returns `undefined` when there is nothing to write —
  so a workspace with `scripts` but no `instructions` still gets an `AGENTS.md` containing only
  the scripts section (`dist/esm/agents-file.js`).
- **Scripts also ride along to harness projectors.** `WorkspaceProjection` carries an optional
  `scripts?: Record<string, string>` alongside `skills`, `plugins`, `resolveSecret`, `markerPath`,
  and `root`, so a per-harness projector can render them into a native format too
  (`dist/esm/projection.d.ts`, `dist/esm/middleware.js` L237–248). No shipped projector read here
  uses that field.
- **`withSandbox` threads `workspace.scripts` into the approval path** so an `ask` decision on a
  script name resolves the same as one on the expanded command
  (`dist/esm/middleware.js`, `dist/esm/approvals.js` L29).

**Inference — what a Script *is*.** A Script in TanStack AI is a **named alias for a command
line**. It has no executor and no wire representation. It exists for exactly two purposes:

1. **Advertisement.** The names and their expansions are written into `AGENTS.md` as prose, which
   the agent CLI reads natively. That is the entire "the agent can invoke it by name" mechanism —
   the agent runs `pnpm test` (or `test`, if its shell resolves it) through its own Bash tool, the
   way it would any other command.
2. **A stable identity for policy.** `allow: ['test']` and `allow: ['pnpm test']` mean the same
   thing because `commandAliases` expands both directions.

A Script is deliberately *not* a tool, *not* a skill, and *not* a capability: it adds no execution
path the agent did not already have. It narrows the *description* of an existing path and gives
the guardrail layer a name to bind to.

**Inference — keep or drop a "Script" concept.** Worth keeping only if it earns both of those two
jobs. If a project has a policy/permission layer that would otherwise match on raw command
strings, Scripts pay for themselves as the stable name that layer binds to, and TanStack AI's
naming (`scripts: Record<string, string>` on the workspace, a `## Workspace scripts` section in
`AGENTS.md`) is a ready-made convention to copy. If there is no such matcher — or if the agent is
told about commands some other way — a Script is a `Record<string,string>` that only ever gets
rendered into a markdown list, and dropping it costs nothing that a paragraph of `instructions`
would not also buy.

## 5. Provisioning — what TanStack AI means by the word

Page: [sandbox/provisioning](https://tanstack.com/ai/latest/docs/sandbox/provisioning), titled
`Provisioning (Advanced)`, `id: provisioning`.

### 5.1 The definition, verbatim

> "Provisioning is how you hand the in-sandbox agent everything beyond the working tree: typed
> secrets, skill repos, MCP servers, plugins, and a universal instruction file. You declare it all
> on `defineWorkspace()`, and each harness adapter projects it into its own native format at
> bootstrap, so the same definition works whether the agent is Grok Build, Claude Code, Codex, or
> OpenCode."

The page's `description` frontmatter says the same thing in one line: "Give the in-sandbox agent
secrets, skill repos, MCP servers, plugins, and instructions with one portable definition that
each harness projects into its own native format."

Three things follow directly from that sentence:

- **The subject is always the in-sandbox agent.** Provisioning is scoped to a sandbox. There is no
  provisioning concept on a bare `chat()` call.
- **"Everything beyond the working tree" is the boundary.** The working tree itself (`source`,
  `packageManager`, `setup`, `scripts`) is [Workspace](https://tanstack.com/ai/latest/docs/sandbox/workspace);
  everything else you hand the agent is Provisioning. Both are keys on the same
  `defineWorkspace()` object — the split is editorial, not structural.
- **The mechanism is *projection*.** "each harness adapter **projects** it into its own native
  format at bootstrap." Projection is the operative verb; provisioning is the umbrella activity.

### 5.2 Exact identifiers

All from `@tanstack/ai-sandbox`.

| Identifier | Kind | Role |
| --- | --- | --- |
| `defineWorkspace({ skills, plugins, instructions, secrets, ... })` | function | the one declaration site |
| `skills?: Array<WorkspaceSkill>` | option key | "Guidance/config projected into the harness" (`workspace.d.ts`) |
| `plugins?: Array<string>` | option key | "Harness plugin identifiers installed idempotently by each harness projector (e.g. `['@anthropic/plugin-foo']` for Claude Code)" |
| `instructions?: string` | option key | "Natural-language instructions written to AGENTS.md (and symlinked as CLAUDE.md, GEMINI.md, etc.) inside the sandbox during bootstrap" |
| `secrets?: Secrets` | option key | typed `SecretRef` registry |
| `agentSkill(name)` | builder | `{ kind: 'agent-skill', name }` |
| `gitSkill({ repo, secret?, into? })` | builder | `{ kind: 'git', ... }` |
| `mcpSkill(name, config)` | builder | `{ kind: 'mcp', name, config }` |
| `fileSkill({ path, content })` | builder | `{ kind: 'file', path, content }` |
| `WorkspaceSkill` | union type | "A unit of agent guidance/config projected into the harness's native format" |
| `McpConfig` | type | `{ headers?: Record<string, string \| SecretRef \| BearerRef>, [key: string]: unknown }` |
| `createSecrets(record)` / `bearer(ref)` | functions | secret refs and `Bearer <value>` header wrapping |
| `SecretRef`, `Secrets`, `BearerRef` | types | |
| `resolveSecret`, `resolveAllSecrets`, `resolveBearer`, `isSecretRef` | functions | resolution helpers |
| `bootstrapWorkspace(handle, workspace, opts?)` | function | the provider-agnostic half (see 5.3) |
| `WorkspaceProjection` | interface | `{ skills, plugins, resolveSecret, markerPath, root, scripts? }` |
| `ProjectionCapability` / `getWorkspaceProjection` / `provideWorkspaceProjection` | capability | how a harness adapter receives the projection |
| `resolveGitSkillDir(root, skill)` | function | `<root>/.tanstack-skills/<basename>` |
| `discoverSkillDirs(handle, cloneDir)` | function | "Find every skill folder under a cloned `gitSkill` repo. A skill folder is a directory that contains `SKILL.md`." |
| `DiscoveredSkillDir` | type | `{ name: string; dir: string }` |
| `writeAgentsFile(handle, root, content)` | function | writes `AGENTS.md` + per-CLI symlinks |
| `formatWorkspaceScriptsSection` / `mergeAgentsContent` | functions | the scripts section of `AGENTS.md` |
| `DEFAULT_WORKSPACE_ROOT = '/workspace'` | constant | the portable root |
| `computeWorkspaceHash(workspace)` | function | feeds the projection marker filename |

Also present but *not* part of provisioning: `defineSandboxPolicy` (guardrails, §6),
`defineSandbox` (binding), `withSandbox` (the middleware that runs all of it).

### 5.3 The lifecycle: what happens, in what order, where

Provisioning is split across **two phases with two different owners**, and the split is stated in
the source (`dist/esm/bootstrap.js` header comment):

> "Workspace bootstrap engine — provider-agnostic because it only uses the `SandboxHandle`
> contract. Runs once when a sandbox is freshly created (or restored without its working tree):
> land the source, inject secrets, detect the package manager, and run setup commands.
> **Harness-specific projection (CLAUDE.md, agent skills, MCP config) is NOT done here** — that's
> each adapter's `projectWorkspace()` hook, since the format differs per harness."

**Phase A — `bootstrapWorkspace()`, once per fresh/restored sandbox, harness-agnostic**
(`dist/esm/bootstrap.js`, exact order):

1. `resolveAllSecrets(workspace.secrets)` → `handle.env.set(resolved)`. Secrets become
   **environment variables on the live sandbox handle**.
2. Clone `source` into `root` (default `/workspace`) — skipped if `<root>/.git` already exists.
3. For every `gitSkill`: `handle.git.clone({ url, dir, auth, depth: 1 })` into
   `skill.into ?? resolveGitSkillDir(root, skill)` — i.e. **`<root>/.tanstack-skills/<basename>`**.
   Auth token resolved from the secrets registry at clone time.
4. Compute `AGENTS.md` content: `instructions` if set, else a `fileSkill` whose `path` is
   `AGENTS.md`; then `mergeAgentsContent(content, workspace.scripts)` appends the
   `## Workspace scripts` section. `writeAgentsFile(handle, root, content)` writes
   `<root>/AGENTS.md` plus per-CLI symlinks (copies as fallback).
5. Every other `fileSkill`: `handle.fs.write(`${root}/${skill.path}`, skill.content)`.
6. `detectPackageManager` from the lockfile.
7. Run the `setup` plan on a persistent bootstrap shell, `cwd = root`.

Note what phase A does **not** touch: `mcpSkill`, `agentSkill`, `plugins`. Those are pure
projection inputs.

**Phase B — `projectWorkspace()`, per harness adapter, inside `chatStream` setup.** `withSandbox`
publishes a `WorkspaceProjection` through `ProjectionCapability`
(`dist/esm/middleware.js` L232–248), and the adapter reads it. The interface's own doc comment:
"Harness adapters read this in their `chatStream` setup to project workspace inputs into their
native format (MCP config, skills dirs, plugin installs)."

Idempotency is a **marker file on disk inside the sandbox**: `markerPath` is
`` `${root}/.tanstack-projected-${workspaceHash}` ``. "Harness adapters write this file after a
successful projection so subsequent runs skip re-projection. The file is NOT included in
snapshots — absent on restore, triggering re-projection (which re-writes any secret-bearing
config files)" (`projection.d.ts`). Confirmed in
[sandbox/portable-snapshots-safety](https://tanstack.com/ai/latest/docs/sandbox/portable-snapshots-safety),
whose default snapshot exclusions list "The projection marker, `.tanstack-projected-<workspaceHash>`,
at the workspace root only", plus "`CLAUDE.md` and `GEMINI.md` at the workspace root" and "Direct
`.claude/skills/<name>`, `.codex/skills/<name>`, and `.grok/skills/<name>` paths."

A worked projector, read from `@tanstack/ai-acp@0.3.1` `dist/esm/adapters/projection.js`
(`projectAcpWorkspace`), because it is the one installed here:

```
if (fs.exists(markerPath)) return                    // idempotency gate
for each gitSkill:
  discoverSkillDirs(handle, into ?? .tanstack-skills/<basename>)   // folders containing SKILL.md
  for each { name, dir }:
    exec `cp -r <dir> <skillsDir>/<name>`  with cwd = root
for each agentSkill: console.warn(... "Skipping.")
for each plugin:     console.warn(... "Skipping.")
fs.write(markerPath, '')
```

`mcpSkill` is handled separately by `workspaceMcpServers(projection)`, which resolves every header
value (plain / `SecretRef` / `bearer`) and hands the list to ACP's `newSession({ mcpServers })` —
no file at all. The doc comment states the contrast: "no config file is written, because an ACP
agent receives MCP servers over the protocol. This is the key difference from file-based harnesses
(Claude Code, Codex) that read MCP from disk."

The docs' per-harness table for the file-based ones
([sandbox/provisioning](https://tanstack.com/ai/latest/docs/sandbox/provisioning)): Claude Code →
`.mcp.json`, Codex → `.codex/config.toml`, OpenCode → `opencode.json`. And on `gitSkill`: "Each
projector walks the cloned repo for folders that contain `SKILL.md`. A nested pack
(`skills/foo/SKILL.md`) is linked under the skill name `foo`. A flat clone with `SKILL.md` at the
root uses the clone name. You do not write `ln -s` by hand."

### 5.4 Is "provision" about files on disk, resources attached to a run, or environment setup?

**All three, split by input kind. There is no single answer, and the docs never claim one.** The
verb "provision" in TanStack AI is *environment setup for one sandbox*, realised through whichever
mechanism the input kind and the target harness require:

| Input | Realised as | Where it lands |
| --- | --- | --- |
| `instructions` | **a file on disk** | `<root>/AGENTS.md` + `CLAUDE.md` / `GEMINI.md` symlinks |
| `fileSkill` | **a file on disk** | `<root>/<path>` |
| `gitSkill` | **a directory on disk**, cloned then copied | `<root>/.tanstack-skills/<basename>`, then `cp -r` into the harness's skills dir (e.g. `<root>/.claude/skills/<name>`, `<root>/.pi/skills/<name>`) |
| `scripts` | **prose inside a file on disk** | the `## Workspace scripts` section of `<root>/AGENTS.md` |
| `mcpSkill` | **a config file on disk** (Claude Code / Codex / OpenCode) **or a protocol message** (ACP `newSession.mcpServers`) | `<root>/.mcp.json`, `<root>/.codex/config.toml`, `<root>/opencode.json`, or nothing on disk |
| `plugins` | **an install action** the harness performs | harness-internal; "installed idempotently by each harness projector" |
| `secrets` | **environment variables on the live handle** | `handle.env.set(...)`; explicitly never on disk — "never written to snapshots, the sandbox store, or the event log" |

The docs' own framing is the environment one — "hand the in-sandbox agent everything beyond the
working tree" — and the type-level framing is the projection one — `WorkspaceSkill` is "A unit of
agent guidance/config projected into the harness's native format." *Files on disk* is the dominant
implementation but is never the definition; secrets are provisioned and never touch disk, and MCP
on ACP is provisioned and never touches disk either.

**One sharp fact.** Every on-disk destination above is **under the workspace root, which is the
same directory as the cloned source repo's working tree.** `root = workspace.root ?? '/workspace'`,
the source is cloned into `root`, and every skill path is built from `root`. TanStack AI writes
provisioned files *into the checkout*. It never writes outside it. The docs never discuss the git
consequence; the mitigations are downstream and indirect:
- Portable snapshots exclude the projection marker, `CLAUDE.md` / `GEMINI.md`, and
  `.{claude,codex,grok}/skills/<name>`
  ([portable-snapshots-safety](https://tanstack.com/ai/latest/docs/sandbox/portable-snapshots-safety)).
- The `file.changed` event carries "the whole working-tree `git diff`", and
  [sandbox/observability](https://tanstack.com/ai/latest/docs/sandbox/observability) notes that
  "`git diff` ignores untracked files" — so freshly written, untracked provisioned files do not
  appear in the streamed diff.

Neither is a `.gitignore`, and neither prevents `git status` in the sandbox from showing the
provisioned paths as untracked.

### 5.5 Compared with cogwork engine ADR 0007's "skill-provision"

ADR 0007 (`packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md`)
defines skill-provision as: copy the whole skill directory from `packages/engine/skills/` "onto a
host path under `~/.cogwork/` (not into the driven worktree) so sibling files stay readable
without dirtying git", and says this "mirrors TanStack sandbox's 'skills are files on disk' idea
without using `defineWorkspace` projection on the first-party `chat()` path."

**Verdict: overlapping in intent, materially different in three respects — and directly opposed on
the one that ADR 0007 treats as its rationale.**

*Where they agree.* Both take "a skill is a directory containing `SKILL.md` plus sibling files,"
both make it reachable to the agent by putting it on a filesystem the agent can read, and both
accept that the `SKILL.md` body may separately be injected into the prompt. ADR 0007's citation of
"skills are files on disk" is a fair reading of `gitSkill` + `fileSkill` + `discoverSkillDirs`.

*Where they differ.*

1. **Destination — this is the real conflict.** ADR 0007's defining constraint is "**not** into the
   driven worktree… without dirtying git," and its rejected option list contains "**Copy skills
   into the worktree** — rejected: dirties the driven checkout and risks landing in a PR."
   TanStack AI does exactly the rejected thing: every provisioned artifact lands under
   `root` = the checkout (§5.4). TanStack has no host-side location at all — no `~/.tanstack/`, no
   out-of-tree skills dir. So ADR 0007 does not "mirror" TanStack's placement; it deliberately
   **inverts** it. Note the inversion is well-motivated by a difference in situation, not a
   misreading: TanStack's checkout is a throwaway clone inside a disposable sandbox, so untracked
   files in it cost nothing; cogwork drives a real worktree whose diff becomes a PR.

2. **Scope — provisioning-the-noun.** TanStack's `skills` array is broader than a skill directory:
   it also carries MCP servers (`mcpSkill`) and arbitrary files (`fileSkill`), and provisioning as
   a whole also covers `plugins`, `instructions`, and `secrets`. ADR 0007's "skill-provision" names
   only the directory copy, and explicitly routes MCP elsewhere: "MCP skills stay on the capability
   channel (ADR 0005), not as a fourth instruction layer." That is a narrower, more specific use of
   the word than TanStack's.

3. **Mechanism and timing.** TanStack provisioning is two-phase (harness-agnostic
   `bootstrapWorkspace`, then per-harness `projectWorkspace` gated by an on-disk marker), keyed to
   a sandbox's creation, and *portable* — the same `defineWorkspace` is re-rendered per harness.
   ADR 0007's skill-provision is a single host-side copy on the first-party `chat()` path, with no
   sandbox, no projection step, and no marker; the ADR says so directly ("without using
   `defineWorkspace` projection on the first-party `chat()` path"). The ADR 0010 amendment then
   extends the provisioned path to every harness runner, which is a projection-shaped move made
   without projection machinery.

*Naming implication.* Using "provision" for both is defensible — TanStack's own use is loose enough
to cover "put the agent's environment in place" — but the sentence in ADR 0007 claiming to mirror
TanStack should not be read as claiming placement parity. If cogwork wants to keep the word
"provision" *and* be precise, the honest framing is: same verb, same noun (`skill`), **opposite
destination**, and a narrower scope. If a distinguishing term is wanted, "host-side skill
provision" states the difference in two extra words and needs no new vocabulary.

## 6. Policy / permissions

`defineSandboxPolicy({ commands, capabilities, default })`, attached via
`defineSandbox({ policy })` ([sandbox/policy](https://tanstack.com/ai/latest/docs/sandbox/policy)).

- **Decisions** are `PolicyDecision = 'allow' | 'ask' | 'deny'`. The docs' table: `allow` = "runs
  it without interruption"; `ask` = "The agent pauses; the harness emits an approval request the
  client answers"; `deny` = "blocked outright."
- **`commands`** is `CommandRules { allow?, ask?, deny? }` — glob/prefix patterns (`curl *`,
  `sudo *`).
- **`capabilities`** is `CapabilityRules { fileWrite?, network? }` — "coarse, non-command
  capability gates," "the broad backstop."
- **Precedence** is stated as a heading: "**Precedence: deny > ask > allow**", then `default`
  (itself defaulting to `'ask'`).
- **Portability** is the point: "A policy is portable. Each harness adapter translates the same
  `allow` / `ask` / `deny` description into its own native permission system." Degradation again:
  "the unsupported rule is skipped (with a warning) instead of throwing." A documented sharp edge:
  "A deny-only list with `default: 'allow'` stays permissive on Grok Build and Codex … Use Claude
  Code when you need command-level deny."
- **Evaluator exports** (not in the prose docs): `evaluateCommand`, `commandAliases`, and from
  `approvals.js`, `resolveApproval`, `approvalId`, `buildApprovalRequestedEvent`,
  `APPROVAL_REQUESTED_EVENT`. Capabilities the sandbox layer provides to middleware:
  `SandboxCapability`, `SandboxPolicyCapability`, `ToolBridgeProvisionerCapability`,
  `SandboxDurabilityCapability`, `SandboxInstanceStoreCapability`, `ProjectionCapability`.

**Secrets channel.** `createSecrets({ ... })` returns opaque `SecretRef` tokens; `bearer(ref)`
wraps one into a `Bearer <value>` header value at resolution time. The mechanism is named: "The
real strings are held in a **non-enumerable, symbol-keyed registry**," so "`Object.keys(secrets)`,
spreads, and `JSON.stringify(secrets)` never expose the values" and "The values are **never
written to snapshots, the sandbox store, or the event log**"
([sandbox/provisioning](https://tanstack.com/ai/latest/docs/sandbox/provisioning)). Related
exports: `isSecretRef`, `resolveSecret`, `resolveBearer`, `resolveAllSecrets`, types `SecretRef`,
`Secrets`, `BearerRef`.

## 7. Middleware, persistence, interrupts

**Middleware is the app-level lifecycle layer** on `chat()`, contrasted in the comparison table
with Vercel's model-level `wrapLanguageModel()`: "App-level lifecycle hooks (config, iterations,
chunks, tool calls, usage, errors)."

Hooks ([advanced/middleware](https://tanstack.com/ai/latest/docs/advanced/middleware)): `setup`,
`onConfig`, `onStructuredOutputConfig`, `onStart`, `onIteration`, `onChunk`, `onBeforeToolCall`,
`onAfterToolCall`, `onToolPhaseComplete`, `onShouldContinue`, `onUsage`, `onInterruptBoundary`,
`onInterruptResolution`, `onFinish` / `onAbort` / `onError` ("exactly one" of the last three).

**`onConfig` specifically** is "Called once during `init` (startup) and once per iteration during
`beforeModel` (before each model call)," returning "a **partial** config object" that is
shallow-merged. Transformable fields: `messages`, `systemPrompts`, `tools`, `metadata`,
`modelOptions`. Composition is **piped** for `onConfig` / `onStructuredOutputConfig` / `onChunk`,
**first-win** for `onBeforeToolCall`, **AND** for `onShouldContinue`, sequential for the rest.

**Phases** (`ctx.phase`): `init`, `beforeModel`, `modelStream`, `beforeTools`, `afterTools`,
`structuredOutput`.

**Authoring helpers**: `defineChatMiddleware`, `createChatMiddleware().use(...).build()` (the
builder "enforces **provider-before-consumer ordering at compile time**"), `createCapability`,
`ChatMiddleware` / `ChatMiddlewareContext` types. **Built-in middleware**: `toolCacheMiddleware`,
`contentGuardMiddleware` (both `@tanstack/ai/middlewares`), `otelMiddleware`
(`@tanstack/ai/middlewares/otel`). Other middleware across packages: `withPersistence`,
`withGenerationPersistence`, `withSandbox`, `withLocks`, `withNgrokBridge`, `memoryMiddleware`.

**`withPersistence` sits at the middleware layer, over a store layer.** "`withPersistence` writes
the transcript, run status and any pending approvals into your own store"
([persistence/overview](https://tanstack.com/ai/latest/docs/persistence/overview)). Stores are
named contracts from `@tanstack/ai-persistence`
([persistence/store-reference](https://tanstack.com/ai/latest/docs/persistence/store-reference)):
`messages` (required), `runs`, **`interrupts`** ("Pending, resolved or cancelled human waits.
Needs `runs`."), `metadata`, `generationRuns`, `artifacts`, `blobs`. `InterruptStore` methods:
`create`, `resolve(interruptId, response?)`, `cancel(interruptId)`, `get`, plus `list*`. Named
groupings exist: `ChatTranscriptStores`, `ChatPersistenceStores`, `ChatWithInterruptsStores`.
Client-side, `persistence: true` (server-authoritative) vs `persistence: <adapter>`
(`localStoragePersistence()`, `sessionStoragePersistence()`, `indexedDBPersistence()`).
"Middleware turns behavior on from whichever stores are present, so there is no separate enable
list."

**Interrupts are the pause vocabulary**, and they sit at the protocol/stream layer, above tool
approval.

> "An interrupt is a pause. The run stops, hands you a decision to make, and then picks up exactly
> where it left off once you answer."
> — [interrupts/overview](https://tanstack.com/ai/latest/docs/interrupts/overview)

Kinds: `tool-approval`, `generic`, `unbound`. Client surface: an `interrupts` array from
`useChat`, each item carrying `resolveInterrupt(...)`, `cancel()`, `clearResolution()`; plus a
batch `resolveInterrupts(...)`. Server surface: `defineInterrupt()` registered on both
`chat({ interrupts })` and `useChat({ interrupts })`, emitted by middleware via
`onInterruptBoundary`. Boundaries are `beforeModel`, `afterModel`, `beforeTools`, `afterTools`.
External producers attach a binding with `withInterruptBinding` (constants
`INTERRUPT_BINDING_VERSION`, `INTERRUPT_BINDING_METADATA_KEY`, helpers `canonicalInterruptJson`,
`digestInterruptJson`); a bad binding yields `kind: 'unbound'` — "It remains visible, but has no
controls." A pause "spans **two runs**: the interrupted one ends, and the continuation is a new
run. One user-visible turn, two run lifecycles." And: "No database is required."

**`summarize()` is a separate activity, not a compaction middleware.** `summarize({ adapter, text,
maxLength?, style?, modelOptions? })` returns a `SummarizationResult`; the adapter is a distinct
one (`openaiSummarize`), the hook is `useSummarize()`, types are `SummarizationOptions` /
`SummarizationResult` ([api/ai](https://tanstack.com/ai/latest/docs/api/ai)). Nothing in the docs
wires it into the agent loop as context compaction. Conversation memory is a *different* thing
again: `@tanstack/ai-memory` and `memoryMiddleware` with "the recall/save adapter contract."

## 8. Structured output

**The option key is `outputSchema`**, on `chat()` and on `useChat()`. Not `responseFormat` (that
name exists only as the `ResponseFormat` interface and as OpenAI's wire-level
`response_format`). The feature name is **structured outputs**.

> "Structured outputs constrain model responses to match a JSON Schema you control … You wire this
> in once with `outputSchema`."
> — [structured-outputs/overview](https://tanstack.com/ai/latest/docs/structured-outputs/overview)

Accepts any Standard JSON Schema library (Zod 4.2+, ArkType, Valibot) or plain JSON Schema.
Message-part type is `StructuredOutputPart` — the comparison page calls out that it is "preserved
per turn in message history," unlike Vercel's per-call `generateObject()`.

**Events** (both stay `CUSTOM`, and the docs say so explicitly — "They are not fields on
`RUN_FINISHED`"):

| Interface | `name` | `value` |
| --- | --- | --- |
| `StructuredOutputStartEvent` | `structured-output.start` | `{ messageId }` |
| `StructuredOutputCompleteEvent<T>` | `structured-output.complete` | `{ object: T; raw: string; reasoning? }` |

Two execution paths, and the naming matters: **"native combined"** adapters wire `outputSchema`
into the regular `chatStream` and harvest from the final turn (modern OpenAI, Claude 4.5+, Gemini
3.x, Grok 4.x, qualifying OpenRouter models) — on this path the `structuredOutput` middleware
phase does not fire and `onStructuredOutputConfig` is never invoked. Everything else takes the
**"separate finalization"** path via `adapter.structuredOutputStream`. Harness adapters are listed
too: "Claude Code / Codex: Native schema flag on the same harness turn (`--json-schema` /
`--output-schema`)"; "OpenCode / Grok Build / ACP compatible: Same-turn prompt-and-parse."
Streaming types: `StructuredOutputStream`, helper `parsePartialJSON` / `parseWithStandardSchema`.

## 9. Events

**The wire protocol is AG-UI, not a TanStack format.**

> "The events TanStack AI streams between server and client are AG-UI events, imported directly
> from `@ag-ui/core` — not a bespoke format with AG-UI bolted on."
> — [comparison/vercel-ai-sdk](https://tanstack.com/ai/latest/docs/comparison/vercel-ai-sdk)

The union is `StreamChunk`; the default return type of `chat()` is `ChatStream`, defined as
`AsyncIterable<Exclude<StreamChunk, CustomEvent> | KnownCustomEvent>` so `CUSTOM` events narrow on
a plain `if` ([protocol/custom-events](https://tanstack.com/ai/latest/docs/protocol/custom-events)).
"TanStack extras live under `metadata.tanstack`"
([chat/streaming](https://tanstack.com/ai/latest/docs/chat/streaming)) — e.g. `finishReason` is
`metadata.tanstack.finishReason`.

Event families: `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`; `TEXT_MESSAGE_START` / `CONTENT` /
`END`; `TOOL_CALL_START` / `ARGS` / `END` (+ `TOOL_CALL_RESULT`); `REASONING_*` and
`REASONING_ENCRYPTED_VALUE`; `STEP_STARTED` / `STEP_FINISHED` ("`stepName` only"); `MESSAGES_SNAPSHOT`
/ `STATE_SNAPSHOT` / `STATE_DELTA`; `CUSTOM`.

`KnownCustomEvent` members ([protocol/custom-events](https://tanstack.com/ai/latest/docs/protocol/custom-events)):
`sandbox.file`, `sandbox.file.diff`, `file.changed`, `` `${string}.session-id` ``,
`code_mode:execution_started`, `code_mode:console`, `code_mode:external_call` /
`external_result` / `external_error`, `code_mode:snippet_call` / `snippet_result` /
`snippet_error`, `snippet:registered`, `structured-output.start`, `structured-output.complete`,
`approval-requested`, `tool-input-available`, `ui-resource`. App events go through
`emitCustomEvent(name, value)` from the tool execution context and are "intentionally absent" from
`KnownCustomEvent` — read those by annotating the stream as the wider `StreamChunk`.

A caveat the docs state plainly: "SSE and HTTP `TOOL_CALL_END` does not carry parsed `input`.
In-process `chat()` still has `input`."

## 10. Providers and adapters

**"Adapter" is the noun for a provider integration.** Two kinds, and the docs keep them distinct:

- **Provider adapters** — HTTP/SDK integrations, one export per activity per provider:
  `openaiText`, `openaiImage`, `openaiVideo`, `openaiSpeech`, `openaiTranscription`,
  `anthropicText`, `geminiText`, `openaiSummarize`, … "16 official LLM adapters" plus
  **community adapters** (their own docs section) and `openaiCompatible`. Extension points:
  `extendAdapter`, `createModel`, `BaseAdapter`, `AIAdapter` / `AIAdapterConfig`.
- **Harness adapters** — coding-agent CLIs. "A **harness adapter** is the second axis of a
  sandboxed run: it decides _which coding agent runs_ and translates that agent's work back into
  `chat()` stream chunks" ([sandbox/harnesses](https://tanstack.com/ai/latest/docs/sandbox/harnesses)).
  The five: `grokBuildText`, `claudeCodeText`, **`codexText`**, `opencodeText`, and
  `acpCompatible` / `acpCompatibleText`. "Every harness adapter declares
  `requires: [SandboxCapability]`, so `chat()` fails fast at the call site unless a sandbox is
  provided."

**The Codex adapter is `codexText`, package `@tanstack/ai-codex`**, docs page
[adapters/codex](https://tanstack.com/ai/latest/docs/adapters/codex). It "runs OpenAI Codex (via
the `@openai/codex-sdk`)"; "Unlike HTTP provider adapters, this is a **harness adapter**: Codex
runs its own agent loop and executes its own tools." Options: `cwd`, `sandboxMode`
(`'read-only' | 'workspace-write' | 'danger-full-access'`), `approvalPolicy` (default `'never'`),
`modelReasoningEffort`, `skipGitRepoCheck`, `networkAccessEnabled`, `webSearchMode`,
`additionalDirectories`, `authMode`, `apiKey`, `baseUrl`, `codexPathOverride`, `env`, `config`.
Per-call overrides go through `modelOptions`. Session resume is via the `codex.session-id` custom
event threaded back as `modelOptions.sessionId`.

**Auth is its own axis with its own page.** `authMode: 'api-key' | 'host'`; "The provider is where
the agent runs, not how it signs in"
([sandbox/auth](https://tanstack.com/ai/latest/docs/sandbox/auth)).

**MCP is a separate integration surface from adapters.** `@tanstack/ai-mcp` provides
`createMCPClient` / `createMCPClients`, `mcpTool`, `mcpResourceToContentPart`,
`mcpPromptToMessages`; managed mode is `chat({ mcp: { clients, connection } })` where
`connection: 'close'` is the default and `chat()` "discovers the tools and closes the client when
the run ends"; manual mode spreads `await client.tools([toolDefinition(...)])` into `tools` for
full typing. MCP Apps adds `ui://` resource widgets, `UIResourcePart`, `useMcpAppBridge`,
`McpSessionStore`.

## 11. Vocabulary quick-reference

| Concept | TanStack AI's name | Layer |
| --- | --- | --- |
| Agent entry point | `chat()` | activity |
| One conversation / one execution | thread (`threadId`) / run (`runId`) | AG-UI protocol |
| The loop | agentic cycle; iterations = model turns | `chat()` |
| Loop control | `agentLoopStrategy` | `chat()` option |
| Function calling | tools; `toolDefinition().server()/.client()` | `chat()` option |
| Deferred tool schemas | lazy tools / lazy tool discovery | tool flag `lazy` |
| Provisioned agent environment | **skills** (`WorkspaceSkill`) + `plugins` + `instructions` + `secrets` | `defineWorkspace` |
| Handing all of that to the agent | **provisioning** (the activity); **projection** (the mechanism) | `bootstrapWorkspace` + per-harness `projectWorkspace()` |
| MCP server for the in-sandbox agent | `mcpSkill(name, config)` | workspace skill |
| MCP server for your own `chat()` | `chat({ mcp: { clients } })` via `createMCPClient` | `chat()` option |
| Hosted provider bundle | Provider Skills, inside `codeExecutionTool` / `shellTool` | provider tool |
| SKILL.md docs for coding agents | Agent Skills, via TanStack Intent | authoring |
| Named command alias | **scripts** (`Record<string,string>`) | `defineWorkspace` |
| Guardrails | `defineSandboxPolicy` → `allow` / `ask` / `deny`, `default` | `defineSandbox` |
| Credential handle | `SecretRef` via `createSecrets` / `bearer` | workspace |
| Where the agent runs | provider (`localProcessSandbox`, `dockerSandbox`, …) | `defineSandbox` |
| Which agent runs | harness adapter (`codexText`, `claudeCodeText`, …) | `chat({ adapter })` |
| Turning a sandbox on | `withSandbox(definition)` middleware | `chat({ middleware })` |
| Cross-middleware DI | capability (`createCapability`, `requires`/`provides`) | middleware |
| Human pause | interrupt (`tool-approval` / `generic` / `unbound`) | protocol + client |
| Storage | stores (`messages`, `runs`, `interrupts`, …) behind `withPersistence` | middleware + adapter |
| Schema-constrained output | `outputSchema`; `structured-output.start` / `.complete` | `chat()` option |
| Wire events | AG-UI `StreamChunk` / `ChatStream` / `KnownCustomEvent` | protocol |
| Reusable LLM-written code | **snippets** (formerly "skills") | Code Mode |

## 12. The rename that proves the point

Code Mode's persistent library of LLM-written TypeScript was called **skills** and was renamed to
**snippets** in
[TanStack/ai#1114](https://github.com/TanStack/ai/commit/0fb82632) (`0fb82632`, 2026-08-15),
`refactor(code-mode)!: rename Code Mode "skills" to "snippets"`. The commit body states the reason:

> "Disambiguates Code Mode's runtime code library from the agent/provider 'skills' systems (the
> SKILL.md packaging feature). Breaking rename of the package, its public API, and the Code Mode
> wire contract."

Scope: package `@tanstack/ai-code-mode-skills` → `@tanstack/ai-code-mode-snippets`; API
`codeModeWithSkills` → `codeModeWithSnippets`, plus `snippetsToTools`, `snippetsToBindings`,
`selectRelevantSnippets`, `createSnippetManagementTools`, `createSnippetsSystemPrompt`,
`generateSnippetTypes`, `createFile/MemorySnippetStorage`; runtime tools `search_snippets` /
`get_snippet` / `register_snippet`; sandbox binding prefix `snippet_`; wire events
`code_mode:snippet_*` and `snippet:registered`; sandbox hook option `getSkillBindings` →
`getSnippetBindings`. And explicitly: "Agent/provider skills (`packages/*/skills`, `SKILL.md`,
provider skills-wire) are intentionally untouched."

The docs now carry mutual disclaimers in both directions:
[code-mode-with-snippets](https://tanstack.com/ai/latest/docs/code-mode/code-mode-with-snippets)
("**Different from agent-authoring skills.**"),
[agent-skills](https://tanstack.com/ai/latest/docs/getting-started/agent-skills) ("**Looking for
runtime snippets inside Code Mode?**"), and
[provider-skills](https://tanstack.com/ai/latest/docs/tools/provider-skills) ("**Not to be
confused with `@tanstack/ai-code-mode-snippets`**").

**Stale references remain.** The comparison page still says "Code Mode Skills | LLM-writable
persistent skill library" and "an LLM-writable skill library"
([comparison/vercel-ai-sdk](https://tanstack.com/ai/latest/docs/comparison/vercel-ai-sdk)) — three
uses of the retired sense, not yet updated. Do not treat those as current.

**Inference — the lesson for cogwork.** TanStack AI paid a breaking package rename to stop
overloading "skill" across two layers, and still ended up with three live senses (§3). Its answer
was not to invent an umbrella term that covers all of them; it was to *narrow each name* and add
cross-links. If cogwork reaches for a collective noun over tools/skills/scripts, it will be
coining something TanStack AI does not have and has actively declined to coin. Reserve "skill" for
the provisioned-into-the-agent sense, keep "tool" for the `chat()` function-calling sense, keep
"script" for named command aliases, and disambiguate with prose the way TanStack AI does.

## 13. Where the docs are silent

- **No prose on how `scripts` reach the agent.** The `AGENTS.md` `## Workspace scripts` section
  and the `commandAliases` policy expansion are both undocumented; both are read from
  `@tanstack/ai-sandbox@0.3.4` source (§4).
- **`evaluateCommand`, `commandAliases`, `resolveApproval`** are public exports with no docs page.
  `policy.d.ts` calls `evaluateCommand` "Exported for adapter permission mappers and unit tests."
- **`agentSkill` has no working target.** Every mention says it is warned-and-skipped on Claude
  Code and on ACP harnesses; the docs never name a harness where it does work.
  `dist/esm/workspace.d.ts` calls it "Reference a named agent skill the harness should load."
- **No collective type or key** spanning `tools` + `skills` + `scripts` + `plugins` exists in any
  doc or any `.d.ts` read here.
- **The docs never discuss provisioning's git consequence.** Every provisioned artifact is written
  under the workspace root — the same directory as the cloned source checkout — and no page
  mentions `.gitignore`, untracked files, or keeping the checkout clean. The only acknowledgements
  are indirect: portable-snapshot exclusions for the projection marker / `CLAUDE.md` / harness
  skills dirs, and the observability note that "`git diff` ignores untracked files" (§5.4).
- **`projectWorkspace()` has no docs page.** The two-phase bootstrap/projection split, the
  `WorkspaceProjection` interface, and the `.tanstack-projected-<hash>` marker are described only
  in source comments and in one line of the snapshot-exclusions list (§5.3).
- **`WorkspaceProjection.scripts` has no reader.** The field is published to every harness
  projector but no shipped projector read here consumes it (§4).
- **`summarize()` is never connected to context compaction** anywhere in the docs.
- **Docs vs npm drift.** Docs describe `main`; npm `latest` is ahead of both the docs snapshot and
  this repo's installed versions. Re-verify any naming claim against the version cogwork pins.
