# Contracts glossary: Harness contract

Part of the [contracts glossary](./GLOSSARY.md).

**Harness**:
A coding agent (Cursor, Claude Code, …) the control plane drives to do work in a checkout, identified by a branded `HarnessName`. A harness bundles its own model access and tools.
_Avoid_: Model, provider, target (that word belongs to sync)

**Harness-owned authentication**:
The credentials an external CLI harness owns and resolves from its host installation, such as a Codex CLI `codex login`. Cogwork selects and launches the harness but does not copy, store, refresh, or fall back from those credentials.
_Avoid_: Provider key, Cogwork login, harness fallback

**Harness option catalog**:
The controlled model and option choices one Harness offers: checked-in managed data shipped by that Harness's package, never a runtime observation (ADR 0024). Generated catalogs record the CLI version they were generated against; manually managed catalogs need no invented generator version. Provenance has one value, `managed`. An unsupported option is absent, and a saved choice missing from the current catalog is stale rather than free-form input.
Composite native model ids also publish their normalized selections as the validity oracle for clients that must disable sparse option combinations.
Clients read every registered Harness's catalog through `GetHarnessCatalogs`. That query reads managed data only and never waits on Harness readiness.
_Avoid_: Model catalog, settings, arbitrary option, probed catalog

**Option descriptor**:
The declaration on one catalog model of one selectable axis: a select with its permitted values, or a boolean. Descriptors are what clients render and what validation checks; a model with no descriptors is opaque and offers only itself.
_Avoid_: Setting (that is the saved choice), flag, capability

**Canonical option id**:
The shared name for an option axis more than one Harness has: `effort`, `speed`, `context`. Only the axis name unifies — each catalog keeps its own native value list. A Harness-specific axis keeps its own id.
_Avoid_: reasoningEffort, fastMode, per-Harness synonyms for a shared axis

**Model options**:
The saved option selections (`id` → value pairs) of one Operation, stored and cleared atomically with its model: options mean nothing apart from the model they modify. Each Harness translates them to its native form at dispatch. Replaces the retired standalone effort setting.
_Avoid_: Effort setting (retired), model suffix, traits (the desktop menu, not the data)

**Model level**:
The named capability a role or operation asks of its model — `light`, `standard`, or `deep` — instead of a vendor model name. `light` is the cheapest capable model on whatever Harness runs it; `standard` is the Run's own model or the tool's default, rendered as omission where the tool inherits by omitting; `deep` is the reasoning escalation, named and unused. The level is the only model vocabulary a role definition or instruction may use; the mapping to a Harness-native value lives with whoever projects the role (the sync toolkit today, whose tier of the same three words this names, the Harness adapter once Subagents project). See ADR 0028.
_Avoid_: Tier (sync's word for its rendering mechanism), pinned model, vendor alias (`sonnet`, `haiku` — those are one Harness's native values), `fast` / `default` / `powerful` (sync's retired tier names), level (bare — that word belongs to where an Operation setting is written)

**Harness readiness**:
An observation of one Harness's installation, compatible version, and selected authentication binding on the current Runtime host. It can block a Run when negative but never guarantees that a later launch will succeed, and it never selects a fallback Harness or authentication mode.
`GetHarnessReadiness` reads the daemon's cached observations. Probe completion publishes the replacement cache through `HarnessesChanged`; neither read path runs a probe.
_Avoid_: Health check, launch guarantee, availability fallback

**Harness state**:
The single conclusion **Harness readiness** folds to for a person: ready, not installed, unsupported version, not signed in, unavailable, or unknown. The engine folds it once, so every client shows the same answer instead of re-deriving one from the four observed axes. Its `NotSignedIn` case carries the **Harness sign-in** command when the Harness declares one.
_Avoid_: Status, health, readiness (that is the observation this folds)

**Harness sign-in**:
The one command that establishes a Harness's own login — `codex login`, `claude auth login` — declared by the adapter that owns that Harness. Cogwork never runs it and never stores what it produces: the credential is **harness-owned**, so this is something a person is shown, not something the product does. Absent for a Harness that verifies its login during the native launch instead.
_Avoid_: Login flow, credential prompt, authenticate action

**Harness preflight**:
The authoritative per-Run check that one registered Harness can execute the accepted Run Plan with its selected catalog values, authentication binding, policy, Workspace projection, required MCP servers, and Sandbox provider. It validates the Plan as frozen and never re-resolves settings.
_Avoid_: Readiness, Run Plan resolution, fallback

**Harness capability profile**:
The runner-declared facts that let clients and preflight describe intentional native inequalities without guessing from a Harness name. They cover authentication bindings, Session affinity, option and structured-output support, policy fidelity, usage quality, readiness diagnostics, journal and takeover support, and file-event fidelity. File events are `terminal-only`, `best-effort`, or `absent`; the label reports delivery quality, not whether a Run changed files.
_Avoid_: Feature flag, fallback policy, durability activation

**Harness execution boundary**:
The sandbox, approval mode, and native tools an external CLI harness enforces inside its agent loop. Cogwork chooses that boundary when it launches the harness, but its owned-tool policy cannot intercept native shell or file operations inside Cursor or Codex. An unattended harness must use a non-interactive approval mode and remain bounded to its worktree; full host access is not an unattended default.
_Avoid_: Owned tool policy, provider sandbox, fallback

**Harness request**:
The projection of an accepted Run Plan handed to one Harness: checkout path, work request, model and effort, Session reference, Instructions, Tools, Skills, MCP, and other supported fields. Secret material rides a channel that is never persisted or logged, not a plain field.
_Avoid_: Run plan (the complete engine-owned input), prompt, job

**Operation result**:
The tagged, Effect-Schema-defined value an operation returns through the harness stream. For a Workflow Operation the engine derives the schema from the published Operation, with no unions and no optional fields: a summary, the `stuck` flag, and one element — or, for a **fan-out**, a list of elements — each holding its answers, its agent inputs, and, when an action takes its Workspace from the agent (see **Question**), a Workspace. One engine module accepts the result from the final `structured-output.complete` Harness event, or gives a **Refused result**.
_Avoid_: Footer, sentinel, disposition line, text protocol

**Operating-instructions package**:
The Operation-owned instruction document and supporting resources carrying its mandatory Operating Instructions. It is supplied explicitly to every Harness through an instruction-specific content and resource path; `SKILL.md` is reserved for real Skills. The engine ships the default packages, an Operation in a Workflow document names one by name, and a Workspace may replace it whole with an operator-authored package in its private overlay tree (`~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/`); a replacement that is present but has no readable, non-empty `INSTRUCTIONS.md` fails the Run rather than falling back. Either source stays mandatory, last and highest in the instruction ladder, and is never a contribution (ADR 0019).
_Avoid_: Skill, `SKILL.md`, playbook skill, MCP server

**Harness event**:
The whole AG-UI event a harness run streams, carried inside a stable envelope rather than curated down to a fixed set of fields. A handful of fields are named because our folds and clients read them (text delta, tool call id/name, result, session id, usage, finish reason); every other key the harness emits — tool-call input, reasoning deltas, correlation ids, per-turn cost, and AG-UI fields we don't name yet — rides along instead of being dropped at decode. The engine persists these as run events and republishes them as run activity. Supported external file changes use the shared `sandbox.file.diff` custom event before persistence, so owned and external Runs feed the same client contract. The provider runner emits AG-UI natively; cursor-acp maps its ACP stream best-effort.
_Avoid_: Message, token, curated event (the point is that it is not curated)

**Correlation ids**:
The stable ids a client uses to thread streamed deltas back into one message or one tool call — `threadId`, `messageId`, `toolCallId` — lifted out of the harness event into the run-activity envelope so a consumer can group activity without re-parsing the whole payload. Distinct from our `RunId`, which identifies the local execution, not a span inside it.
_Avoid_: Run id (that's the execution), message id alone (there are several)
