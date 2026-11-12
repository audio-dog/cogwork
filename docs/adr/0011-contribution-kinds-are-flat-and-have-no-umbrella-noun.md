# 0011 — Contribution kinds are flat, typed, and have no umbrella noun

- **Status:** accepted
- **Date:** 2026-08-24
- **Amended:** 2026-08-24 — resolution narrows, see [Amendment](#amendment-2026-08-24--resolution-is-per-settings-family-and-merge-by-key-is-retired)
- **Amended:** 2026-08-25 — the Plugin-supplied settings-blob schema governs an empty set, see [Amendment](#amendment-2026-08-25--the-plugin-supplied-settings-blob-schema-governs-an-empty-set)
- **Amended:** 2026-08-26 — `local` splits into three, see [Amendment](#amendment-2026-08-26--local-splits-into-three-one-per-authoring-tree)
- **Amended:** 2026-11-05 — Command is no longer a contribution kind, see [Amendment](#amendment-2026-11-05--commands-are-retired)

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

- **Identity** is `<authority>/<kind>/<localName>`, authority being `plugin:<pluginId>`, `engine`, or `local`. **Authority and Scope are orthogonal** — authority is who authored it and is immutable; scope is where its configuration lives and is not part of the identity. *(Amended — `local` takes a qualifier per Authoring tree: `local:user`, `local:repo`, `local:private`.)*
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
- Whether a Plugin may introduce an external system the Engine has never seen is deliberately unanswered. The manifest's Connection-requirements field permits an auth recipe; whether Plugins may use it is [#172](https://github.com/taylorfsteele/cogwork/issues/172).

Full reasoning: [#132](https://github.com/taylorfsteele/cogwork/issues/132). Research: `docs/research/plugin-and-connector-versioning.md`, `docs/research/harness-config-scopes-and-rules.md`, `docs/research/tanstack-ai-vocabulary.md`.

## Amendment (2026-08-24) — resolution is per settings family, and `merge-by-key` is retired

This ADR declared resolution *per contribution kind* and listed five operators. [#134](https://github.com/taylorfsteele/cogwork/issues/134) enumerated the settings that actually exist and narrowed both claims. See ADR [0013](./0013-two-settings-families-with-different-scope-sets.md).

**The scope set is per settings family, not per kind.** There are two families — a contribution's on / off, and an Operation setting — and they take different Scopes. Within the first family the set narrows once more, for Hooks and MCP servers only: a repository may ship the file but may never enable it. Nothing else varies by kind.

**Five operators become four.** `merge-by-key` is retired. It existed to answer how entries sharing a key combine across Scopes, and that question dissolved: identity carries Authority, so two contributions sharing a local name are two different things, and composing the set across Scopes is a `union-values` with nothing to reconcile. A single identity with settings at more than one Scope resolves whole, by `override-scalar` — a configuration assembled field-wise from two files is one no person authored. The remaining operators are `override-scalar`, `append-sources`, `union-values`, `constrain`.

This does not change the two lists, the identity scheme, the file-pointing manifest, or the provenance rule. It narrows how their settings resolve.

## Amendment (2026-08-25) — the Plugin-supplied settings-blob schema governs an empty set

This ADR declared schemas layered: the Engine owns a per-kind envelope and validates it always, and
the Plugin supplies a JSON Schema for its own settings blob, validated at Run Plan resolution.

[#134](https://github.com/taylorfsteele/cogwork/issues/134) then enumerated every setting a person can
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

## Amendment (2026-08-25) — a Plugin may require a Connection, and may never define one

This ADR left open whether a Plugin may introduce an external system the Engine has never seen, and
kept the manifest's Connection-requirements field unused so the door stayed unbolted.

[#172](https://github.com/taylorfsteele/cogwork/issues/172) answers it. **A Plugin may require a
Connection by id from the Engine's known set, and may never define one.** The auth-recipe the field
permits has no caller while every Plugin is first-party, and the capability it would add — the Engine
performing an OAuth exchange against endpoints a bundle named — is a materially different act from
the env-var name a Plugin's MCP server uses today. The field stays present and unused on this ADR's
own reasoning; the *rule* is what is decided, and it holds either way.

The same ticket confirms that Connections are engine-owned, as this ADR's rejected-options section
already claimed, and derives which Plugin requires a given Connection from this very field rather
than adding another. See ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md).

## Amendment (2026-08-26) — `local` splits into three, one per Authoring tree

This ADR fixed identity as `<authority>/<kind>/<localName>`, with authority being `plugin:<pluginId>`,
`engine`, or `local`, and declared **Authority and Scope orthogonal**.

[#204](https://github.com/taylorfsteele/cogwork/issues/204) found that `local` cannot carry the one
distinction the trust model turns on. ADR
[0018](./0018-contribution-files-live-in-three-authoring-trees.md) gave a person three **Authoring
trees** and made presence enablement for four of the six kinds. A file in any tree is `local`, so two
files of one kind sharing a local name across two trees resolve to **one identity** — and an
effective on / off is per identity. One switch therefore governs the MCP server you wrote and the one
a cloned repository shipped. That is the precise act ADR
[0013](./0013-two-settings-families-with-different-scope-sets.md)'s scope set exists to refuse.

**`local` takes a qualifier, exactly as `plugin` already does.** Three values, one per Authoring tree:

| Authority | Authoring tree |
|---|---|
| `local:user` | `~/.agents/` |
| `local:repo` | `<repo>/.agents/` |
| `local:private` | `~/.cogwork/workspaces/<WorkspaceId>/` |

`engine` stays bare and `plugin:<pluginId>` is untouched. The id scheme grows no new shape, and
anything asking *is this a file a person put here* stays a `local:` prefix test rather than a
three-way match.

**Orthogonality is narrowed, not dropped.** Authority names where the bytes came from; Scope names
where the setting lives. The failure this ADR guarded against — an id changing when its configuration
moves — does not arise: a repo-tree MCP server is `local:repo` whether its switch sits at the Settings
profile or the Private workspace overlay, and the four kinds with no setting have nothing that could
move. The qualifiers deliberately do **not** repeat the Scope names, which is why `local:repo` is not
`local:workspace-input`.

**Prior art, with its strength recorded.** Codex answers this same question twice, and its dividing
line is ours.

- For **Skills**, which carry no switch, the origin *is* part of the identity. Every skill holds its
  `scope` beside its `plugin_id` (`app-server-protocol/src/protocol/v2/plugin.rs:413`, enum
  `SkillScope { User, Repo, System, Admin }`); dedup keys on `{scope}:{path}:{name}` and never the
  name alone (`core/src/skills.rs:104-113`); roots dedup by path only
  (`ext/skills/src/host_roots.rs:271`). Two same-named skills at `User` and `Repo` both survive and
  both reach the model, sorted `Repo` first (`ext/skills/src/loader/host_merge.rs:244-268`). `User`
  is literally `~/.agents/skills` and `Repo` is `<dir>/.agents/skills`, the same two trees under the
  same two words. This is a **convergence**, and it is where `user` and `repo` come from.
- For **MCP servers**, which do carry a per-server `enabled` (`config/src/mcp_types.rs:193`), the
  origin is *not* in the key: they sit in a `BTreeMap` keyed by bare name, and a project layer sits
  above user config, filtered only by the twelve-key `PROJECT_LOCAL_CONFIG_DENYLIST`
  (`config/src/loader/mod.rs:71-84`) that `mcp_servers` is not on — so a project's
  `mcp_servers.github` overrides yours whole, `enabled` included.
  What protects that is one coarse gate — project layers are "loaded but disabled when the directory
  is untrusted" (`config/src/loader/mod.rs:114-116`). This is a **deliberate divergence**: ADR 0013
  chose a per-contribution switch over a per-directory trust gate, so Cogwork cannot also inherit
  Codex's bare-name key. A per-contribution switch with the origin outside the identity is the one
  combination that is neither Codex's design nor ours, and it is the combination where the switch
  misfires.

Codex has no third qualifier because it has no third tree; its other two scopes are a system cache
and an admin config file. `private` is named here, not borrowed.

### Considered Options

- **Two values — `local` and `local:repo`.** Rejected. It fixes the dangerous clash (your file versus
  the repository's) and leaves the quiet one (your global file versus your private per-workspace
  file), which is the same defect at lower cost. It also needs the rule *the id says whether the
  repository put it there* — a grouping over trees somebody must keep correct — where three values
  need only *the id names the tree*. **Name the authority; derive the rest** prefers the key derived
  from the immutable location.
- **Leave `local` alone and let the Authoring tree carry it outside the identity.** Rejected: the tree
  is already a load-time observation and already rendered on the Customize row, and that is exactly
  what makes the gap visible — the surface tells a person something the identity denies. A settings
  key keyed on a colliding identity still misfires.
- **Rely on `register` as Codex relies on directory trust.** Rejected: `register` admits a
  workspace for orchestration, and ADR 0013 deliberately chose the stronger promise that a repository
  may offer and only the principal may enable. Reaching for a coarse gate here would retract that.
- **Naming the qualifiers after their Scopes** — `local:workspace` for the Workspace input tree.
  Rejected: **Workspace input**'s own _Avoid_ line already guards against confusing it with the
  Private workspace overlay, so the name would walk into a collision the glossary is policing.
- **Renaming the `Private workspace overlay` Scope**, whose head noun describes a merge mechanism
  rather than a place. Raised and deliberately deferred — the qualifier `private` needs no rename to
  read correctly, and the Scope name reaches 33 places across eight documents.

### Consequences

- **ADR 0013's offer-versus-enable promise becomes mechanical rather than stated.** A repo-shipped
  MCP server is `local:repo` and gets its own switch, at the Settings profile Scope. The row it owes
  Customize — *this repository offers this. It is off. You can turn it on* — is now produced by the
  identity and the Authoring tree together.
- **The `ambiguous` conflict class stops fighting ADR 0018.** Two trees holding one local name were
  both "the same `<authority>/<kind>/<localName>`" (ambiguous, a load-time diagnostic) and permitted
  to coexist. They are now two identities, so ADR 0018 needs no amendment and its "Cogwork reconciles
  nothing" is correct as written. `ambiguous` narrows to a genuine duplicate — two install records
  under one `pluginId`.
- **This ADR's own `union-values` reasoning becomes true for `local`.** "Identity carries Authority,
  so two contributions sharing a local name are two different things" held for `plugin:` and failed
  for `local`; it now holds everywhere.
- The four kinds with no setting gain honest Run Plan provenance: a resolution trace can name which
  tree produced which instruction.
- Nothing is implemented — `authority` appears nowhere in `packages/*/src` — so this is a glossary
  and ADR change with no migration.

Full reasoning: [#204](https://github.com/taylorfsteele/cogwork/issues/204).

## Amendment (2026-11-05) — Commands are retired

ADR [0037](./0037-commands-are-retired-and-subagent-files-follow-the-claude-code-shape.md) removes
**Command** from both lists. The contribution kinds are **MCP server, Skill, Subagent, Rules, Hook**,
and the Run Plan has no Commands member. Cogwork does not read `commands/` files.
