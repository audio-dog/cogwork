# Plugin, connector, and extension versioning across agent platforms

Date: 2026-08-24.

**Question:** Do the major agent/assistant platforms version their plugin, connector, and extension
bundles — and if so, is the version a real, enforced part of the contract or just metadata?

Scope: primary sources only — official docs, published JSON schemas, and the spec/registry repositories
themselves. Where a schema file settles a question, the schema is cited over the prose. Claims that come
from prose alone are marked as such. Sections labelled **Inference** are my own reading, not documented fact.

---

## Synthesis

**Is a required version field on the bundle the norm or the exception among agent-capability systems?**

It is **an even split, and "required" turns out to be the wrong axis to judge these systems on.** Of the
four agent-capability bundle formats surveyed, two require a version and two do not:

| Bundle format | `version` required? | Anything enforce/resolve it? |
|---|---|---|
| Claude Code `plugin.json` | **No** — `name` is the only required field | **Yes, extensively** — resolution chain, semver dependency ranges, cache key, pinning |
| MCP Registry `server.json` | **Yes** | **Yes** — uniqueness enforced, immutable once published, drives `isLatest` |
| OpenAI `.codex-plugin/plugin.json` | **Yes**, semver | **Yes** — six validation error codes, install path segment |
| Cursor `plugin.json` | **No** — `name` only | **No** — nothing documented consumes it |
| *(baseline)* VS Code `package.json` | **Yes**, semver | **Yes** — marketplace-enforced, plus `engines.vscode` compat range |

The split does not track capability. **Claude Code has the most sophisticated version machinery of any
system here — including the only semver dependency ranges between bundles — while making the field
itself optional.** Cursor requires nothing and enforces nothing. So "required" and "enforced" are
independent axes, and the interesting one is enforcement.

Three findings matter more than the required/optional count:

1. **The real gap is host compatibility, not bundle identity.** VS Code's `engines.vscode` is required,
   cannot be `*`, and gates which extension version each client is offered. **No agent-capability system
   surveyed has an equivalent.** Claude Code expresses host requirements as *prose plus a runtime error
   string* ("Requires Claude Code v2.1.224 or later"), never as a manifest field. This is the single
   clearest thing agent platforms have not yet copied from the mature baseline.

2. **Where the version field is optional, an identity is still mandatory — it is just derived.** Claude
   Code falls back to the resolved git commit SHA, then a SHA-256 archive digest, then a content hash of
   command output. An unversioned Claude Code plugin is not unidentified; it is content-addressed. This is
   arguably a *better* default than an author-supplied string, because it cannot go stale.

3. **MCP's wire-level server version is required by schema and simultaneously forbidden from mattering.**
   `Implementation.version` is non-optional in the schema, and the spec says the value "is not verified by
   the protocol… Clients **SHOULD NOT** use it to change their behavior." That is the purest example in this
   survey of a version field that is structurally required and semantically inert.

**Do any of them version individual capabilities inside the bundle independently of the bundle?**

**No. Not one.** This is the most uniform finding in the survey. Across every platform, every inner
capability — Skills, subagents, slash commands, hooks, MCP servers, tools, resources, prompts, VS Code
contribution points — carries **no version field of any kind**. Everything inside a bundle is versioned
solely by its parent.

The three things that look like exceptions are not:

- **OpenAI widget resource URIs** (`ui://project-board/v1.html`) version independently, but that is a
  *naming convention in a string*, not a schema field. OpenAI's own examples mostly do not follow it.
- **VS Code's runtime `McpServerDefinition.version`** is optional, opaque, never range-matched, and exists
  only to prompt "tools changed, refresh?" — a cache-invalidation token, not a contract.
- **Config-schema discriminators** — Cursor's `hooks.json` `"version": 1`, VS Code's `tasks.json`
  `"version": "2.0.0"`, MCPB's `manifest_version` — version the *file format*, not the capability.

That a 10-year-old, 38-contribution-point ecosystem still versions exactly one level deep is worth
weighing before adding version fields to inner capabilities: the mature baseline deliberately did not.

---

## 1. Claude Code plugins

### (a)/(b) Version field: exists, optional

`plugin.json` has exactly one required field. From the
[plugins reference](https://code.claude.com/docs/en/plugins-reference):

> If you include a manifest, `name` is the only required field.

`version` is optional, and the docs describe it as a *pin*, not a label:

> Optional. Semantic version. Setting this pins the plugin to that version string, so users only receive
> updates when you bump it, except for a `command` source. If also set in the marketplace entry,
> `plugin.json` wins.

The marketplace manifest carries `version` in two places, both optional: a top-level "Marketplace manifest
version", and a `version` on each plugin entry
([plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)). Setting both is discouraged
— "Claude Code always uses the `plugin.json` value without warning, so a stale manifest version can mask a
version you set in `marketplace.json`."

### (c) Enforcement: the most developed of any system surveyed

**Resolution chain.** From
[Version management](https://code.claude.com/docs/en/plugins-reference#version-management), the version is
resolved from the first of these that is set:

1. `version` in `plugin.json`
2. `version` in the marketplace entry
3. the git commit SHA, for `github`, `url`, `git-subdir`, and relative-path sources
4. the SHA-256 digest, for `archive` sources (first 12 characters)
5. `unknown`, for `npm` sources or local dirs outside a git repo

`command` sources always append a 12-character content hash, and ignore the marketplace entry's version.

**Update detection.** "Claude Code uses the plugin's version as the cache key that determines whether an
update is available… Claude Code computes the current version and skips the update if it matches what's
already installed." The cache path is literally versioned:
`cache/<marketplace>/<plugin>/<version>/`. Auto-update is off by default for non-Anthropic marketplaces.

**Semver dependency ranges — unique to Claude Code among these platforms.** From
[Constrain plugin dependency versions](https://code.claude.com/docs/en/plugin-dependencies), a plugin
declares `dependencies` with npm-style ranges (`~2.1.0`, `^2.0`, `>=1.4`, `=2.1.0`). Resolution is real
and enforced:

- Ranges resolve against git tags following a `{plugin-name}--v{version}` convention, created by
  `claude plugin tag --push`.
- Multiple constraints on one dependency are **intersected**; an unsatisfiable pair fails the install with
  `range-conflict`.
- A failed resolution is a hard error: `Dependency "secrets-vault@acme-tools" has no git tag satisfying ~2.1.0`.
- For `npm`/`archive`/`command` sources, where tag resolution does not apply, "the constraint is still
  checked at load time, and the dependent plugin is **disabled** with `dependency-version-unsatisfied`."
- Pre-releases are excluded unless the range opts in.
- Cross-marketplace dependencies are blocked unless allowlisted via `allowCrossMarketplaceDependenciesOn`.
- `claude plugin validate` "warns when the entry's `version` doesn't match the one in `plugin.json`".

**Pinning and rollback.** Git sources take an optional 40-character `sha` to "pin to an exact version".
npm sources take `version` accepting exact versions or ranges. Archive sources take a `sha256` pin. The
docs describe **no rollback command** — reverting means reinstalling at an older pin. Release channels
exist, with the constraint that "each channel must resolve to a different version."

**Host compatibility range: none.** There is no `engines`-equivalent field. Grepping the full reference
for `engines`, `minimum`, and `compatib` returns nothing. Host requirements appear only as prose and a
runtime failure string, e.g. for `archive` sources: "Requires Claude Code v2.1.224 or later. On versions
v2.1.120 through v2.1.223, installing the plugin fails with `This plugin uses a source type your Claude
Code version does not support.`"

### (d) Inner capabilities: no independent versions

Verified against the frontmatter/config field tables for each component type:

| Component | Version field? | Source |
|---|---|---|
| Skills (`SKILL.md`) | **No.** Allowed properties are `allowed-tools, compatibility, description, license, metadata, name` | [skills](https://code.claude.com/docs/en/skills) |
| Subagents | **No** — `name`, `description`, `tools`, `model`, `effort`, `maxTurns`, `memory`, `isolation`, … | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Slash commands | **No** | [plugins-reference](https://code.claude.com/docs/en/plugins-reference) |
| Hooks (`hooks.json`) | **No** | [hooks](https://code.claude.com/docs/en/hooks) |
| MCP servers (`.mcp.json`) | **No** | [mcp](https://code.claude.com/docs/en/mcp) |
| LSP servers (`.lsp.json`) | **No** | [plugins-reference](https://code.claude.com/docs/en/plugins-reference) |

Worth noting: `SKILL.md` accepts a `compatibility` field — "Environment requirements for the skill, such
as intended products or system prerequisites… Accepts a string of up to 500 characters." But the docs are
explicit that it is inert: "Claude Code accepts the field but doesn't act on it." It is free text from the
[Agent Skills](https://agentskills.io) spec, not a machine-checked range.

---

## 2. MCP: three independent version axes

MCP has three versions that are routinely conflated. They are separate, and only two of them are enforced.

### 2.1 Protocol version — required and hard-enforced

**The current spec removed the `initialize` handshake.** From
[Versioning and Compatibility (2026-07-28)](https://modelcontextprotocol.io/specification/latest/basic/lifecycle):

> There is no negotiation handshake. Every request carries its protocol version, and the server accepts or
> rejects each request independently.

> If the server does not implement the requested version… it **MUST** respond with an
> `UnsupportedProtocolVersionError` listing the versions it does support.

> The client **SHOULD** select a mutually supported version from the `supported` list and retry the
> request, or surface an error to the user if no compatible version exists.

Versions are `YYYY-MM-DD` strings. Shipped revisions in the
[spec repo](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema): `2024-11-05`,
`2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`, plus `draft`. Latest is `2026-07-28`.

In the modern model the version rides in `_meta` as `io.modelcontextprotocol/protocolVersion` and is
required; on Streamable HTTP it must also match the `MCP-Protocol-Version` header, and a mismatch is a
`400 Bad Request` with a `HeaderMismatch` error. Error code for an unsupported version is `-32022`.

Legacy behaviour (`2025-06-18` and earlier) was a counter-offer, not an error: the server "MUST respond
with another protocol version it supports" and a client that cannot accept it "SHOULD disconnect"
([2025-06-18 lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)).

`server/discover` returns `supportedVersions: string[]` — a server advertises a **set**, not one version.

**This is the only place in the entire survey where version mismatch produces a specified, machine-readable,
MUST-level failure.**

### 2.2 Server version (`Implementation.version`) — required by schema, inert by design

In [`schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts),
the field is non-optional in both the current and prior revisions:

```ts
export interface Implementation extends BaseMetadata, Icons {
  version: string;          // no `?` — required
  description?: string;
  websiteUrl?: string;
}
```

There is **no format constraint** — it is a free string, not validated as semver.

But in `2026-07-28` the identity object itself moved into `_meta` and became optional
(`"io.modelcontextprotocol/serverInfo"?: Implementation`), with the spec explicitly forbidding behavioural
use:

> The value is self-reported by the server and is not verified by the protocol. It is intended for display,
> logging, and debugging. Clients **SHOULD NOT** use it to change their behavior, and **SHOULD NOT** rely
> on it for security decisions.

The mirrored language applies to `clientInfo`. In `2025-06-18` both `clientInfo` and `serverInfo` were
required members of `InitializeRequest.params` / `InitializeResult`.

**Verdict: required-when-present, unvalidated, and the spec instructs implementers not to branch on it.**

### 2.3 Capability-level versions — none

Verified directly against the `2026-07-28` schema. `Tool`, `Resource`, and `Prompt` all extend
`BaseMetadata` (`name` + optional `title`) and carry no version:

- `Tool`: `description?`, `inputSchema`, `outputSchema?`, `annotations?`, `_meta?`
- `Resource`: `uri`, `description?`, `mimeType?`, `annotations?`, `size?`, `_meta?`
- `Prompt`: `description?`, `arguments?`, `_meta?`

A grep of the whole 98 KB schema finds exactly one `version:` field — `Implementation.version` at line 980.
There is no per-tool compatibility range and no way for a capability to declare a protocol floor.

The nearest granular mechanism is **extension negotiation**: `capabilities.extensions` maps reverse-DNS
extension IDs (e.g. `io.modelcontextprotocol/tasks`, `io.modelcontextprotocol/ui`) to settings objects.
That is presence/absence, not a version range.

### 2.4 MCP Registry (`server.json`) — required, immutable, and resolved

From the [registry's server.schema.json](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/draft/server.schema.json),
`ServerDetail` has `"required": ["name", "description", "version"]`. The field description:

> Version string for this server. SHOULD follow semantic versioning (e.g., '1.0.2', '2.1.0-alpha').
> Equivalent of Implementation.version in MCP specification. Non-semantic versions are allowed but may not
> sort predictably. Version ranges are rejected (e.g., '^1.2.3', '~1.2.3', '>=1.2.3', '1.x', '1.*').

So: **required, but semver is only SHOULD.** Ranges are rejected as an error-prevention measure.

**Immutability.** The registry's
[versioning docs](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/versioning.mdx)
state that the version "**MUST** be unique for each publication" and that "Once published, the version
string (and other metadata) cannot be changed." The
[OpenAPI spec](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml)
backs this: `PUT` and `DELETE` on `/v0.1/servers/{serverName}/versions/{version}` are both marked
"Optional… **not implemented by the official MCP registry**."

**Lifecycle, not deletion.** `PATCH …/versions/{version}/status` sets `active | deprecated | deleted` with
an optional `statusMessage` — a soft-delete, the closest thing to a yank. Registry-managed `_meta` carries
`isLatest`, `publishedAt`, `updatedAt`, `statusChangedAt`.

**`isLatest` is registry-computed, not publisher-set**, and the ordering rules have documented traps: a
non-semver version published after semver ones is still marked latest, and a prerelease published after
its regular release will *not* be.

**Package versions are separate and verified.** `Package.version` must be exact; the schema hard-bans one
literal via `"not": {"const": "latest"}`. The registry validates the package version exists upstream at
publish time against an allowlist of trusted registries (npmjs, PyPI, crates.io, Docker Hub, ghcr, …).

The registry is still labelled preview: "Breaking changes or data resets may occur before general availability."

---

## 3. Anthropic Connectors / Claude connector directory

**(a)/(b) No version field exists anywhere in the connector submission flow.** Verified against the
[submission docs](https://claude.com/docs/connectors/building/submission). The five submission requirements
are security, tool annotations (`title` plus `readOnlyHint`/`destructiveHint`), OAuth 2.0, privacy policy,
and documentation. Version is never mentioned. The eleven portal steps capture a server URL, transport,
listing copy, use cases, company details, auth mode, data handling, test credentials, and seven compliance
acknowledgments — no version string among them.

**(c) The directory tracks a live endpoint, not a versioned artifact.** From the Tools step:

> Your server's tools, prompts, and resources sync automatically from the connected server, grouped by
> whether their annotations declare them read-only or write.

Post-publication edits are editorial (tagline, description, categories, icon, support contact) and go back
through review; the URL slug is permanent. **There is no version history, no changelog, and no rollback.**
A developer shipping a breaking change to their server changes what directory users get, with no
directory-side gate. Notably this is the *opposite* design choice from OpenAI's frozen snapshot (§4.2).

The general [custom connectors article](https://support.claude.com/en/articles/11175166-about-custom-connectors-and-remote-mcp)
does not mention versioning at all; its only acknowledgement of drift is the security warning that "Server
developers may update tool behavior unexpectedly."

**One format version does exist**, on the desktop-extension path: MCPB bundles have a `manifest.json` with
`manifest_version`, referenced as "`manifest_version` 0.2+" in the privacy-policy requirements. That is a
manifest-format version, not a bundle release version.

**Claude Code `.mcp.json`: no version field, no pinning.** Entries are `{command, args, env}` or
`{type, url, headers}`. The only pinning available is incidental — baking `@1.2.3` into an `npx` command —
which is a package-manager mechanism the docs never present as version pinning.

---

## 4. OpenAI / ChatGPT

Note on doc churn: `developers.openai.com/apps-sdk/*` now 301-redirects to `developers.openai.com/plugins/*`,
and the docs say "plugin" throughout. The legacy plugin-manifest reference pages are **gone** —
`platform.openai.com/docs/plugins` redirects to a 404. Findings below are from the current
[consolidated docs corpus](https://developers.openai.com/plugins/llms-full.txt) and OpenAI's archived repos.

### 4.1 Packaged plugins (`.codex-plugin/plugin.json`) — required semver, hard-validated

This is the strongest version enforcement OpenAI has, and it is recent. From
[Build plugins](https://developers.openai.com/plugins/build/plugins): "`name`, `version`, and `description`
identify the plugin."

Validation is explicit, per the
[submission errors reference](https://developers.openai.com/plugins/deploy/submission-errors):

| Error code | Rule |
|---|---|
| `plugin_version_missing` | "`version` is required." |
| `plugin_version_wrong_type` | "`version` must be a string." |
| `plugin_version_empty` | "`version` must be a non-empty semantic-version string, such as `1.0.0`." |
| `plugin_version_not_semver` | "`version` must use semantic versioning, such as `1.0.0`." |
| `plugin_version_too_long` | "`version` must be 64 characters or fewer." |
| `plugin_version_unchanged` | "A new release must use a different manifest `version`; reusing the published version requires confirmation." |

The version is also **resolved as an install path segment** — plugins install to
`~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`, with `$VERSION` = `local` for local
plugins. Marketplace entries sourced from npm take an optional `version` that "accepts package versions,
distribution tags, and version ranges, but not path or URL selectors."

Notably, `.claude-plugin/plugin.json` is auto-converted to `.codex-plugin/plugin.json`, and the desktop app
reads a legacy-compatible marketplace at `$REPO_ROOT/.claude-plugin/marketplace.json` — the two ecosystems
are converging on one bundle shape.

**Inner capabilities: no versions.** The manifest points at `skills/`, `.mcp.json`, `.app.json`, and
`hooks/hooks.json`. There are zero `skill_version`/`mcp_version`/`hook_version` error codes in the
validation reference. The `apps` field is described as a "compatibility" field but only "points to
registered MCP server mappings" — it is not a version range.

### 4.2 Apps SDK (MCP-backed path) — versioning by review snapshot, not by number

There is no separate app manifest; the app *is* the MCP server. The only version in code is MCP's
`serverInfo.version` ([build/mcp-server](https://developers.openai.com/plugins/build/mcp-server)), and
nothing in OpenAI's docs reads, compares, or displays it. The **Scan Tools** step enumerates exactly what
it captures — tool names/titles/descriptions, schemas, security schemes, `_meta`, annotations, linked UI
resource metadata, and server `instructions` — and `serverInfo.version` is not in that list
([app review](https://developers.openai.com/plugins/deploy/app-review)).

What OpenAI versions instead is the **reviewed metadata snapshot**:

> Treat the metadata exposed by your MCP server as a versioned API contract for the plugin. When you scan
> the MCP endpoint in the plugin submission portal, OpenAI stores the discovered metadata with that draft
> version… The published plugin uses this metadata snapshot while tool calls and UI resources continue to
> use your live MCP server.

> Once your plugin is published, its submitted information and reviewed metadata snapshot are locked for
> safety. To update either, create a new draft version of the existing plugin and resubmit that version for
> review.

Constraints: one published version and one in-review version per MCP server integration. Rollback exists in
a limited form — you can swap the published pointer among *approved* versions — but not for your live
server: "If a deployment breaks the published version, roll back the server change rather than waiting for
a new version to complete review." Breaking changes to a published contract "aren't currently supported."
The MCP server origin cannot change between versions.

**Staged rollout, canary, and percentage rollout: silent** — zero occurrences across the docs corpus.
A user-facing version history or changelog is likewise not documented.

**Widgets are versioned by URI convention only.** The guidance is:

> Treat the resource URI as a cache key. When you make a breaking change to the HTML, JavaScript, or CSS,
> publish a new URI and update every tool that references it.

The documented example is `ui://project-board/v1.html`, and ChatGPT "may continue serving cached resource
contents for up to one hour." This is the closest thing in the whole survey to per-capability versioning —
but it is a substring in a URI with no schema backing, and OpenAI's own
[examples repo](https://github.com/openai/openai-apps-sdk-examples) mostly does not use it
(`ui://widget/pizza-map.html`).

**Skills are snapshot-frozen, not versioned:** "OpenAI imports skills from MCP as a submission-time
snapshot. Published plugins do not update those skills live."

### 4.3 ChatGPT enterprise connectors — frozen snapshot, no version identifiers

No version field in the connector config (endpoint URL, name, description, auth). The admin-side model is
snapshot plus manual refresh: after first approval "ChatGPT uses a 'frozen' snapshot of its available tools
and inputs. Changes made later by the app's developer are not applied until an admin reviews and publishes
an update." Enterprise/Edu admins get per-action enable/disable and a diff view on refresh — per-capability
*enablement*, not per-capability versioning. Drift handling is documented as weak: errors carry no
auto-prompt to update and admins are not proactively notified.

### 4.4 Legacy GPT Actions and plugins

**`ai-plugin.json` had `schema_version`, and never had a plugin version.** This is the clean distinction.
Recovered from OpenAI's own now-archived
[plugins-quickstart repo](https://github.com/openai/plugins-quickstart/blob/main/.well-known/ai-plugin.json),
the manifest is `schema_version`, `name_for_human`, `name_for_model`, `description_for_*`, `auth`, `api`,
`logo_url`, `contact_email`, `legal_info_url`. `schema_version` described the *manifest format* and the
only value ever observed is `"v1"`. Whether it was formally required, and its full valid-value set, lived
on a page that now 404s — **not recoverable from primary sources**, so I do not assert it.

**GPT Actions today:** the OpenAPI schema carries `info.version`, but that is OpenAPI's own field
describing your API. OpenAI's docs say ChatGPT uses the `info` block's *description* to judge relevance and
never mention consuming the version. Actions are addressed by operation ID, not version. **OpenAI-specific
enforcement of `info.version`: silent.**

**Custom GPTs have the most complete version history of any OpenAI surface** — draft autosave, explicit
Update, and a version-history menu that supports genuine restore-to-earlier-version, with the caveat that
"if you restore an older version of a GPT that uses actions, you may need to reconfigure its authentication"
([creating and editing GPTs](https://help.openai.com/en/articles/8554397-creating-and-editing-gpts)).
Versions are opaque — no developer-supplied number.

---

## 5. Cursor

Cursor versions exactly two kinds of thing: **plugin bundles** (optional semver) and **config file schemas**
(integer discriminators). Nothing else.

| Surface | Version field? | Required? | Enforced/resolved? | Inner versions? |
|---|---|---|---|---|
| Plugins `plugin.json` | **Yes, semver** | **Optional** (`name` only required) | **No** — nothing documented consumes it | No |
| `marketplace.json` | Yes (entry + `metadata.version`) | Optional | Not documented | No |
| MCP `mcp.json` | **No field documented** | — | Allowlist by command/URL pattern, never version | No |
| MCP install deeplink | **No** (`name` + base64 `config` only) | — | — | No |
| Rules `.mdc` | **No** (`description`, `globs`, `alwaysApply`) | — | Relevance truth table | No |
| Skills `SKILL.md` | **No** (`name`, `description`, `paths`, …) | — | Filesystem/GitHub discovery | No |
| Subagents | **No** | — | Git only | No |
| Extensions | Not Cursor's — docs silent on `package.json`/`engines.vscode` | — | Open VSX via `marketplace.cursorapi.com` proxy; no pinning | n/a |
| Hooks `hooks.json` | **Yes, integer** (`1`) | Default `1` | Config *schema* version | No |
| CLI `cli-config.json` | **Yes, integer** | **Listed as required** | Config *schema* version | No |

Key details, all from [cursor.com/docs](https://cursor.com/docs):

- Cursor's plugin format follows the vendor-neutral Agent Plugins standard
  (`$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`), alongside a Cursor-native
  `.cursor-plugin/plugin.json`. In both, only `name` is required; `version` is documented as
  "Semantic version (e.g., `1.0.0`)".
- **Distribution is git-branch tracking, not version resolution.** "Turn on **Enable Auto Refresh** to
  update plugins automatically whenever changes are pushed to the branch the marketplace tracks… Cursor
  re-indexes a marketplace at most once every 10 minutes, batching rapid pushes to the latest commit."
  The documented merge algorithm ("manifest values take precedence") never compares versions. The
  submission checklist requires a unique `name` and never mentions `version`.
- **MCP server updates are version-unaware.** The documented upgrade procedure is remove, `npm cache clean
  --force`, re-add ([cursor.com/docs/mcp](https://cursor.com/docs/mcp)). Cursor documents MCP *capability*
  support (Tools, Prompts, Resources, Roots, Elicitation, Apps) but no protocol revision string — **silent**
  on `2026-07-28`-style versions.
- **The VS Code engine is pinned per Cursor release**, deliberately behind upstream: "To ensure stability,
  Cursor often uses slightly older VS Code versions"
  ([migrations](https://cursor.com/docs/configuration/migrations/vscode)); "VS Code Extension API upgraded
  to v1.105.1" ([changelog 2.1](https://cursor.com/changelog/2-1)).
- **The only version-adjacent safety control gates on time, not version**: `extensions.installCooldownHours`
  lets team admins "defer extension installs and updates until a marketplace version has been published for
  a minimum number of hours" ([extensions](https://cursor.com/help/customization/extensions)).
- Compatibility is handled by silent field fallback rather than declared versions: "The legacy `globs` field
  is still accepted as a fallback for older skills, but new skills should use `paths`."
- `.cursorrules`: **docs are silent** — the legacy file is absent from current documentation entirely.

---

## 6. VS Code extensions — the mature baseline

### (a)/(b) Required, semver, and the compat range is required too

From the [extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest),
the required fields are `name`, `version`, `publisher`, and `engines`:

- `version` — "SemVer compatible version."
- `engines` — "An object containing at least the `vscode` key matching the versions of VS Code that the
  extension is compatible with. **Cannot be `*`.**"

### (c) Enforced end to end — in the tool, at the Marketplace, and on the client

**Packaging rejects non-semver outright.** `vsce`'s
[`validateVersion`](https://github.com/microsoft/vscode-vsce/blob/main/src/validation.ts) throws on a
missing version and again on `!semver.valid(version)`, and is called unconditionally from
`validateManifestForPackaging` alongside `validateEngineCompatibility`.

**Republishing the same version is rejected — client-side and server-side.**
[`publish.ts`](https://github.com/microsoft/vscode-vsce/blob/main/src/publish.ts) pre-checks
`extension.versions.some(v => v.version === manifest.version && v.targetPlatform === options.target)` and
throws "already exists", with an equivalent 409 path for the Marketplace's own rejection. `--skip-duplicate`
downgrades this to a silent no-op. Note the uniqueness key is `(version, targetPlatform)` — one version
string may be published once per platform target. Deleted versions cannot be reused, and the latest version
cannot be deleted.

**Publishing.** `vsce publish major|minor|patch` auto-increments and, in a git repo, "will also create a
version commit and tag via `npm-version`". Pre-releases use `--pre-release` with a hard constraint: "We
only support `major.minor.patch` for extension versions, `semver` pre-release tags are **not supported**…
if `1.2.3` is uploaded as a pre-release, the next regular release must be uploaded with a distinct version,
such as `1.2.4`." The documented convention is `major.EVEN_NUMBER.patch` for release and
`major.ODD_NUMBER.patch` for pre-release
([publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)).

That convention exists because **there is no channel dimension in the version string** — VS Code "will
automatically update extensions to the highest version available", so pre-release is carried out-of-band as
a VSIX manifest property rather than in the version. `vsce` even rejects the semver pre-release bump
keywords (`premajor`, `preminor`, `prepatch`, `prerelease`) as "Not supported". This is the mature baseline
solving a missing version dimension with **documented naming discipline instead of a new field**.

**`engines.vscode` gates delivery, not just install.** The mechanism is spelled out:

> If you want to publish an extension version that benefits from this API, you should indicate a version
> dependency of `^1.9.0`. In this way, your new extension version will only be available on VS Code
> `>=1.9.0`… Users with the VS Code Stable will only get the update when the Stable release reaches version
> `1.9.0`.

Insiders builds can be targeted by date tag (`^1.56.0-20210428`), and "VS Code 1.57 and later enforce the
date tag."

The grammar is **deliberately narrower than semver ranges**. `validateEngineCompatibility` accepts only
`*`, `^X.Y.Z`, `>=X.Y.Z`, or a bare `X.Y.Z` (with `x` wildcards and an optional prerelease tail). There is
no `~`, no `<`, and no compound range — **it is a floor, never an interval.** An extension cannot declare
itself incompatible with VS Code ≥ N.

**Client-side pinning and update control.** "If you want to install a specific version of an extension,
right-click the extension and select **Install Another Version**. You can then select a version from the
available list" — introduced in [v1.30](https://code.visualstudio.com/updates/v1_30) explicitly so "you can
now go back to a previous version of an extension if there are issues with the current version". The CLI
pins with `@{version}`: `--install-extension vscode.csharp@1.2.3`
([CLI docs](https://code.visualstudio.com/docs/configure/command-line)). Auto-update is on by default,
disableable globally or via `extensions.autoUpdate`, with `extensions.autoUpdateDelay` in hours; disabled
extensions are not auto-updated. `code --show-versions` lists installed versions.

**Enterprise pinning is an exact-version allowlist, not a range.** `extensions.allowed` (VS Code ≥ 1.96,
deployable org-wide via the `AllowedExtensions` policy) takes explicit version lists — "**Version ranges are
not supported, so you must list each version individually**", optionally suffixed by platform
(`"5.0.0@win32-x64"`). `"stable"` allows all stable versions while blocking pre-releases. "If you block an
extension or version that is already installed, the extension is disabled"
([enterprise extensions](https://code.visualstudio.com/docs/enterprise/extensions)).

**Where the baseline is weaker than expected:** `extensionDependencies` and `extensionPack` accept **IDs
only** — `${publisher}.${name}` — with **no version ranges**; `vsce` serializes both as flat comma-joined
ID strings. `extensions.json` recommendations are likewise bare IDs. There is no lockfile, no resolver, and
no transitive constraint solving anywhere in the ecosystem. **Claude Code's plugin dependency ranges are
strictly more expressive than VS Code's extension dependencies.**

### (d) Inner capabilities: no versions, with one instructive near-exception

Checked the full
[contribution points reference](https://code.visualstudio.com/api/references/contribution-points). Across
all 38 contribution points — `commands`, `languageModelTools`, `languageModelChatProviders`, `chatAgents`,
`chatSkills`, `chatPromptFiles`, `debuggers`, `taskDefinitions`, `mcpServerDefinitionProviders`, `views`,
and the rest — **no contribution point carries a version field.** The only `version` occurrences on the page
are the `tasks.json` format version (`"version": "2.0.0"`) and `enableForWorkspaceTypeScriptVersions`.

Two specifics worth naming: `languageModelTools` has no version and **no versioning of its `inputSchema`
either**, so a tool's contract can change shape between extension releases with nothing to signal it; and
`mcpServerDefinitionProviders` contributes only `id` and `label`. `.vscode/mcp.json` has no version field at
all, and the canonical example does not pin its `npx` package
([MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)).

**The near-exception:** the *runtime* API type `McpServerDefinition` carries an optional version. From the
[VS Code API reference](https://code.visualstudio.com/api/references/vscode-api):

> `McpHttpServerDefinition.version?: string` — Optional version identification for the server. **If this
> changes, the editor will indicate that tools have changed and prompt to refresh them.**

This is a **cache-invalidation token, not a compatibility constraint** — optional, opaque, never
range-matched, and nothing is gated on it. `LanguageModelChat.version` follows the same pattern ("Opaque
version string of the model"). It is the closest anything in this survey comes to versioning a capability
inside a bundle, and it is deliberately not a contract.

---

## 7. Cross-platform matrix

| System | Version field | Required | Format enforced | Resolution / update | Ranges | Pinning | Rollback | Inner versions |
|---|---|---|---|---|---|---|---|---|
| Claude Code plugin | `version` | ✗ | semver by convention | ✓ 5-step resolution chain; version = cache key | ✓ **plugin→plugin semver ranges, intersected** | ✓ git `sha`, npm `version`, `sha256` | ✗ (reinstall at pin) | ✗ |
| MCP protocol | `protocolVersion` | ✓ per request | `YYYY-MM-DD` | ✓ **MUST-level error, `-32022`/`400`** | ✗ (supported *set*) | n/a | n/a | ✗ |
| MCP `serverInfo` | `version` | ✓ in schema | none (free string) | ✗ **spec forbids branching on it** | ✗ | ✗ | ✗ | ✗ |
| MCP Registry | `version` | ✓ | semver = SHOULD; ranges rejected | ✓ unique + immutable; drives `isLatest` | ✗ | n/a | soft-delete via status | ✗ |
| Claude connector directory | — | — | — | live sync from server | ✗ | ✗ | ✗ | ✗ |
| OpenAI packaged plugin | `version` | ✓ | **semver, 6 error codes** | ✓ install path segment | ✓ npm ranges in marketplace entry | ✓ npm version/tag | ✗ | ✗ |
| OpenAI Apps SDK (MCP) | opaque portal version | n/a | n/a | ✓ review-gated snapshot; 1 published + 1 in review | ✗ | snapshot = pin | ✓ swap among approved | URI convention only |
| ChatGPT enterprise connector | — | — | — | frozen snapshot + manual refresh | ✗ | ✗ | ✗ | per-action enable only |
| Cursor plugin | `version` | ✗ | semver by convention | ✗ **git-branch auto-refresh** | ✗ | ✗ | ✗ | ✗ |
| VS Code extension | `version` | ✓ | **semver, `vsce` + marketplace-enforced; duplicates rejected** | ✓ auto-update to highest compatible | `engines.vscode` **host floor**; deps are IDs only | ✓ Install Another Version, `@1.2.3`, enterprise allowlist | ✓ (same UI) | ✗ (runtime MCP cache token only) |

---

## 8. Where documentation is silent

Stated explicitly rather than inferred:

- **Claude Code**: no `engines`-equivalent host compatibility field exists anywhere in the reference; host
  requirements appear only as prose and runtime error strings. No rollback command is documented.
- **Claude connector directory**: version is never mentioned in the submission flow, requirements, or
  listing management. No version history, changelog, or rollback is documented.
- **Anthropic remote-MCP / API connector docs**: silent on versioning; servers are configured by URL + auth.
- **OpenAI**: staged/gradual/canary/percentage rollout — zero occurrences across the docs corpus. A
  user-facing version history or changelog for Apps SDK plugins is not documented. Whether
  `serverInfo.version` is ever read or displayed is not stated (and it is absent from the Scan Tools list).
  OpenAI-specific enforcement of OpenAPI `info.version` is not stated.
- **Legacy `ai-plugin.json`**: whether `schema_version` was mandatory, and its full valid-value set, lived on
  a page that now 404s. Only `"v1"` survives, in an archived OpenAI repo. **Not recoverable.**
- **Cursor**: silent on `package.json`/`engines.vscode` for extensions (it inherits VS Code's, but never
  documents them). Silent on MCP protocol revision numbers. Silent on plugin version pinning, ranges, and
  conflict resolution. Silent on what happens when `hooks.json` `version` is omitted or unknown.
  `.cursorrules` is absent from current docs entirely.
- **VS Code**: the *prose docs* never state a blanket policy on republishing an identical version — the
  documented uniqueness rule is on extension *name*. The duplicate-version rejection is only visible in
  `vscode-vsce` source, not in the published docs. Likewise, the docs describe the *outcome* of an older
  client being held at the last compatible extension version, but **never document the Marketplace-side
  resolution algorithm** as a named feature, and never state what a user sees when no compatible version
  exists. Whether `engines.vscode` is re-checked at *activation* time (as opposed to install/update) is
  also not stated. Devcontainer `customizations.vscode.extensions` and Profiles are silent on `@version`
  pinning.

## 9. Inference — clearly separated from the above

These are my readings, not documented claims:

1. **Content-addressing is quietly beating author-declared versions.** Claude Code's fallback chain
   (commit SHA → SHA-256 digest → content hash), OpenAI's per-skill SHA-256 resource digests, and the MCP
   registry's upstream package verification all point the same way: systems trust computed identity over a
   string the author remembered to bump. Claude Code's own docs half-concede this by recommending the
   commit-SHA mode "for internal or actively developed plugins."

2. **The declared version's main job in these systems is to be a cache key, not a compatibility claim.**
   Claude Code says so outright. OpenAI puts it in the install path. Only VS Code's `engines.vscode` uses a
   version to answer "will this work here?" — and no agent platform has copied it.

3. **The stale-version failure mode is real and mostly unguarded.** Claude Code documents it precisely
   (declare `1.0.0`, push commits, users keep the cached copy), and mitigates it only with a validator
   warning. OpenAI's `plugin_version_unchanged` is a confirmation prompt, not a block. Cursor has no guard
   at all.

4. **Live-sync vs. frozen-snapshot is the sharper design axis than versioned vs. unversioned.** Anthropic's
   directory syncs tools live from the connected server; OpenAI freezes a reviewed metadata snapshot and
   requires a new review to change it. Neither uses a version number to mediate. The two approaches trade
   staleness against drift, and a version field is not what distinguishes them.

5. **For a system like cogwork designing its own bundle format**, the evidence favours: make `version`
   optional with a content-hash fallback (Claude Code's model, which is both the most permissive to authors
   and the hardest to get wrong), but add the one thing nobody in the agent space has — an explicit host
   compatibility range, so a bundle can refuse to load rather than fail at runtime with a string error.

---

## Sources

**Claude Code plugins**
- Plugins reference (manifest schema, version management) — https://code.claude.com/docs/en/plugins-reference
- Plugin marketplaces (marketplace.json, sources, version resolution, channels) — https://code.claude.com/docs/en/plugin-marketplaces
- Constrain plugin dependency versions (semver ranges, `--v` tags, conflicts) — https://code.claude.com/docs/en/plugin-dependencies
- Skills frontmatter (`compatibility`, `license`, no version) — https://code.claude.com/docs/en/skills
- Subagents frontmatter — https://code.claude.com/docs/en/sub-agents
- Hooks — https://code.claude.com/docs/en/hooks
- MCP in Claude Code (`.mcp.json`) — https://code.claude.com/docs/en/mcp
- Agent Skills spec — https://agentskills.io

**MCP specification**
- Versioning and compatibility (2026-07-28, per-request version, `UnsupportedProtocolVersionError`) — https://modelcontextprotocol.io/specification/latest/basic/lifecycle
- Lifecycle (2025-06-18 handshake model) — https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- Spec versioning policy — https://modelcontextprotocol.io/specification/versioning
- `schema.ts` 2026-07-28 (`Implementation.version`, `serverInfo` disclaimer, Tool/Resource/Prompt) — https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
- `schema.ts` 2025-06-18 — https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts
- Schema revision list — https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema

**MCP Registry**
- `server.schema.json` (required `name`/`description`/`version`, range rejection, `latest` ban) — https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/draft/server.schema.json
- Registry versioning (uniqueness, immutability, `isLatest` ordering) — https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/versioning.mdx
- Registry OpenAPI (version endpoints, status lifecycle, optional PUT/DELETE) — https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml
- Official registry requirements — https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md
- Generic server.json — https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md

**Anthropic connectors**
- Connectors Directory submission — https://claude.com/docs/connectors/building/submission
- Managing your listing — https://claude.com/docs/connectors/building/managing-your-listing
- About custom connectors and remote MCP — https://support.claude.com/en/articles/11175166-about-custom-connectors-and-remote-mcp
- Anthropic Software Directory Policy — https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- MCPB bundle format — https://github.com/modelcontextprotocol/mcpb

**OpenAI**
- Consolidated plugins docs corpus — https://developers.openai.com/plugins/llms-full.txt
- Build plugins (`.codex-plugin/plugin.json`, install cache path, npm ranges) — https://developers.openai.com/plugins/build/plugins
- Submission errors (`plugin_version_*` codes) — https://developers.openai.com/plugins/deploy/submission-errors
- Plugin submission (draft/review/publish, one published + one in review) — https://developers.openai.com/plugins/deploy/submission
- App review (metadata snapshot, locked versions, change table, 1-hour cache) — https://developers.openai.com/plugins/deploy/app-review
- Build MCP server (`serverInfo`, URI versioning checklist) — https://developers.openai.com/plugins/build/mcp-server
- ChatGPT UI / widget bridge — https://developers.openai.com/plugins/build/chatgpt-ui
- App guidelines — https://developers.openai.com/plugins/app-guidelines
- Apps SDK examples repo — https://github.com/openai/openai-apps-sdk-examples
- Archived `ai-plugin.json` (`schema_version: "v1"`) — https://github.com/openai/plugins-quickstart/blob/main/.well-known/ai-plugin.json
- GPT Actions getting started (OpenAPI `info.version`) — https://developers.openai.com/api/docs/actions/getting-started
- Configuring actions in GPTs — https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts
- Creating and editing GPTs (version history, restore) — https://help.openai.com/en/articles/8554397-creating-and-editing-gpts
- Developer mode and MCP apps in ChatGPT (frozen snapshot) — https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

**Cursor**
- Plugins — https://cursor.com/docs/plugins
- Plugins reference (manifest fields, required vs optional) — https://cursor.com/docs/reference/plugins
- MCP (`mcp.json` schema, capability matrix, update procedure) — https://cursor.com/docs/mcp
- MCP install links (deeplink params) — https://cursor.com/docs/mcp/install-links
- Rules — https://cursor.com/docs/rules
- Skills — https://cursor.com/docs/skills
- Subagents — https://cursor.com/docs/subagents
- Hooks (`hooks.json` `version`) — https://cursor.com/docs/hooks
- CLI configuration (`cli-config.json` required `version`) — https://cursor.com/docs/cli/reference/configuration
- Extensions (Open VSX proxy, install cooldown) — https://cursor.com/help/customization/extensions
- VS Code migration / engine pinning — https://cursor.com/docs/configuration/migrations/vscode
- Changelog 1.2 and 2.1 — https://cursor.com/changelog/1-2, https://cursor.com/changelog/2-1
- Agent Plugins standard — https://agent-plugins.org

**VS Code**
- Extension manifest reference (required fields, `engines.vscode`, dependencies) — https://code.visualstudio.com/api/references/extension-manifest
- Publishing extensions (auto-increment, pre-release rules, compatibility gating, unpublish) — https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Extension Marketplace (Install Another Version, auto-update, `--show-versions`) — https://code.visualstudio.com/docs/configure/extensions/extension-marketplace
- Contribution points reference (no per-contribution versions) — https://code.visualstudio.com/api/references/contribution-points
- VS Code API reference (`McpServerDefinition.version`, `LanguageModelChat.version`) — https://code.visualstudio.com/api/references/vscode-api
- MCP servers in VS Code (`.vscode/mcp.json`, no version field) — https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- Language model tools guide (`languageModelTools`, unversioned `inputSchema`) — https://code.visualstudio.com/api/extension-guides/ai/tools
- Manage extensions in enterprise environments (`extensions.allowed`, exact versions only) — https://code.visualstudio.com/docs/enterprise/extensions
- Command line interface (`--install-extension ext@1.2.3`, `--show-versions`) — https://code.visualstudio.com/docs/configure/command-line
- v1.30 release notes (Install Another Version) — https://code.visualstudio.com/updates/v1_30
- `vscode-vsce` validation (`validateVersion`, `validateEngineCompatibility`) — https://github.com/microsoft/vscode-vsce/blob/main/src/validation.ts
- `vscode-vsce` publish (duplicate-version rejection, `--skip-duplicate`) — https://github.com/microsoft/vscode-vsce/blob/main/src/publish.ts
- `vscode-vsce` packaging (pre-release gating, dependency serialization) — https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts
