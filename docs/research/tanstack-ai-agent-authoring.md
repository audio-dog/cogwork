# Research: TanStack AI 1.0 surfaces for agent-authored Workflows

Resolves [#780](https://github.com/colonylabs/cogwork/issues/780), part of the
[Customizable Workflows map (#656)](https://github.com/colonylabs/cogwork/issues/656).

**Question**: which TanStack AI 1.0 surfaces fit an agent that authors a Workflow inside Cogwork,
and what does each one ask of the Workflow contract? The chat surface itself is not designed here.
The deliverable is the list of demands the Workflow document and the Trigger/action catalog must
meet so that any of these surfaces can drive it later.

**Sources.** All TanStack claims were read on 2026-10-26 from the `TanStack/ai` repository at the
commit the `@tanstack/ai@1.0.0` tag points to, `5651e07e` (released 2026-10-22). Links below use
that commit. The package `skills/*/SKILL.md` files and the `docs/` pages are the primary sources;
where the two differ, the doc page wins because the skill files still carry a `library_version:
'0.42.0'` frontmatter. The installed 0.x skills under
`packages/engine/node_modules/@tanstack/ai/skills/` (`@tanstack/ai@0.53.0`) were read too and are
labelled **0.x** where cited. Cogwork claims cite the file in this repository. Prior Cogwork research
on the same library: [`tanstack-ai-audit.md`](./tanstack-ai-audit.md) (0.42, the first-party runtime
audit) and
[`tanstack-ai-harness-structured-outputs.md`](./tanstack-ai-harness-structured-outputs.md).

Shorthand: `tag:` means
`https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/`.

---

## 1. The answer in one paragraph

The Workflow contract must be a **small, closed, JSON-Schema-able data document** with **stable ids on
every editable node** and a **flat string-key catalog** whose valid keys the engine can enumerate per
workspace. Given that, two 1.0 surfaces drive it now: typed **tool calling** (a closed command set of
edits the engine applies and validates) and **structured outputs** (the whole document, or one
Operation, as one schema-constrained object per turn). **Portable Agent Skills** fit later as the
on-demand carrier of a "how to author a Cogwork Workflow" guide with worked examples; the mandatory
parts belong in Instructions, not a skill. **`@tanstack/ai-mcp`** fits later only as the projection
of the same command set to an external Harness; in the owned runner, plain tools win. **Code Mode**
never fits authoring. **Middleware and persistence** are already wired in the engine and need nothing
new; **locks** are not the right tool for a single-writer desktop document — a revision stamp on the
saved Workflow is. The one 1.0 change that touches the engine today is that `threadId` is required on
every `chat()` call.

## 2. The Workflow contract as it stands

The UI prototype's model and catalog are the only written shape of the document so far.

- A `Workflow` is `{ id, name, enabled, workspaces, triggers, operations }`
  (`apps/desktop/src/renderer/src/features/workflow-model.ts`).
- An `Operation` is `{ id, name, instruction, model, questions, routes, hints }`. A `Question` has
  `choices`; a `Route` is `{ when: Condition, actions: CatalogChoice[] }`; a `Condition` is an **open
  map** `Record<questionId, choiceId>`; `hints` is a **double-keyed open map**
  `Record<choiceKey, Record<inputId, string>>` (same file).
- A catalog entry is addressed by `choiceKey = "${groupId}/${itemId}/${optionName ?? ""}"`, but the
  document stores the **denormalized** `CatalogChoice` (`groupName`, `icon`, `itemName`,
  `agentInputs`) in `triggers` and `routes[].actions`
  (`apps/desktop/src/renderer/src/features/workflow-catalog.ts`).
- Every edit is already a pure function in the `operationEdits` table — `rename`, `instruct`,
  `chooseModel`, `addAction`, `removeAction`, `addRoute`, `removeRoute`, `setHint`,
  `setQuestionText`, `renameChoice`, `addChoice`, `removeChoice`, `addQuestion`, `removeQuestion`
  — plus `uncovered(operation)`, a deterministic check for outcome combinations with no route
  (`workflow-model.ts`).
- An `AgentInput` names the `field` an Operation's structured output must carry for an action
  (`workflow-catalog.ts`); the glossary's **Operation result** is already "the tagged,
  Effect-Schema-defined value an operation returns through the harness stream"
  (`packages/contracts/CONTEXT.md`, "Operation result").

Two of these shapes — the open maps and the denormalized catalog object — are the ones the surfaces
below push back on.

## 3. Per-surface findings

Each surface answers four things: what it is for, what the document and catalog must look like to be
usable through it, what it costs, and whether it fits now, later, or never.

### 3.1 Tool calling with typed inputs

**What it is for.** `toolDefinition({ name, description, inputSchema, outputSchema, needsApproval?,
lazy?, metadata? })` plus `.server(fn)` defines one callable the model can invoke inside the
`chat()` loop; TanStack runs it and feeds the result back to the model
([tag:docs/tools/tools.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/tools/tools.md)).
The input is checked against `inputSchema` right before the tool runs; malformed JSON or a failed
check becomes a **tool error returned to the model**, which can then correct the call. 1.0 also
documents a built-in **repair** step (`"5"` → `5`, `null` for an optional field → absent), which
`repairToolInput: false` turns off
([tag:docs/tools/server-tools-advanced.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/tools/server-tools-advanced.md)).
`inputSchema` accepts any Standard Schema or a plain JSON Schema. The engine already uses this path:
`makeOwnedToolSet` wraps Effect Schemas as `standardSchema(ReadArgs)` for `read`, `write`, `edit`,
`bash`, `glob`, `grep`, `webfetch` (`packages/engine/src/tools/owned-tools.ts`).

Three options that matter for authoring:

- `needsApproval: true` pauses the run; the stream ends with `RUN_FINISHED` carrying an `interrupt`
  outcome, and the next request resumes with `parentRunId` and `resume`
  ([tag:docs/tools/tool-approval.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/tools/tool-approval.md)).
- `lazy: true` sends only the tool's name until the model asks for it through a synthetic discovery
  tool; `lazyToolsConfig.includeDescription` controls how much of the description rides in the
  catalog
  ([tag:docs/tools/lazy-tool-discovery.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/tools/lazy-tool-discovery.md);
  0.x `ai-core/tool-calling` Pattern 4).
- `toolChoice` (`'auto' | 'none' | 'required' | { type: 'tool', name }`) is a server option; a
  middleware `onConfig` on `ctx.iteration === 0` can force one tool first and then release
  ([tag:docs/tools/tools.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/tools/tools.md#choose-when-the-model-calls-a-tool)).

**What the document and catalog must look like.** The `operationEdits` table is already the right
shape for a tool set: one tool per edit, each a pure `(document, args) → document` the **engine**
applies. For that to work through `toolDefinition`:

- Every target must be addressable by a **stable id**: Operation id, Question id, Choice id, and a
  Route key. The prototype mints `operation-1`, `question-2`, `outcome-3` ids (`freshId` in
  `workflow-model.ts`); the engine must own that minting, or constrain model-supplied ids to a slug
  pattern in the schema.
- A catalog reference must be a **string key**, not the denormalized `CatalogChoice`. The input
  schema should enumerate the keys valid for this workspace (`z.enum([...])` / a `Schema.Literals`
  built per request), so the model cannot name an action the workspace does not have. This is the
  same discipline `withSkills` applies to `load_skill`'s `name` (§3.3).
- `Condition` as a tool argument should be an **array of `{ questionId, choiceId }` pairs**, not an
  open-keyed map: strict JSON Schema needs known property names, and the repair step cannot fix a
  wrong key.
- Validation that the engine already has — `uncovered(operation)`, an unknown catalog key, a missing
  hint for an `agentInput` — should return as **data in the tool result**, not as a thrown error.
  TanStack's own design tips say "Errors as data. Return a clear error message instead of throwing"
  ([tag:docs/tools/tool-architecture.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/tools/tool-architecture.md#design-tips)),
  and a result the model sees is a result it can correct. This is **Build the environment, not the
  prompt** (`docs/agents/technical-disposition.md`).

**Cost.** Every eager tool's schema rides in every request; ~15 small edit tools is a few hundred
tokens, well under the point where `lazy` pays. The real cost is **round trips**: one model turn per
edit. A batch tool (`apply_edits(edits[])`) or a whole-document proposal (§3.2) collapses that.
Complexity is low — the engine already builds tool sets this way.

**Fit: now.** The primitive exists at 0.53.0 and the engine uses it. Nothing in 1.0 changes it
beyond the required `threadId` (§4).

### 3.2 Structured outputs

**What it is for.** `chat({ outputSchema })` returns one typed object (no stream) or streams JSON
deltas and ends with a `structured-output.complete` event holding the full object
([tag:docs/structured-outputs/overview.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/structured-outputs/overview.md)).
With `tools` present, the agent loop runs first, then the object is produced; on OpenAI, Anthropic
Claude 4.5+, Gemini 3.x and Grok 4.x this is one combined request, elsewhere a separate final call
([tag:docs/structured-outputs/with-tools.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/structured-outputs/with-tools.md#combined-mode-one-request-for-tools-and-schema)).
In a multi-turn chat each completed run adds a `StructuredOutputPart` to an assistant message; the
next turn sees earlier objects as assistant content, which is how the documented "recipe builder —
now make it vegan" shape works
([tag:docs/structured-outputs/with-tools.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/structured-outputs/with-tools.md#multi-turn-with-tools);
0.x `ai-core/structured-outputs` Pattern 5). A Workflow being refined over several turns is exactly
that shape.

The engine already runs this path: `run-plan.ts` derives a draft-2020-12 JSON Schema from the
Operation's Effect Schema (`stageResultJsonSchema(operation)["~standard"].jsonSchema.input(...)`),
`provider-runner.ts` passes it as `outputSchema`, and `executor.ts` demands exactly one
`structured-output.complete` per Run and decodes `value.object` with Effect. Because the engine
passes a **plain JSON Schema**, TanStack does not validate the object — "The engine does not
validate a plain JSON Schema on either path"
([tag:docs/structured-outputs/overview.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/structured-outputs/overview.md#where-validation-runs))
— so the Effect decode in the executor is the real gate. That is the right place for it.

**What the document and catalog must look like.** This surface is the one that constrains the
document's *shape* most:

- **Strict providers need every field required.** The engine "sends each optional field as required
  and nullable" and undoes it on the way back
  ([tag:docs/structured-outputs/overview.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/structured-outputs/overview.md#optional-fields-come-back-absent)).
  Fewer optionals, fewer surprises.
- **Anthropic compiles the schema into a grammar** and rejects one that is too complex. The documented
  cost drivers are "`.optional()` fields that you do not need", "`.catch()` and `.default()`
  wrappers", "union types and deeply nested objects", and "optional strings with no constraint. Use
  enums or formats where you can"
  ([tag:docs/structured-outputs/overview.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/structured-outputs/overview.md#anthropic-schema-complexity-limits)).
  So: **flat enums for catalog keys, outcomes and labels; no recursive types; shallow nesting; one
  discriminated union at most** (`WorkspaceScope` is fine; a union per node is not).
- **No open-keyed maps.** `Condition` and `hints` as `Record<string, …>` cannot be expressed with
  `additionalProperties: false` and known keys. Arrays of `{ questionId, choiceId }` and
  `{ actionKey, inputId, hint }` can.
- **Catalog by key, enumerated per request.** The output schema for `routes[].actions[]` and
  `triggers[]` should be an enum of the workspace's valid `choiceKey`s. The engine derives
  `groupName`, `icon`, `itemName` and `agentInputs` from the key after decode. The schema is built
  server-side per call, so a per-workspace enum costs nothing extra.
- **One schema source.** Define the Workflow document once in Effect Schema (in `@cogwork/contracts`,
  beside the Operation result schemas), derive JSON Schema for TanStack and decode with Effect, as the
  engine already does for Operation results. A failed decode on the streaming path is a `RUN_ERROR`
  with `code: structured-output-validation-failed` and `metadata.tanstack.rawText`
  ([same page](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/structured-outputs/overview.md#where-validation-runs)),
  so the raw text is there to feed back as a correction turn.
- **The same discipline applies downstream.** At run time an Operation's result schema is *generated
  from the Workflow*: each Question becomes an enum field, each `agentInput.field` a string. A
  Workflow the author can save must therefore also compile to a schema a strict provider accepts.
  That is a property the engine can check deterministically at save time.

**Cost.** Output tokens scale with the document each turn when the whole document is regenerated;
for the prototype's size (a handful of Operations, a dozen routes) that is low thousands of tokens.
Per-Operation proposals cut it further. Latency is one request on combined-mode adapters, two
otherwise. Complexity is low: the engine already has the schema-derive-decode pipeline.

**Fit: now.** It is the engine's existing Operation-result mechanism pointed at a different schema.

### 3.3 `@tanstack/ai-skills` — Portable Agent Skills

**What it is for.** `withSkills(sources, options)` is a `ChatMiddleware` that adds a one-line-per-skill
catalog to the system prompt and a `load_skill` tool whose `name` input "accepts only your skill
names, so the model cannot invent one"; the tool returns the `SKILL.md` body without frontmatter and
a list of bundled resources, and a second load of the same skill in one conversation returns a short
"already loaded" marker
([tag:docs/skills/agent-skills.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/skills/agent-skills.md#how-it-works)).
Options: `maxCatalogTokens` (default 4000), `requireApproval`, `catalogPlacement: 'system' |
'tool-description'`, `renderCatalog` / `instructionTemplate`; Anthropic models get an
`<available_skills>` XML catalog, others markdown
([same page, Advanced](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/skills/agent-skills.md#catalog-options)).
`createResourceTool(source)` adds `read_skill_resource` so the model can read `references/` and
`assets/`; paths that escape the skill root are rejected. Scripts under `scripts/` are **listed, not
run** — "your app runs code through a tool that you supply"
([same page](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/skills/agent-skills.md#run-a-skills-scripts)).
A `SkillSource` is "bytes only": `list()` and `load(name)` required; `revision()`, `listResources`,
`readResource`, `listScripts` optional
([tag:docs/skills/writing-adapters.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/skills/writing-adapters.md)).
Built-in sources: `inlineSkill` (in code, anywhere), `skillDirectory` (`@tanstack/ai-skills/node`,
reads `node:fs`, strict by default), `staticSkills` (build-time bundle through the Vite plugin
`skillsCatalogPlugin`; `.names` becomes a typed union); combinators `aggregate`, `dedupe`, `filter`,
`cache`
([tag:docs/skills/skill-sources.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/skills/skill-sources.md)).
Portable skills and hosted provider skills (`codeExecutionTool` / `shellTool`) do not mix in one
`chat()` call
([tag:packages/ai-skills/skills/ai-skills/SKILL.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai-skills/skills/ai-skills/SKILL.md)).

**Could a "how to author a Cogwork Workflow" skill ship with the app?** Yes, mechanically:
`skillDirectory` pointed at a folder inside the packaged daemon, or `inlineSkill` over a string the
build embeds, or `staticSkills` if the daemon build adopts the Vite plugin. The daemon is Node, so
the `/node` entry point is fine. Three Cogwork rules shape *what* goes in it:

- **Explicit over ambient.** A skill is loaded only if the model decides to call `load_skill`. Anything
  the authoring agent *must* follow — the document's shape, the save protocol, "never invent a catalog
  key" — belongs in Instructions, which the engine supplies unconditionally. The glossary already
  separates the two: an **Operating-instructions package** is "mandatory, last and highest in the
  instruction ladder, and is never a contribution", and "`SKILL.md` is reserved for real Skills"
  (`packages/contracts/CONTEXT.md`, "Operating-instructions package"; ADR 0019).
- **The skill carries depth, not the rule.** Worked examples (two to four complete JSON Workflows),
  the long-form meaning of each catalog item, and the authoring heuristics from
  [`feldspar-workflow-ideas.md`](./feldspar-workflow-ideas.md) §5 (reconcile before create, a
  default route on failure, a cycle cap) are the right `references/` for `read_skill_resource`.
- **The live catalog is not a skill resource.** It differs per workspace (which Connections exist),
  so it is data the engine renders into the schema enum and a short list in Instructions, not a
  static file.

**What the document and catalog must look like.** Only that the document be *documentable*: a
canonical JSON form with examples, and a one-paragraph description per catalog item that can serve as
both the skill's reference text and the tool/enum description.

**Cost.** One catalog line per skill per request (tens of tokens), one extra tool, one round trip
and the body's tokens the first time it is loaded. Low.

**Fit: later.** The package is not in the workspace catalog (`pnpm-workspace.yaml` lists `ai`,
`ai-acp`, `ai-anthropic`, `ai-claude-code`, `ai-codex`, `ai-gemini`, `ai-openai`, `ai-sandbox`,
`ai-sandbox-local-process`, `ai-persistence`), and there is no authoring Operation yet to attach it
to. Nothing about it constrains the contract beyond "write the examples".

### 3.4 `@tanstack/ai-mcp` — Cogwork's commands as MCP tools, versus plain tools

**What it is for.** Two directions. As a **client**, `createMCPClient({ transport })` connects to an
MCP server over Streamable HTTP, SSE or stdio and `client.tools()` returns `ServerTool[]` that spread
into `chat({ tools })` like hand-written tools; args are `unknown` unless you pass
`toolDefinition` instances to `client.tools([defs])`; `toolFilter` and `needsApproval` set policy per
server; `chat({ mcp })` manages discovery and lifecycle
([tag:packages/ai-mcp/skills/ai-mcp/SKILL.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai-mcp/skills/ai-mcp/SKILL.md),
"Three type-safety modes", "Tool policy"). As a **server**, `createMCPServer({ name, version,
tools })` from `@tanstack/ai-mcp/server` serves tools built with `toolDefinition().server()` over
`server.fetch(request)` (HTTP) or `serveMCPStdio(server)`; it speaks spec 2026-07-28 and 2025, is an
OAuth resource server when given `auth`, exposes `metadata.annotations` (`readOnlyHint`,
`destructiveHint`, …) to the host, and supports `requestInput` elicitation
([same file](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai-mcp/skills/ai-mcp/SKILL.md#host-an-mcp-server)).
An in-process `createMCPClient({ server })` exists but "has no `tools()`, so do not pass it to
`chat()`"
([same file](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai-mcp/skills/ai-mcp/SKILL.md#call-a-createmcpserver-server-with-its-types)).

**Versus plain tools.** For the owned runner, an MCP hop between the engine and its own commands buys
nothing: the tool definitions are the same `toolDefinition` objects, typed, with no discovery call,
no transport and no child process. TanStack's own in-process client is explicitly not a `chat()`
tool source. MCP earns its place when the authoring agent is an **external Harness** — Claude Code,
Codex, Cursor — whose loop the engine cannot reach into. That is already the engine's settled shape:
"the engine assembles a run's capabilities (context, MCP skills, credentials); the runner renders
them" (engine ADR 0005, restated in engine ADR 0006), and MCP is the channel through which an external Harness
receives tools. An MCP server built from the *same* `toolDefinition` list the owned runner uses is one
command set with two projections — **The engine assembles; the runner renders**. It also has one
property plain tools lack: it is a **transport-level trust boundary**. A server that exposes only
`read_workflow`, `propose_edit` and `validate`, and no `save`, enforces "the model proposes, the
engine disposes" at the mechanism (**Enforce at the mechanism, not by instructing the agent**).

**What the document and catalog must look like.** The same as §3.1: a closed command set defined once
as `toolDefinition`s with Standard-Schema inputs *and* `outputSchema`s. MCP adds two demands: each
tool should carry `metadata.annotations` (`readOnlyHint: true` on the read tools, so a host skips its
confirmation), and the tool names must be stable and prefix-safe (`createMCPClients` prefixes by
server key, `cogwork_propose_edit`).

**Cost.** A `tools()` discovery round trip per run, args `unknown` on the auto-discovery path, a
transport (and for stdio, a child process per host), and OAuth plumbing when it leaves the machine.
Moderate.

**Fit: later for an external Harness as the authoring agent; not as the owned runner's path.** Plain
tools are the owned-runner projection.

### 3.5 Code Mode (`@tanstack/ai-code-mode`) with a sandbox driver

**What it is for.** `createCodeMode({ driver, tools })` replaces N tool calls with one
`execute_typescript` tool. Each server tool becomes a typed `external_<name>` function; the returned
`systemPrompt` shows the model their TypeScript types; the model writes one program, Code Mode strips
the types and runs it in a fresh isolate; each `external_*` call leaves the sandbox and runs the real
tool on the host
([tag:docs/code-mode/code-mode.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/code-mode/code-mode.md#how-it-works)).
Drivers: Node (`isolated-vm`, native C++ addon, Node 22+, subprocess probe by default because an
incompatible build segfaults), QuickJS (WASM, no native deps, slower), QuickJS Bun, Cloudflare,
Daytona, E2B
([tag:packages/ai-code-mode/skills/ai-code-mode/SKILL.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai-code-mode/skills/ai-code-mode/SKILL.md)).
Defaults: 30 s timeout, 128 MB. The documented win is parallel fan-out — "Code Mode helps most when
the model can `Promise.all` calls that otherwise need separate tool turns". The documented risks:
secrets must never reach the sandbox; always set a finite timeout; "many small or older models get
the calling convention wrong"
([tag:docs/code-mode/code-mode.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/code-mode/code-mode.md#model-compatibility)).

**For authoring.** The authoring task is a conversation that edits a small document through a dozen
commands. There is no fan-out to collapse. The costs are concrete: a native addon or a WASM
interpreter inside the Electron-shipped daemon, type stubs in every prompt, and a dependency on the
model writing correct TypeScript. The shape is also the one the project declines: **Data over code**
(product ADR 0006) prefers "declarative, schema-validated, syncable config to executable config", and the
whole point of the contract is that a Workflow is data. Enforcement would still hold (only
`external_*` calls reach the engine), so this is a cost judgment, not a safety one.

**What the document and catalog must look like.** Nothing specific. If ever used, every tool needs an
`outputSchema`, because the type stubs are generated from it.

**Cost.** High relative to benefit: a sandbox runtime in the daemon, the stubs' tokens, model
sensitivity, a second execution surface to secure.

**Fit: never for authoring.** It may earn a place later inside a read-heavy Operation (scan many
issues, join results) — a different ticket.

### 3.6 Middleware, locks and persistence in a multi-turn authoring conversation

**Middleware.** `ChatMiddleware` hooks: `onConfig` (merge `systemPrompts`, `toolChoice`,
`modelOptions`), `onStart`, `onIteration`, `onShouldContinue`, `onChunk`, `onBeforeToolCall` (return
`{ type: 'skip', result }` to refuse a call), `onAfterToolCall`, `onToolPhaseComplete`, `onUsage`, and
the mutually exclusive terminals `onFinish` / `onAbort` / `onError`
([tag:packages/ai/skills/ai-core/middleware/SKILL.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai/skills/ai-core/middleware/SKILL.md#hooks-reference)).
A tool-call budget is "not a built-in" — the documented pattern is `onBeforeToolCall` skip plus
`onShouldContinue`
([same file](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai/skills/ai-core/middleware/SKILL.md#pattern-tool-call-budget-app-owned)).
The engine already runs two: `cogwork-context` (instructions into `systemPrompts` via `onConfig`) and
`withPersistence` (`packages/engine/src/provider-runner.ts`, `providerMiddleware`). For authoring the
useful additions are small and deterministic: force `read_workflow` on iteration 0 with `toolChoice`,
cap edits per turn, and log each applied edit with its Run id for the ledger.

**Persistence.** `@tanstack/ai-persistence` ships store *contracts* (`MessageStore`, `RunStore`,
`InterruptStore`, `MetadataStore`), the `withPersistence` middleware, an in-memory reference backend
and a conformance testkit; "it does not ship a backend for your database"
([tag:packages/ai-persistence/skills/ai-persistence/SKILL.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai-persistence/skills/ai-persistence/SKILL.md#persistence-is-a-contract-not-a-database)).
Stores key on `threadId`. The **authoritative-history contract**: non-empty `messages` on a request
**overwrites** the stored thread on finish; empty `messages` **loads** it
([same file](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai-persistence/skills/ai-persistence/SKILL.md#authoritative-history-contract)).
The engine implements these stores over the Control store (`packages/engine/src/session-store.ts`,
`interrupt-store.ts`) and loads the thread by `SessionId` before each Run, which is the pattern ADR
0006's amendment chose: "the request references a session, it does not carry history". Completed
structured-output parts "remain on their UI messages and are mirrored into provider-facing assistant
content using `part.raw`" (0.x `ai-core/structured-outputs`, Pattern 5), so each turn's proposed
document is in the thread the next turn reads.

What this means for a conversation that *produces a document*: the thread is the history of
proposals; it is **not** the document's home. **Name the authority; derive the rest**: the saved
Workflow lives in the Control store under its own id, the session is the conversation that produced
it, and a Run that ends with a valid proposal does not by itself save anything. Saving is an engine
act the person confirms, and the confirmation must name the exact revision (**Approval names what it
approves**). The `needsApproval` interrupt is one way to put that confirmation inside the loop;
TanStack persists the pending interrupt and resumes it with `parentRunId` + `resume`, and 1.0 resumes
only *bound* interrupts (§4).

**Locks.** `withLocks(store)` from `@tanstack/ai/locks` provides a `LockStore` capability
(`withLock(key, fn)`) to downstream middleware; `InMemoryLockStore` is "correct within a single
process only", and "`withPersistence` does **not** automatically lock a whole turn"
([tag:packages/ai/skills/ai-core/locks/SKILL.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/packages/ai/skills/ai-core/locks/SKILL.md)).
Locks answer "who may run this critical section right now?" — a multi-instance concern. The daemon is
one process and the writer is one person who may have the UI editor and the chat open on the same
Workflow. That is a **stale-write** problem, not a lock problem: give the Workflow record a revision
(the Run Plan already carries a **provenance stamp** — "a content revision where it does not" have a
version, `packages/contracts/CONTEXT.md`, "Run plan"), have every save name the revision it edits,
and refuse a save whose revision is stale. **Take the shape that survives the turn you can see
coming**: a revision check survives "the daemon goes remote and multi-user"; an in-memory lock does
not.

**Fit: middleware and persistence now (already wired); locks not needed — use a document revision.**

### 3.7 New in 1.0 and adjacent: `@tanstack/ai-harness` sessions and `decide()`

Not in the ticket's list, but both bear on the question and both are new since the 0.42 audit.

**`@tanstack/ai-harness`** (`defineHarness`, `createHarnessHost`, `session.send`) keeps "one
conversation that stays open, takes new messages while it works, and runs other agents from code";
`send(text, { mode: 'steer' })` joins a running turn; `send(text, { outputSchema })` returns the
turn's typed object as `structured`; plugins add tools, prompts, middleware and agents per session;
the `skills()` plugin from `@tanstack/ai-skills/harness` reads `SKILL.md` folders and makes each a
`/<name>` command; the `codeMode()` plugin moves read-only tools into an isolate
([tag:docs/harness/overview.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/harness/overview.md),
[tag:docs/harness/inputs.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/harness/inputs.md#get-a-typed-answer-from-a-turn),
[tag:docs/harness/skills.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/harness/skills.md)).
It is the natural runtime for a multi-turn authoring session. It is also marked **experimental**:
"`@tanstack/ai-harness` and `@tanstack/ai-harness-cli` are on 0.x, and a minor release can change
the API. Pin the exact version you install"
([tag:docs/harness/overview.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/harness/overview.md));
its `package.json` at the 1.0 tag reads `0.1.0`. One detail worth keeping: the `outputSchema` on a
turn is "**server code only**. A schema is code, so clients cannot send it" — the same place Cogwork
puts it. **Fit: later**, once it is 1.x; nothing it needs from the contract differs from §3.1–3.2.

**`decide()`** asks a decision model typed questions — `choice({ options })`, `score({ levels })`,
`boolean()` — over a `state` and returns typed values with no stream
([tag:docs/evaluate/evaluate.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/evaluate/evaluate.md)).
It is not an authoring surface. It matters for **Name the kind**: the prototype's `Question` with
`choices` is what TanStack calls a `choice` with `options`, and the engine's cheap routing decisions
("a routing decision can itself be an Operation", feldspar research §3.2) are what `decide()` is
for. The glossary should check these two names against TanStack before the Workflows terms are
coined.

## 4. What changed 0.x → 1.0 that matters here

Read from the upgrade guide
([tag:docs/migration/v1.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/docs/migration/v1.md))
and the `tanstack-ai-migration` skill
([tag:skills/tanstack-ai-migration/SKILL.md](https://github.com/TanStack/ai/blob/5651e07e3181745984155ad88b65b86b8528844e/skills/tanstack-ai-migration/SKILL.md)),
checked against the engine.

- **The tool, structured-output and middleware APIs did not break.** A diff of the installed 0.53.0
  `ai-core/tool-calling` and `ai-core/structured-outputs` SKILL.md files against the 1.0.0 tag shows
  only `threadId` additions and formatting; both still carry `library_version: '0.42.0'`. The
  migration skill's own summary: "1.0 removes every API that 0.x marked as deprecated. Each one has a
  replacement that already shipped in 0.x." Nothing in §3 depends on a 1.0-only API, except
  `@tanstack/ai-harness`.
- **`threadId` is required on `chat()`**, `summarize()` and the generation functions; "the server does
  not make one for you". The engine passes `threadId: session ?? undefined`
  (`packages/engine/src/provider-runner.ts`). Every Run already has a Session minted before the
  Harness speaks (engine ADR 0002; glossary "Session"), so the fix is to pass the `SessionId`
  unconditionally — which also makes **thread id = Session id** the identity an authoring
  conversation keys on. `conversationId` is gone; the engine never used it.
- **Interrupts.** `pendingInterrupts`, `resumeInterrupts(items)` and `addToolApprovalResponse` are
  removed in favour of bound `interrupts[].resolveInterrupt()`. Saved data: "`@tanstack/ai-persistence`
  resumes only bound interrupts. A record saved before interrupt bindings existed does not resume" —
  pending rows in the engine's interrupt store must be resolved or dropped at upgrade. This is the
  mechanism a save-confirmation step would ride on (§3.6).
- **Usage.** `usage.promptTokens` on Anthropic, Bedrock and Claude Code now includes cache reads and
  writes; code that added them must stop. The engine maps `usage.promptTokens` → `inputTokens`
  (`packages/contracts/src/ag-ui.ts`, `packages/engine/src/executor.ts`) without adding cache counts,
  so the number simply gets larger on those adapters. `durationSeconds` / `unitsBilled` → `billed`;
  the engine reads neither.
- **Events.** `toolName` on `TOOL_CALL_START` → `toolCallName` (the contracts already read
  `toolCallName` with a `name` fallback); adapters no longer emit `STEP_STARTED` / `STEP_FINISHED`
  for reasoning — read `REASONING_*`. The contracts keep `STEP_*` variants; nothing should infer
  thinking from them.
- **Structured outputs, new documentation worth knowing:** JSON-mode fallback (`json_object` plus the
  schema in the system prompt) for OpenRouter and Groq models that reject strict `json_schema` —
  "the model is asked for the shape but is not held to it" — and the built-in tool input repair with
  `repairToolInput` (§3.1). Whether the repair exists at 0.53.0 was not checked.
- **Client-side removals** (`@tanstack/ai-react-ui`, `body` → `forwardedProps`, `useChat` needing
  `threadId`) do not touch the desktop, which talks to the daemon over its own RPC.

## 5. Demands on the Workflow contract

The list the map asked for. Each line names the surface that demands it.

1. **One document, one schema source.** Define the Workflow document in Effect Schema in
   `@cogwork/contracts`, derive JSON Schema for TanStack, decode with Effect in the engine — the
   pipeline `run-plan.ts` / `executor.ts` already run for Operation results. (§3.2)
2. **JSON-Schema-strict shape.** No open-keyed maps (`Condition`, `hints` → arrays of pairs); no
   recursive types; shallow nesting; few optionals; at most one discriminated union; `additionalProperties:
   false` everywhere. Anthropic's grammar compiler is the binding constraint. (§3.2)
3. **Catalog by stable string key, enumerated per workspace.** Store and accept `choiceKey`
   (`group/item/option`), never the denormalized `CatalogChoice`; the schema's enum lists only the keys
   this workspace's Connections make valid; the engine derives names, icons and `agentInputs` from the
   key. (§3.1, §3.2, §3.3)
4. **Stable ids on every editable node** — Workflow, Operation, Question, Choice, Route — minted by
   the engine or constrained to a slug pattern, so an edit tool can address its target. (§3.1, §3.4)
5. **A closed, typed command set, defined once.** The `operationEdits` table as `toolDefinition`s with
   Standard-Schema inputs and `outputSchema`s, plus `read_workflow` and `validate`; the same list
   projects to plain tools (owned runner), to an MCP server with `readOnlyHint` annotations (external
   Harness) and, if ever wanted, to Code Mode bindings. (§3.1, §3.4, §3.5)
6. **Deterministic validation as data.** `uncovered(operation)`, unknown key, missing hint, and
   "compiles to a strict-provider schema" returned in the tool result or as the save refusal, never
   thrown, so the model corrects itself. (§3.1, §3.2)
7. **The model proposes; the engine disposes.** A tool call or a structured object is a proposal.
   Saving is an engine act; the saved Workflow carries a revision; a save names the revision it edits
   and a stale one is refused; the person's confirmation names the exact revision. (§3.6)
8. **Thread = Session.** An authoring conversation is a Session whose `SessionId` is the TanStack
   `threadId`; the thread holds the history of proposals; the Control store holds the Workflow. (§3.6,
   §4)
9. **Documentable with examples.** Two to four complete JSON Workflows and a one-paragraph description
   per catalog item, usable as Instructions, as a skill's `references/`, and as tool/enum
   descriptions. (§3.3)
10. **Downstream schema compiles too.** A saved Workflow generates each Operation's result schema
    (Questions → enums, `agentInputs` → strings); the save-time check includes that the generated
    schema meets demand 2. (§3.2)

## 6. Fit table

| Surface | Fit | Why |
| --- | --- | --- |
| Tool calling with typed inputs | **Now** | Exists at 0.53.0; engine already builds tool sets this way; `operationEdits` is the command set. |
| Structured outputs | **Now** | The engine's Operation-result pipeline pointed at the Workflow schema; multi-turn proposals stay in the thread. |
| `@tanstack/ai-skills` | **Later** | Ship the authoring guide's depth and examples as a skill; mandatory rules stay in Instructions. Package not installed; no authoring Operation yet. |
| `@tanstack/ai-mcp` | **Later**, external Harness only | Same `toolDefinition` list projected over MCP for Claude Code / Codex / Cursor; a transport-level trust boundary. Not the owned runner's path. |
| Code Mode | **Never** for authoring | No fan-out to collapse; sandbox runtime in the daemon; executable shape where the contract wants data. |
| Middleware | **Now** | Already wired; add `toolChoice` forcing and an edit budget when the Operation lands. |
| Persistence | **Now** | Already wired over the Control store; thread is history, not the document's home. |
| Locks | **Not needed** | Single process, single writer; a document revision check is the right mechanism and survives going remote. |
| `@tanstack/ai-harness` sessions | **Later** | The natural multi-turn runtime, but 0.1.0 and marked experimental at the 1.0 tag. |
| `decide()` | **Not an authoring surface** | Relevant to naming (`choice`/`options`) and to cheap routing decisions. |

## 7. Flags for the map

- **Open map → array of pairs** changes the prototype's `Condition`, `conditionKey`, `routeAt` and
  `hints` helpers in `workflow-model.ts`. Cheap now, expensive after a store schema exists.
- **Catalog key, not object, in the document** changes `Workflow.triggers` and `Route.actions`; the
  prototype's `allChoicesIn` / `pickAction` already produce the key, so the UI can derive the display
  object on read.
- **Naming check before the glossary coins Workflows terms**: TanStack's `choice` / `options` versus
  the prototype's `Question` / `Choice`; TanStack's `threadId` versus Cogwork's `SessionId` (the
  glossary already maps the second: "Cogwork sends the Session's `SessionId` as TanStack `threadId`").
- **Revision on the Workflow record** is a store-schema decision the Workflows spec should carry from
  the start; it also serves the UI editor.
- **#781 (upgrade to 1.0)**: pass `threadId` unconditionally in `provider-runner.ts`; resolve or drop
  pending interrupt rows; expect larger `promptTokens` on Anthropic. The authoring work does not
  depend on #781 landing first, because every surface rated "now" exists at 0.53.0.
