# Harness config scopes, merge semantics, and the state of "rules" standards

Date: 2026-08-24.

**Scope and method.** Two questions, answered against primary sources only:

1. How does OpenAI Codex CLI layer configuration, and is the merge rule uniform across keys?
2. Is there a genuinely open standard for writing agent "rules"?

Everything about Codex, opencode, and t3code comes from the vendored checkouts under `.repos/` read
directly on disk — `.repos/codex` at `eb15245d` (2026-08-24), `.repos/opencode` at `ceb4890c`
(2026-07-30), `.repos/t3code` at `1e59b4c4` (2026-08-12). Everything about Claude Code, Cursor, and the
AGENTS.md convention comes from the vendors' own docs, linked inline. Code citations are
`path:line`. Where the code and the vendor's own documentation disagree, both are given and the
divergence is called out. Inference is marked **(inference)**.

---

## TL;DR

**Q1 — the hypothesis is directionally right but understates the problem.** The hypothesis was: *the
same set of scopes is available to every capability type, but the merge rule differs per type.* In
Codex, the second half is confirmed emphatically; the first half is **false**.

- Codex has **one precedence ladder of nine layer kinds** (`config/src/config_layer_source.rs:33`),
  and **one default merge**: a recursive TOML merge where tables merge key-by-key and *everything
  else, arrays included, replaces wholesale* (`config/src/merge.rs:94`).
- But five capability types **bypass that merge**, and three of them **cannot see the full scope
  set**:
  - `skills.config` and `hooks.state` are read only from **User and SessionFlags** layers, ignoring
    system, project, and managed layers entirely (`config/src/skills_config.rs:150`,
    `hooks/src/config_rules.rs:24`).
  - `hooks` event groups and `.rules` exec-policy files are read **per layer and appended**, never
    merged (`hooks/src/engine/discovery.rs:384`, `core/src/exec_policy.rs:647`).
  - Project layers are **stripped of twelve security-sensitive keys** before merging
    (`config/src/loader/mod.rs:71`).
  - Admin policy lives in a **second, separately-composed stack** (`requirements.toml`) that
    *constrains* the merged config rather than overriding it, with its own per-field union rules
    (`config/src/requirements_layers/stack.rs:1`).
  - Instruction files (`AGENTS.md`) are **not in the config system at all** — separate discovery,
    concatenation, byte budget (`core/src/agents_md.rs:1`).
- So the accurate model is **four lanes, not one**: *override-merge* (most keys), *append/union*
  (hooks, exec rules, instructions), *restricted-scope accumulate* (skills/hook enable toggles), and
  *constrain* (requirements). Scope availability is a per-lane property, not a global one.
- **opencode** reaches the same conclusions by hand-written special cases instead of a merge engine:
  `instructions` is the *one* array field explicitly unioned (`packages/opencode/src/config/config.ts:45`),
  and `experimental.policies` are deliberately loaded in **reverse precedence** so a user-global rule
  outranks a repo rule (`packages/core/src/config.ts:204`) — the opposite direction from every other
  key.
- **t3code** does not have a layered config system for agent capabilities at all. It is a GUI over
  other CLIs: a three-source scalar fallback for its own settings
  (`packages/shared/src/threadEnvMode.ts:12`), *explicit user import* rather than merge for
  repo-declared scripts, and it injects itself into the underlying harnesses through their
  highest-precedence scope (`-c mcp_servers.t3-code.url=…` for Codex, the SDK `mcpServers` option
  for Claude Code).

**Q2 — no, there is no open standard for rules; there is an open standard for one *file*.**
AGENTS.md is a real convergence point, and it is genuinely narrow: it fixes a filename and a
"nearest file wins / nested files combine" discovery story, and specifies **no frontmatter, no glob
scoping, no activation control, and no relationship to user-global or org-managed instruction
files** (<https://agents.md/>). Every applicability control that anyone actually wants —
`alwaysApply`, `globs`, description-triggered activation, path-scoped loading — is vendor-private:
Cursor `.mdc` frontmatter, Claude Code `.claude/rules/*.md` with `paths:`. Codex and opencode
implement *no* applicability metadata for instructions whatsoever. Adopting "the standard" today
buys you file discovery and nothing else.

---

# Question 1 — configuration scopes and merge semantics

## 1. Codex: the scope ladder

Codex assigns every configuration source an integer precedence; higher wins. The enum and its
scores are the authoritative statement (`.repos/codex/codex-rs/config/src/config_layer_source.rs:33-51`):

| Precedence | `ConfigLayerSource` | Where it comes from |
|---|---|---|
| −10 | `PackagedDefaults` | `defaults.toml` embedded in the binary, or an override path (`config/src/loader/mod.rs:165`) |
| 0 | `Mdm` | macOS managed preferences |
| 10 | `System` | `/etc/codex/config.toml`, or `%ProgramData%\OpenAI\Codex\config.toml` (`config/src/loader/mod.rs:61`) |
| 15 | `EnterpriseManaged` | cloud config bundle fragments |
| 20 | `User` | `$CODEX_HOME/config.toml` |
| 21 | `User { profile: Some(_) }` | `$CODEX_HOME/<name>.config.toml`, selected by `--profile` |
| 25 | `Project` | each `.codex/config.toml` from project root down to cwd |
| 30 | `SessionFlags` | `-c key=value` / `--config` CLI overrides |
| 40 | `LegacyManagedConfigTomlFromFile` | `managed_config.toml` (being phased out) |
| 50 | `LegacyManagedConfigTomlFromMdm` | MDM-delivered `managed_config.toml` (being phased out) |

The loader's own doc comment restates this in prose and adds the sub-structure of the project tier
(`config/src/loader/mod.rs:105-119`):

> - package: optional default configuration supplied with the Codex package
> - admin: managed preferences (\*)
> - system `/etc/codex/config.toml` …
> - cloud: enterprise-managed cloud config bundle fragments
> - user `${CODEX_HOME}/config.toml`
> - profile `${CODEX_HOME}/<name>.config.toml`, when selected
> - cwd `${PWD}/config.toml` (loaded but disabled when the directory is untrusted)
> - tree: parent directories up to root looking for `./.codex/config.toml` …
> - repo: `$(git rev-parse --show-toplevel)/.codex/config.toml` …
> - runtime: e.g., --config flags, model selector in UI

Two notes on that comment. First, it says `${PWD}/config.toml`, but the code only ever looks for
`<dir>/.codex/config.toml` — there is no bare `config.toml` in cwd
(`config/src/loader/mod.rs:1502`). Second, **the project tier is not one layer but N**: discovery
walks from `cwd` up to the project root, reverses, and emits one `Project` layer per directory that
contains a `.codex/` folder, "ordered in _increasing_ precedence, starting from folders closest to
`project_root` … to those closest to `cwd`" (`config/src/loader/mod.rs:1422-1425`,
`config/src/loader/mod.rs:1484-1502`). Layers with equal precedence keep insertion order, so nearer
directories win. Missing `config.toml` files still emit an *empty* project layer, because the
`.codex/` folder itself matters for skills, rules, and hooks discovery
(`config/src/loader/mod.rs:1576-1585`).

The official docs give a shortened five-item version of the same ladder
(<https://learn.chatgpt.com/docs/config-file/config-advanced>): system defaults → user config →
profile overlay → project config → CLI flags. The published list omits MDM, cloud, and the two
legacy managed layers.

Layers are stored lowest-first and folded in order; disabled layers (untrusted projects) are
skipped when computing the effective config (`config/src/state.rs:454-460`, `config/src/state.rs:477`).
Codex also records per-key provenance so the UI can say which layer won a given key
(`config/src/state.rs:466`).

## 2. Codex: the default merge rule

`merge_toml_values` is a plain recursive merge (`config/src/merge.rs:57`, `config/src/merge.rs:94-120`):

```rust
if let TomlValue::Table(overlay_table) = overlay
    && let TomlValue::Table(base_table) = base { … recurse per key … }
else { *base = normalized_with_key_aliases(overlay, path); }
```

The consequences are worth stating precisely:

- **Tables merge key-by-key, recursively, at unbounded depth.** A project layer that sets only
  `mcp_servers.foo.env.TOKEN` keeps the user layer's `mcp_servers.foo.command`.
- **Arrays do not union. They replace.** Arrays are not tables, so they take the `else` branch.
  The test `shell_environment_policy_legacy_array_overlay_replaces_legacy_array`
  (`config/src/merge_tests.rs:302-319`) asserts exactly this, and a comment states it as policy:
  "Legacy arrays already replace wholesale" (`config/src/merge.rs:133`).
- **Scalars replace.** Same branch.

So the base rule *is* uniform: "tables merge, leaves replace". Where per-key behaviour appears, it
appears as four special cases inside the merge function itself:

1. **Key aliasing.** Legacy key names are normalized to canonical ones on both sides before merging,
   so a legacy name in one layer and the canonical name in another are treated as the same key
   (`config/src/merge.rs:97-99`, tests at `config/src/merge_tests.rs:12`, `:82`, `:104`).
2. **`features.multi_agent_v2`** may be a boolean in one layer and a table in another; the merge
   promotes/folds between the two representations rather than clobbering
   (`config/src/merge.rs:78-92`).
3. **`shell_environment_policy`** has two mutually exclusive filter representations (`filters` map
   vs legacy `exclude`/`include_only` arrays). An overlay that picks one representation *deletes*
   the other's fields from the base rather than reconciling them (`config/src/merge.rs:135-155`).
4. **Key normalization before comparison** for two specific paths: `permissions.*.network.domains`
   keys are host-normalized, and `shell_environment_policy.filters` keys are lower-cased, so that
   `FOO_*` in one layer and `foo_*` in another merge instead of coexisting
   (`config/src/merge.rs:100-107`, `config/src/merge.rs:177-197`).

None of these four is a "lists union" rule. **Codex has no config key anywhere whose arrays union
across layers under `merge_toml_values`.**

## 3. Codex: how each capability type is actually resolved

This is where the hypothesis breaks. Six capability types, six different answers.

### 3.1 MCP servers — merged by name, *and* by field

`mcp_servers` is `HashMap<String, McpServerConfig>` in the TOML schema
(`config/src/config_toml.rs:269-270`), i.e. an ordinary TOML table. It therefore rides the default
merge: **servers merge by id across layers, and fields within a server also merge across layers.**
That second half is a real difference from Claude Code (§7), and **(inference)** it means a project
`.codex/config.toml` can mutate one field of a user-defined server without redeclaring it.

Codex then applies two post-merge passes that are *not* part of layering:

- **Requirements filtering.** If an admin `requirements.toml` supplies an `mcp_servers` allowlist,
  every configured server is checked against a requirement matcher (exact command, arg-wise
  matchers, or URL prefix/regex); non-matching servers get `enabled = false` and a
  `disabled_reason` rather than being deleted (`core/src/config/mod.rs:2043-2066`,
  `config/src/mcp_requirements.rs:49-88`). An empty allowlist disables everything
  (`core/src/config/mod.rs:1640-1643`).
- **Catalog collision resolution.** Config-declared servers and plugin-declared servers are merged
  into one catalog by a *separate* precedence enum, `Plugin < SelectedPlugin < Config <
  Compatibility < Extension` (`codex-mcp/src/catalog.rs:98-117`), with same-tier name collisions
  reported as `McpServerConflict` (`codex-mcp/src/catalog.rs:251-257`).

### 3.2 Instruction files — not in the config system

`AGENTS.md` never touches `ConfigLayerStack` as data. It has its own discovery and its own
composition rule (`core/src/agents_md.rs:1-16`):

1. One **global** entry: `$CODEX_HOME/AGENTS.override.md`, else `$CODEX_HOME/AGENTS.md`; first
   non-empty file wins, and only one is used (`codex-home/src/instructions/mod.rs:26-62`).
2. Every **project** file from the project root down to cwd, inclusive, all of them concatenated in
   that order (`core/src/agents_md.rs:201-278`). Within each directory the filename search order is
   `AGENTS.override.md`, then `AGENTS.md`, then any configured
   `project_doc_fallback_filenames`, and the first hit in that directory wins
   (`core/src/agents_md.rs:281-297`).
3. Global and project content are joined by a literal separator, `"\n\n--- project-doc ---\n\n"`
   (`core/src/agents_md.rs:48`).
4. The whole thing is capped by `project_doc_max_bytes` and truncated mid-file when the budget runs
   out (`core/src/agents_md.rs:68`, `:165-176`). Docs give the default as 32 KB
   (<https://learn.chatgpt.com/docs/agent-configuration/agents-md>).
5. Nothing loads if the active project is untrusted (`core/src/agents_md.rs:64`).

There is a nice circularity dodge worth noting: to find the project root, Codex needs
`project_root_markers`, which is a config key — so it merges **every layer except the project
layers** to read it (`core/src/agents_md.rs:206-212`). Project config cannot move its own project
root.

No frontmatter is parsed. No glob scoping exists. **Instructions are the only capability in Codex
with pure concatenate-everything semantics**, which is precisely the "instructions concatenate"
half of the hypothesis — confirmed.

### 3.3 Tool / approval policy — override-merge, then constrain, then a third inheritance axis

Approval and sandbox policy spans several keys, and they do not behave alike:

- `approval_policy` and `sandbox_mode` are scalars (`config/src/config_toml.rs:176`, `:205`) →
  plain override.
- `permissions` is a flattened map of **named permission profiles**
  (`config/src/permissions_toml.rs:23-26`) → merges by profile name across layers, and by field
  within a profile. On top of that, profiles have their own `extends` chain resolved *within* the
  merged document: "Parent profiles are merged before their children, so child keys override
  matching parent keys" (`config/src/permissions_toml.rs:33-39`). That is a **third composition
  axis** — layer precedence, then name-keyed merge, then declaration-graph inheritance.
- `permissions.*.network.domains` keys are host-normalized before merging (§2.4), so
  `Example.COM` and `example.com` are one entry rather than two.
- Admin `requirements.toml` then *constrains* the result: `Constrained<T>` wraps a value with a
  validator and an optional normalizer, and an out-of-range value produces
  `ConstraintError::InvalidValue` naming the requirement source rather than being silently
  overridden (`config/src/constraint.rs:9-17`, `:57-66`).

### 3.4 Hooks — per-layer union, plus a user-only enable/disable lane

Hooks live under a `[hooks]` key in `config.toml`, so you would expect them to ride the merge. They
do not. Discovery iterates layers low-to-high and reads **each layer's own unmerged config**:

```rust
let hook_value = layer.config.get("hooks")?.clone();     // hooks/src/engine/discovery.rs:384
```

Each layer additionally contributes its `.codex/hooks.json`, keyed by
`hooks_config_folder()` — which, for linked git worktrees, is redirected to the root checkout's
folder so worktree-local hooks cannot silently differ (`config/src/state.rs:233-243`). Everything
found is appended into one ordered handler list (`hooks/src/engine/discovery.rs:126-181`). Two
representations in the same layer produce a warning, not a merge
(`hooks/src/engine/discovery.rs:150-159`).

Separately, `hooks.state.<key>.enabled` — the toggle that turns an individual discovered hook off —
is read **only from `User` and `SessionFlags` layers** and accumulated in layer order
(`hooks/src/config_rules.rs:23-29`). A project or system layer cannot disable a hook.

Admins get a kill switch that is deliberately *not* a config key: top-level
`allow_managed_hooks_only = true` in `requirements.toml` drops user, project, and session hooks
while keeping managed ones, and "this setting is only supported in `requirements.toml`; putting it
in `config.toml` does not enable managed-hooks-only mode" (`.repos/codex/docs/config.md:9-15`,
enforced at `hooks/src/engine/discovery.rs:105-112`).

### 3.5 Exec-policy `.rules` — per-layer file union, then an overlay

Every layer that has a config folder contributes `<folder>/rules/*` files, collected low-to-high
"so that higher-precedence layers can override rules defined in lower-precedence ones", parsed into
one policy (`core/src/exec_policy.rs:641-660`). The admin requirements policy is then applied on
top via `policy.merge_overlay(...)` (`core/src/exec_policy.rs:694`). A loader flag can drop user and
project rule files wholesale (`core/src/exec_policy.rs:649-655`).

### 3.6 Skills — discovery scoped by layer kind, enablement scoped to user/session

Skill *roots* are derived from the layer stack, but each layer kind maps to a different scope tag
and a different directory, and four layer kinds contribute nothing at all
(`ext/skills/src/host_roots.rs:73-129`):

| Layer | Roots contributed | Scope tag |
|---|---|---|
| `Project` | `<.codex>/skills` | `Repo` |
| `User` | `$CODEX_HOME/skills` (deprecated), `~/.agents/skills`, system cache root | `User` / `System` |
| `System` | `/etc/codex/skills` | `Admin` |
| Packaged, MDM, EnterpriseManaged, SessionFlags, both legacy managed | *(nothing)* | — |

Skill *enablement* (`skills.config`, a list of `{path|name, enabled}` selectors) is read **only from
`User` and `SessionFlags` layers**, accumulated in layer order with same-selector replacement, then
applied in order so later rules win (`config/src/skills_config.rs:150-185`, `:94-125`). Project,
system, and managed layers cannot enable or disable a skill. Meanwhile `skills.bundled.enabled` — a
different key in the same table — *is* read from the fully merged effective config
(`config/src/skills_config.rs:129-146`). Two keys, one table, two different scope sets.

## 4. Codex: the project-layer denylist

Because project config is repository content, twelve top-level keys are deleted from every project
layer before it enters the stack, with the reasoning stated in the source
(`config/src/loader/mod.rs:66-84`):

> Project-local config comes from repository contents, so it should not get to choose where a user's
> credentials are sent or which local commands are run.

The list: `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `responses_api_metadata`,
`model_provider`, `model_providers`, `notify`, `profile`, `profiles`,
`experimental_realtime_webrtc_call_base_url`, `experimental_realtime_ws_base_url`, `otel`. Plus two
targeted removals: `features.respect_system_proxy`, and the `tui.keymap.chat.{previous,next}_permission_mode`
bindings, because "repository contents must not turn an ordinary key into a permission increase"
(`config/src/loader/mod.rs:1126-1145`). Stripped keys produce a startup warning telling the user to
set them at user level instead (`config/src/loader/mod.rs:1147-1163`).

Note what is *not* on the list: `mcp_servers`. A trusted repository can add MCP servers.

Trust is the other project-layer gate. Untrusted directories still produce layers, but with a
`disabled_reason`, and disabled layers are excluded from `effective_config()` and `origins()` while
remaining visible to the UI (`config/src/loader/mod.rs:1096-1112`, `config/src/state.rs:477-480`,
`config/src/loader/README.md`).

## 5. Codex: the second stack (`requirements.toml`)

Admin policy is *not* just a high-precedence config layer. It is a parallel stack composed by
`compose_requirements` from system `/etc/codex/requirements.toml`, cloud bundle requirements, legacy
`managed_config.toml` reinterpreted as requirements, and macOS managed preferences, in that order
(`config/src/loader/mod.rs:90-104`, `:236-249`). Its composition rules are documented at the top of
the file and are explicitly *not* uniform (`config/src/requirements_layers/stack.rs:1-15`):

> Most fields use the same TOML-level merge policy as config … A few fields carry domain-specific
> meaning that raw TOML replacement would break:
> - `remote_sandbox_config` is evaluated within each layer before merging.
> - `rules.prefix_rules` append high-priority rules first.
> - `hooks` append high-priority event groups first while failing closed on active managed-dir conflicts.
> - `permissions.filesystem.deny_read` is a high-priority-first union across layers.
> - `auto_review.required_on_models` is a high-priority-first union across layers.

The composed requirements are then applied to the merged config as **constraints, not overrides**:
allowlists that disable non-matching MCP servers (§3.1), `Constrained<T>` validators that reject
out-of-range values with a message naming the source (§3.3), and an exec-policy overlay (§3.5).
Composition conflicts between two requirements layers are hard errors naming both sources
(`config/src/requirements_layers/stack.rs:43-51`).

**(inference)** This is the single most transferable design idea in the Codex config system: *admin
policy that expresses a bound is a different kind of thing from user config that expresses a
choice, and folding it into the same precedence ladder loses the ability to say "your value was
rejected because of X" instead of silently replacing it.*

## 6. opencode

opencode has **two config systems in the tree simultaneously** — a v1 loader still wired to the
shipping CLI, and a v2 Effect-based service — and they take opposite approaches.

### 6.1 v1: deep merge with exactly one union special case

`packages/opencode/src/config/config.ts` folds sources into a single `Info` object with
`remeda.mergeDeep` (objects merge by key, arrays replace), and defines exactly one exception:

```ts
function mergeConfigConcatArrays(target: Info, source: Info): Info {   // :45
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}
```

`instructions` — the list of extra instruction files/globs — is **the only array in the whole config
that unions across levels**. This is the hypothesis in its purest form, hard-coded as a five-line
special case.

The load order (`config.ts:371-533`) matches the published precedence list
(<https://opencode.ai/docs/config/>, `packages/web/src/content/docs/config.mdx:44-55`):

> 1. Remote config (from `.well-known/opencode`) … 2. Global config (`~/.config/opencode/opencode.json`)
> … 3. Custom config (`OPENCODE_CONFIG` env var) … 4. Project config … 5. `.opencode` directories …
> 6. Inline config (`OPENCODE_CONFIG_CONTENT`) … 7. Managed config files … 8. macOS managed
> preferences — highest priority, not user-overridable

Directory-sourced capabilities (`commands/`, `agents/`, `modes/`, `plugins/`) are merged in
per-directory with `mergeDeep` keyed by name (`config.ts:459-465`), i.e. named things override by
id — same as Codex, arrived at independently.

MCP servers are `Record<string, Server>` (`packages/core/src/config/mcp.ts:45-48`), so they merge by
name and by field, same as Codex.

### 6.2 v2: no merge at all — an ordered list, plus a deliberate precedence inversion

The v2 service does not produce a merged object. It produces an **ordered array of entries, lowest
priority first**, and lets each consumer decide (`packages/core/src/config.ts:128-131`). The generic
accessor is last-writer-wins for the whole key:

```ts
export function latest<K extends keyof Info>(entries, key) {         // packages/core/src/config.ts:122
  return entries.filter(isDocument).findLast((e) => e.info[key] !== undefined)?.info[key]
}
```

And then the striking part — `experimental.policies` are loaded in **reversed** order, with the
reason in a comment (`packages/core/src/config.ts:203-211`):

> Apply general settings first and more specific settings last: global config, project files, then
> `.opencode` files.
> Rules use the opposite order so a user-global rule can override a repository rule. Statement order
> inside each file stays unchanged.

Combined with the documented "last matching statement wins" evaluation rule
(`packages/web/src/content/docs/policies.mdx:76`), a user-global deny beats a repo allow. **This is
a direct counterexample to any model where one precedence ladder serves all capability types** — the
same tool ships two ladders pointing in opposite directions, on purpose.

### 6.3 opencode instructions: first *filename* wins, then all ancestors stack

`packages/opencode/src/session/instruction.ts:110-153`:

- **Global**: iterate `[~/.config/opencode/AGENTS.md, ~/.claude/CLAUDE.md]` and `break` on the first
  that exists — exactly one global file (`:115-120`).
- **Project**: iterate `["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]`; for the first name that matches
  anything, take **all** its matches walking up to the worktree root, then `break` (`:123-133`).
  `findUp` returns every ancestor hit (`packages/core/src/fs-util.ts:154-165`).
- **Config-declared**: every `instructions` glob, resolved with `globUp` (walks up from cwd),
  supporting `~/`, absolute paths, and `http(s)://` URLs fetched with a 5 s timeout (`:135-168`).

The comment on the project branch says "The first project-level match wins so we don't stack
AGENTS.md/CLAUDE.md from every ancestor" (`:122`), which is about filenames, not ancestors. The
published docs are less precise still: "The first matching file wins in each category"
(`packages/web/src/content/docs/rules.mdx`, *Precedence*). **The code stacks every ancestor's
AGENTS.md; only the CLAUDE.md/CONTEXT.md fallbacks are suppressed once AGENTS.md is found.** Flagging
this as a docs/code divergence.

### 6.4 Where opencode diverges from Codex

| | Codex | opencode |
|---|---|---|
| Merge engine | one recursive TOML merge over a layer stack | v1 `mergeDeep` fold; v2 no merge, ordered entry list |
| Array union cases | none | exactly one (`instructions`) |
| Instruction discovery | concatenate every ancestor `AGENTS.md` + one global | all ancestors of the *first matching filename* + one global |
| Claude Code compat | none | `CLAUDE.md`, `~/.claude/CLAUDE.md`, `.claude/skills/` read as fallbacks, disableable by env var |
| Admin tier | separate `requirements.toml` constraint stack | topmost merge layers (managed dir, then MDM `.mobileconfig`) |
| Policy/rule direction | admin-highest | **user-global highest, repo lowest** for `experimental.policies` |
| Project trust gate | yes — untrusted project layers loaded but disabled | not found in the config loader |

## 7. Claude Code, for contrast (docs only)

Worth recording because it is the closest system to cogwork and it disagrees with Codex on the one
question that matters most for MCP.

Settings precedence, highest first (<https://code.claude.com/docs/en/settings>): managed settings →
command-line `--settings` → `.claude/settings.local.json` → `.claude/settings.json` →
`~/.claude/settings.json`. And critically:

> **Lists merge instead of overriding.** When you set the same list key, such as `permissions.allow`,
> in more than one file, Claude Code combines the lists instead of picking one.

with two named exceptions (`fallbackModel` takes the whole value from the highest file because
position is meaningful; `availableModels` is replaced outright by the top managed source). Permission
rules then resolve **by rule kind, not by scope** — "an `allow` rule there doesn't outrank an `ask`
rule from a project or managed file".

But MCP servers use a *different* scope set (local / project / user, in
`~/.claude.json` and `.mcp.json`) and a *different* rule
(<https://code.claude.com/docs/en/mcp>):

> When the same server is defined in more than one place, Claude Code connects to it once, using the
> definition from the highest-precedence source. **The entire server entry from that source is used;
> fields are not merged across scopes.**

So Claude Code: lists union, named MCP servers replace whole. Codex: lists replace, named MCP servers
merge field-by-field. **The two most prominent harnesses have opposite answers on both halves.**

## 8. t3code

t3code is not a harness; it is a multi-provider GUI that drives Codex, Claude Code, Cursor, Grok, and
opencode as subprocesses. It therefore has no capability-config layering of its own, and the three
things it does have are each resolved by hand:

1. **Scalar fallback chain.** `resolveDefaultThreadEnvMode` — "per-project setting > checked-in
   `t3.json` > global server setting" — is a three-term `??` chain, with a comment demanding that web
   and mobile both route through it "so the platforms cannot disagree on the order"
   (`packages/shared/src/threadEnvMode.ts:3-18`).
2. **No merge for repo-declared capabilities.** Scripts in a repo's `t3.json` are "offered for
   import" into the user's per-project settings, filtered against what the user already has
   (`apps/web/src/components/ProjectScriptsControl.tsx:44`,
   `apps/web/src/components/settings/ProjectSettingsPanel.tsx:489-496`). Repository content becomes
   effective only by explicit human action — a fourth model alongside override / union / constrain.
   An invalid `t3.json` is treated as absent, never as an error
   (`apps/server/src/project/T3ProjectFileLoader.ts:1-9`).
3. **Injection into someone else's stack.** To expose its own tools, t3code writes itself into each
   harness's highest-precedence scope: for Codex, two `-c` session flags
   (`mcp_servers.t3-code.url=…`, `mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"`)
   at `apps/server/src/provider/Layers/CodexAdapter.ts:1684-1693`; for Claude Code, the SDK
   `mcpServers` option at `apps/server/src/provider/Layers/ClaudeAdapter.ts:4126-4138`. It also
   pins which Claude Code setting scopes load at all — `["user", "project", "local"]`, i.e. it
   opts out of nothing but names the set explicitly
   (`apps/server/src/provider/Layers/ClaudeAdapter.ts:1171-1175`, `:4106`).

**(inference)** Point 3 is the practical lesson for anyone embedding a harness: the merge semantics
of `mcp_servers` are *load-bearing API surface* for embedders. t3code's injection works precisely
because both harnesses key MCP servers by name and let the top scope introduce a new one.

## 9. Verdict on the hypothesis

> *The same set of scopes is available to every capability type, but the merge rule differs per type
> (instructions concatenate across levels; named things like MCP servers override by id).*

**Confirmed:** the merge rule does differ per type, and in the direction predicted. Instructions
concatenate (Codex `AGENTS.md`, opencode `instructions` union, Claude Code CLAUDE.md
concatenation). Named things key by id (Codex `mcp_servers`, `permissions.<profile>`,
opencode `mcp.servers`, `agents`, `commands`).

**Refuted:** the scope set is *not* uniform across capability types.

- Codex `skills.config` and `hooks.state`: User + SessionFlags only.
- Codex skill roots: Project/User/System only; four layer kinds contribute nothing.
- Codex project layers: twelve keys removed before merging.
- Claude Code MCP scopes (local/project/user) are a different set from Claude Code settings scopes
  (managed/CLI/local/project/user).

**Complicated, in four ways the hypothesis does not model:**

1. **Union is not the only alternative to override.** Codex hooks and exec-policy rules are read
   *per raw layer and appended* — they never enter the merged document at all. That is "append the
   sources", not "union the values".
2. **Admin policy can be a second stack rather than a top layer.** Codex `requirements.toml` composes
   separately, with its own per-field rules, and then *constrains* — producing errors that name the
   policy source instead of silent overrides.
3. **Precedence direction is itself per-type.** opencode deliberately reverses it for
   `experimental.policies` so user-global beats repo.
4. **"Override by id" hides a second question: whole-entry or field-wise?** Codex merges MCP server
   fields across layers; Claude Code explicitly does not. Both are defensible; they are not the same
   feature, and a spec that says only "override by id" fails to distinguish them.

**(inference)** A cleaner model to design against: *a capability's resolution is a triple of (scope
set, composition operator, direction)*, where the operator is one of `override-scalar`,
`merge-by-key`, `append-sources`, `union-values`, or `constrain`. Every behaviour observed in all
three codebases fits that triple; none of them fits "one ladder, one rule".

---

# Question 2 — is there an open standard for writing "rules"?

## 10. Inventory: what each tool reads, and from where

| Tool | Always-on instruction files | Modular rules dir | Applicability metadata | Lazily-loaded instructions |
|---|---|---|---|---|
| **Claude Code** | managed policy `CLAUDE.md` (`/Library/Application Support/ClaudeCode/`, `/etc/claude-code/`, `C:\Program Files\ClaudeCode\`) → `~/.claude/CLAUDE.md` → `./CLAUDE.md` or `./.claude/CLAUDE.md` (all ancestors) → `./CLAUDE.local.md`; `@path` imports, max 4 hops | `.claude/rules/**/*.md`, `~/.claude/rules/` | **`paths:` glob frontmatter** on rules; nothing on `CLAUDE.md` | `.claude/skills/*/SKILL.md` |
| **Cursor** | `AGENTS.md` in root and subdirectories | `.cursor/rules/**/*.mdc`, `~/.cursor/rules`, team rules from the dashboard | **`alwaysApply`, `globs`, `description`** | `.cursor/skills` |
| **Codex** | `~/.codex/AGENTS.override.md` or `~/.codex/AGENTS.md`; then every `AGENTS.override.md`/`AGENTS.md` from project root to cwd; `project_doc_fallback_filenames` adds names | none | **none** | `.codex/skills/*/SKILL.md` (+ optional `SKILL.json`) |
| **opencode** | one global (`~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md`); then all ancestors of the first matching of `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md`; plus `instructions[]` globs and URLs from config | `instructions[]` is the closest thing | **none** on instruction files | `.opencode/skills/*/SKILL.md`, plus `.claude/skills/` and `.agents/skills/` |
| **AGENTS.md convention** | `AGENTS.md` at repo root, nested files in monorepos | n/a | **none** | n/a |

Sources: <https://code.claude.com/docs/en/memory>; <https://cursor.com/docs/context/rules>;
`.repos/codex/codex-rs/core/src/agents_md.rs:1-16` and
<https://learn.chatgpt.com/docs/agent-configuration/agents-md>;
`.repos/opencode/packages/opencode/src/session/instruction.ts:60-168` and
`.repos/opencode/packages/web/src/content/docs/rules.mdx`; <https://agents.md/>.

## 11. Applicability controls, side by side

| Control | Claude Code | Cursor | Codex | opencode | AGENTS.md spec |
|---|---|---|---|---|---|
| Always applied | default for `CLAUDE.md` and rules without `paths:` | `alwaysApply: true` ("Always included. Globs and description are ignored.") | default, only mode | default, only mode | implied, unspecified |
| Glob/path scoping | `paths:` list, brace expansion, budget of 1 000 expanded patterns / 4 MiB | `globs:` (comma-separated) | ✗ | ✗ | ✗ |
| Description-based / agent-requested | ✗ for rules; it is the SKILL.md mechanism | `alwaysApply: false` + `description` → "Agent evaluates relevance based on description" | ✗ | ✗ | ✗ |
| Manual `@rule-name` invocation | ✗ | yes (`alwaysApply: false`, no description/globs) | ✗ | ✗ | ✗ |
| Directory-scoped discovery | ancestors at launch; subdirectory `CLAUDE.md` loads on demand when Claude reads files there | nested `AGENTS.md` "combined with parent directories, with more specific instructions taking precedence" | ancestors, concatenated root→cwd | ancestors of the first matching filename | "the nearest file … the closest one takes precedence" |
| Nested rules directories | `.claude/rules/**` recursive, symlinks resolved, cycles detected | folders under `.cursor/rules/` (docs show the layout; scoping semantics for nesting not stated) | n/a | n/a | n/a |
| Exclusion | `claudeMdExcludes` globs, arrays merge across settings layers | not documented on the rules page | `skills.config` disables skills, not instruction files | env vars disable Claude-compat fallbacks | ✗ |
| Size limits | target < 200 lines; file > 4 MiB skipped | not stated | `project_doc_max_bytes`, default 32 KB, truncates mid-file | none found | ✗ |

Two asymmetries worth calling out. **Cursor's `alwaysApply: true` explicitly ignores `globs` and
`description`** — the fields are not composable, they select a mode. And **Claude Code's `paths:`
triggers on file reads, not on every tool use**, so a path-scoped rule can be absent from context for
an arbitrarily long stretch of a session, and reloads only when a matching file is read again
(including after `/compact`).

## 12. What AGENTS.md actually is

AGENTS.md is a **convention with real adoption and almost no surface area**. Per <https://agents.md/>:

- **Specifies:** the filename; placement "at the root of the repository"; support for nested files in
  monorepos, where agents read "the nearest file in the directory tree, so the closest one takes
  precedence"; conflict resolution as "the closest AGENTS.md to the edited file wins; explicit user
  chat prompts override everything"; that the file "is just standard Markdown. Use any headings you
  like"; and that it complements rather than replaces `README.md`.
- **Does not specify:** frontmatter or any metadata; glob/path scoping; conditional or
  description-based activation; a user-global or organization-managed tier; size limits; import or
  include syntax; concatenation-vs-nearest-wins as a normative requirement; what happens when a tool
  also has a native format.
- **Claimed adoption:** "over 60,000 open-source projects on GitHub", and a list of 20+ agents
  including Codex, Cursor, Jules, Aider, VS Code, and GitHub Copilot.

Two caveats on that adoption number, both from primary sources:

- **Support is not uniform even among listed tools.** Codex reads AGENTS.md natively, but
  **concatenates every file from root to cwd** rather than using the nearest — its docs say so
  explicitly: "Rather than a 'nearest wins' approach, Codex concatenates files from the root down…"
  (<https://learn.chatgpt.com/docs/agent-configuration/agents-md>). That is a different semantic
  from the convention's stated conflict rule, from the same vendor.
- **Claude Code does not read AGENTS.md at all.** Its docs are unambiguous: "Claude Code reads
  `CLAUDE.md`, not `AGENTS.md`", and recommend `@AGENTS.md` as the first line of a `CLAUDE.md`, or a
  symlink (<https://code.claude.com/docs/en/memory>). Support is real but **opt-in via a one-line
  shim**, not native.
- **opencode** reads AGENTS.md natively and also treats `CLAUDE.md` as a fallback, but its
  precedence is per-filename-category, not per-directory (§6.3).

## 13. If you wanted to adopt an existing standard rather than invent one

**What you would adopt:** `AGENTS.md`, plus the *de facto* convention that a repo-root file is
combined with nested files closer to the work, plus — for the lazily-loaded half — `SKILL.md` with
`name` and `description` frontmatter, which Claude Code, Codex, opencode, and Cursor all read from
some `skills/<name>/SKILL.md` path. Those two files are the only genuinely portable artefacts.

**What that fails to express** — every item below has to be invented or borrowed from one vendor:

1. **Path scoping.** "Apply this only to `src/api/**/*.ts`." Claude Code's `paths:` and Cursor's
   `globs:` are two different field names, in two different files, with two different trigger
   semantics (file-read vs in-context). Codex and opencode have neither.
2. **Conditional / agent-requested activation.** Cursor's `description`-driven relevance evaluation
   has no counterpart in any other rules format; the nearest portable analogue is a Skill, which is a
   different lifecycle (model-invoked tool call, not context injection).
3. **Precedence between user-global, project, and organization tiers.** AGENTS.md says nothing about
   a `~/` file. Every tool invented one, and they disagree on whether the global file *merges* with
   the project file (Codex: yes, separated by a literal `--- project-doc ---`) or is a *fallback*
   (opencode global: first hit wins, only one file).
4. **Concatenate vs nearest-wins.** The convention says nearest-wins; Codex and Claude Code both
   concatenate everything. A repo author cannot know which they will get.
5. **Exclusion.** Only Claude Code has `claudeMdExcludes`. In a monorepo where an ancestor
   `AGENTS.md` belongs to another team, the convention offers no escape hatch.
6. **Size and truncation behaviour.** Codex silently truncates mid-file at 32 KB; Claude Code skips a
   file over 4 MiB entirely. A rule that is present under one harness is absent under another.
7. **Imports / composition.** `@path` imports with a 4-hop limit are Claude Code-only. opencode's
   `instructions[]` globs are opencode-only and live in JSON config, not in the markdown.
8. **Trust and provenance.** Codex refuses all project instructions in an untrusted project
   (`core/src/agents_md.rs:64`); Claude Code shows an approval dialog for project-file imports that
   resolve outside the working directory. The convention has no notion of instruction files as
   untrusted repository content.
9. **Any enforcement semantics at all.** Claude Code states the boundary plainly: memory files are
   "context, not enforced configuration … To block an action regardless of what Claude decides, use a
   PreToolUse hook instead." Nothing in the rules-file world is a policy language; Codex's
   `requirements.toml` and `.rules` exec policy are the only *enforced* layer in any of these
   systems, and they are TOML, not Markdown.

**(inference)** The honest summary for a build-vs-adopt decision: adopt `AGENTS.md` as the plain-prose
entry point — it costs nothing, it is what 60 k repos already ship, and every harness either reads it
or can be made to with a symlink. Then accept that **applicability metadata is not standardized and
will not be soon**, and pick *one* vendor's shape to imitate rather than inventing a third. Claude
Code's `paths:` frontmatter on `.claude/rules/*.md` is the better model to imitate if the priority is
enforced-ish scoping with an exclusion mechanism; Cursor's `.mdc` is the better model if the priority
is description-driven activation. They are not reconcilable in one file, because Cursor's own docs say
`alwaysApply: true` *ignores* `globs` and `description`.

---

## Sources

**Vendored source (read on disk)**

- `.repos/codex` @ `eb15245d` — `codex-rs/config/src/config_layer_source.rs`, `merge.rs`,
  `merge_tests.rs`, `state.rs`, `skills_config.rs`, `permissions_toml.rs`, `mcp_requirements.rs`,
  `config_toml.rs`, `constraint.rs`, `loader/mod.rs`, `loader/README.md`,
  `requirements_layers/stack.rs`; `codex-rs/core/src/agents_md.rs`, `exec_policy.rs`,
  `config/mod.rs`, `mcp_tool_call.rs`; `codex-rs/codex-home/src/instructions/mod.rs`;
  `codex-rs/codex-mcp/src/catalog.rs`; `codex-rs/hooks/src/engine/discovery.rs`,
  `hooks/src/config_rules.rs`; `codex-rs/ext/skills/src/host_roots.rs`,
  `ext/skills/src/loader/metadata.rs`; `docs/config.md`, `docs/agents_md.md`
- `.repos/opencode` @ `ceb4890c` — `packages/core/src/config.ts`, `core/src/config/mcp.ts`,
  `core/src/fs-util.ts`; `packages/opencode/src/config/config.ts`,
  `opencode/src/session/instruction.ts`, `opencode/src/mcp/index.ts`;
  `packages/web/src/content/docs/{config,rules,policies,permissions,agents,skills}.mdx`
- `.repos/t3code` @ `1e59b4c4` — `packages/shared/src/threadEnvMode.ts`,
  `packages/contracts/src/t3ProjectFile.ts`; `apps/server/src/project/T3ProjectFileLoader.ts`,
  `apps/server/src/provider/Layers/CodexAdapter.ts`, `provider/Layers/ClaudeAdapter.ts`,
  `provider/Drivers/CodexHomeLayout.ts`; `apps/web/src/components/ProjectScriptsControl.tsx`,
  `components/settings/ProjectSettingsPanel.tsx`

**Official documentation**

- Codex config (advanced) — https://learn.chatgpt.com/docs/config-file/config-advanced
  (`developers.openai.com/codex/config-advanced` 308s here)
- Codex AGENTS.md — https://learn.chatgpt.com/docs/agent-configuration/agents-md
  (`developers.openai.com/codex/guides/agents-md` 308s here)
- Claude Code memory / CLAUDE.md / `.claude/rules/` — https://code.claude.com/docs/en/memory
- Claude Code settings precedence and list merging — https://code.claude.com/docs/en/settings
- Claude Code MCP scopes and name-conflict rule — https://code.claude.com/docs/en/mcp
- Cursor rules (`.mdc` frontmatter, rule types, AGENTS.md) — https://cursor.com/docs/context/rules
- AGENTS.md convention — https://agents.md/
- opencode config precedence — https://opencode.ai/docs/config/
- opencode rules — https://opencode.ai/docs/rules/
- opencode policies — https://opencode.ai/docs/policies/
