# 0011 — Contribution kinds are flat, typed, and have no umbrella noun

- **Status:** accepted
- **Date:** 2026-08-24
- **Amended:** 2026-08-24 — resolution narrows, see [Amendment](#amendment-2026-08-24--resolution-is-per-settings-family-and-merge-by-key-is-retired)
- **Amended:** 2026-08-25 — the Plugin-supplied settings-blob schema governs an empty set, see [Amendment](#amendment-2026-08-25--the-plugin-supplied-settings-blob-schema-governs-an-empty-set)

## Context

Cogwork needed one model for the things a user installs and tunes: Skills, rule sources, MCP servers, Subagents, Commands, Hooks. The planning ticket asked for a "capability taxonomy" — one list, one collective noun, one schema.

Writing that list kept failing, and always the same way. Rules belong in what a Plugin ships, but a Run never receives "Rules" — it receives Instructions that Rules resolved into. Tools are in every Run Plan, but nobody authors one; they arrive engine-owned, provider-native, or exposed by an MCP server. Forcing both into one list produced an umbrella term that existed only to make the list possible.

Prior art said the umbrella was the mistake. TanStack AI — the standing naming reference — has no collective noun: `tools`, `skills`, `plugins`, `scripts`, `instructions`, and `secrets` are sibling keys, never rolled up, and its docs repeatedly split rather than merge. It has also already paid a breaking change to *stop* overloading one of these words, renaming Code Mode's "skills" to "snippets" to disambiguate from the agent and provider skill systems. And "capability" was not even available: TanStack AI spends it three times over, on `createCapability()` middleware injection and on `policy.capabilities`.

Research across Claude Code, the MCP Registry, OpenAI, Cursor, and VS Code also found that **no platform versions the capabilities inside a bundle** — the field does not exist anywhere — and that where a bundle version is optional, identity is still mandatory and derived by content addressing.

## Decision

**There are two lists, and no umbrella noun over either.**

**Contribution kinds** — what a Plugin bundles and Customize shows: **MCP server, Skill, Subagent, Rules, Command, Hook**. The test: *a contribution kind is authored by a human as a file, and renders as a row in Customize.*

**Run Plan members** — what the Engine resolves and hands a Harness: Harness Adapter, Instructions, Tools, Skills, MCP, Subagents, Commands, Hooks, Middleware, Sandbox (Workspace and Policy), Structured Output, Persistence, Connections, Provenance. Named after TanStack AI.

The lists differ, deliberately. Rules is a kind that resolves into Instructions. Tools, Connections, and Middleware are members that are never contributed. **"Capability" is retired**; name the kind.

Supporting decisions:

- **Identity** is `<authority>/<kind>/<localName>`, authority being `plugin:<pluginId>`, `engine`, or `local`. **Authority and Scope are orthogonal** — authority is who authored it and is immutable; scope is where its configuration lives and is not part of the identity.
- **Resolution** is declared as a triple of *(scope set, operator, direction)*. The scope set narrows for a trust reason: a cloned repository must not be able to enable executable behavior on your machine. *(Amended — the scope set is per settings family, not per kind.)*
- **Schemas are layered.** The Engine owns a per-kind envelope and validates it always; the Plugin supplies a JSON Schema for its own settings blob.
- **`version` is optional; a provenance stamp is mandatory** — declared version, or content revision. No contribution carries its own version.
- **The manifest points at files.** Nothing is inlined.
- **The Operation Definition declares needs; Operation Settings bind them; a Plugin only offers** and can never mark itself required for an Operation it does not own.
- **MCP is not nested under Skills**, despite TanStack AI modelling `mcpSkill` as a kind of `WorkspaceSkill`.

## Considered Options

- **One list with an umbrella noun ("capability").** Rejected: it only worked by pretending Rules and Tools are the same kind of thing, and the word collides three ways inside TanStack AI.
- **Nest MCP under Skills, matching TanStack AI exactly.** Rejected — but only at the domain layer. The Run Plan is the Engine-validated resolution; TanStack's `skills` bag is one Harness's projection surface, so the nesting is real and belongs to the renderer, per ADR 0005's assemble/render split. Rendering maps our MCP servers onto `mcpSkill` and our Skills onto `agentSkill`. Nesting in the domain too would undo the independent typing that different config schemas and different readiness rules require, for a match we get anyway at the seam. The retired term "MCP skill" is not revived.
- **Keep Middleware and Connection setup as contribution kinds** (as the manifest list originally had them). Rejected by the file-and-a-row test: neither has an authoring format or a Customize row. Middleware is engine-owned by its own definition — a Plugin-shipped one would run code inside the model loop, crossing ADR 0006's data-not-code line. Connections are engine-owned because Cogwork authenticates systems that are not MCP servers; what a Plugin declares is a *requirement*, a manifest field.
- **Per-contribution versioning.** Rejected: no platform in the field does it, and an unused version field rots.
- **Inline definitions in the manifest.** Rejected: every tool in the ecosystem points at files, and ADR 0006's concern was executable-versus-data, which a markdown or JSON file already satisfies. Inlining would have cost a second provenance path for nothing.
- **Uniform resolution across kinds.** Rejected on evidence: Codex reads skill and hook enablement only from user-level layers and strips twelve security-sensitive keys from project layers. There is also no convention to inherit — Codex replaces lists but merges MCP servers field-by-field, while Claude Code unions lists but replaces an MCP server entry whole.

## Consequences

- Adding a contribution kind means adding a row to both lists deliberately, or explaining why it appears on only one. The file-and-a-row test makes that checkable against the Customize surface rather than arguable.
- The retired umbrella means prose must name kinds explicitly. That is more words and less ambiguity.
- `Script` is retired without replacement. Its job — giving Sandbox Policy a stable name instead of a raw command string — returns when Cogwork owns the policy layer.
- Rules adopt a markdown-plus-frontmatter shape borrowed from Cursor and Claude Code, which arrived at it independently. This is **not** standards compliance and must not be documented as such: `AGENTS.md` specifies a filename and closest-wins and nothing else, and every applicability control in the field is vendor-private.
- Whether a Plugin may introduce an external system the Engine has never seen is deliberately unanswered. The manifest's Connection-requirements field permits an auth recipe; whether Plugins may use it is [#172](https://github.com/colonylabs/cogwork/issues/172).

Full reasoning: [#132](https://github.com/colonylabs/cogwork/issues/132). Research: `docs/research/plugin-and-connector-versioning.md`, `docs/research/harness-config-scopes-and-rules.md`, `docs/research/tanstack-ai-vocabulary.md`.

## Amendment (2026-08-24) — resolution is per settings family, and `merge-by-key` is retired

This ADR declared resolution *per contribution kind* and listed five operators. [#134](https://github.com/colonylabs/cogwork/issues/134) enumerated the settings that actually exist and narrowed both claims. See ADR [0013](./0013-two-settings-families-with-different-scope-sets.md).

**The scope set is per settings family, not per kind.** There are two families — a contribution's on / off, and an Operation setting — and they take different Scopes. Within the first family the set narrows once more, for Hooks and MCP servers only: a repository may ship the file but may never enable it. Nothing else varies by kind.

**Five operators become four.** `merge-by-key` is retired. It existed to answer how entries sharing a key combine across Scopes, and that question dissolved: identity carries Authority, so two contributions sharing a local name are two different things, and composing the set across Scopes is a `union-values` with nothing to reconcile. A single identity with settings at more than one Scope resolves whole, by `override-scalar` — a configuration assembled field-wise from two files is one no person authored. The remaining operators are `override-scalar`, `append-sources`, `union-values`, `constrain`.

This does not change the two lists, the identity scheme, the file-pointing manifest, or the provenance rule. It narrows how their settings resolve.

## Amendment (2026-08-25) — the Plugin-supplied settings-blob schema governs an empty set

This ADR declared schemas layered: the Engine owns a per-kind envelope and validates it always, and
the Plugin supplies a JSON Schema for its own settings blob, validated at Run Plan resolution.

[#134](https://github.com/colonylabs/cogwork/issues/134) then enumerated every setting a person can
write and found five of six kinds have exactly one — on / off — and the sixth has one setting and a
file. On / off is the Engine's envelope. **So the Plugin-supplied blob currently governs an empty
set:** there is nothing written against it for a schema change to break, and there is no per-Plugin
parameter step at setup, because a parameter would be that set's first member.

The field stays, unused, on the same reasoning that keeps the Connection-requirements field: an
unused optional field leaves a door unbolted at no cost. Two things change if it ever fills.

**Validation moves to install and update.** ADR
[0013](./0013-two-settings-families-with-different-scope-sets.md) assigns a conflict class by *when
the failure is knowable*, and notes that only *unsatisfiable* depends on the selected Operation. A
settings blob failing its schema is knowable with the manifest in hand, so it is a load-time
diagnostic — not a Run Plan rejection, where this ADR originally put it.

**The first parameter arrives as a setup step.** ADR
[0014](./0014-plugin-install-is-machine-local-and-the-only-plugin-level-state.md) says setup is
establishing required Connections and nothing else. That holds only while the blob is empty.

This changes nothing about the two lists, the identity scheme, the file-pointing manifest, or the
provenance rule.
