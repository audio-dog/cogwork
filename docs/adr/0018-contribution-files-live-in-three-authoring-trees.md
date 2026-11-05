# 0018 — Contribution files live in three authoring trees, and only executing kinds carry a setting

- **Status:** accepted
- **Date:** 2026-08-25
- **Amended:** 2026-09-01 — [the private overlay tree may replace an Operating Instructions package](#amendment-2026-09-01--the-private-overlay-tree-may-replace-an-operating-instructions-package)
- **Amended:** 2026-11-05 — [a Command file is a Skill](#amendment-2026-11-05--a-command-file-is-a-skill)

## Context

[#127](https://github.com/taylorfsteele/cogwork/issues/127) asked how to migrate off today's agent input
sources. Eight were named. Giving each one a disposition was meant to be bookkeeping. It was not:
deciding *where the files land* turned up two structural answers the map had not reached, and each
one reverses an earlier decision.

The eight, as found on disk:

| Source | What it is today |
|---|---|
| `*.workspace.ts` | Three files, all committed. Only `apps/cli/config/` is the config home, so `feldspar.workspace.ts` never loads. All hold absolute personal paths. |
| Engine Operating Instructions | `packages/engine/skills/{triage,implement,follow-up}-agent`, shipped beside engine source |
| `~/.agents/skills` | 37 skills written by the external `sync` tool |
| Repository `.agents` inputs | `<repo>/.agents/skills/`, committed |
| Cursor Plugin caches | `~/.cursor/plugins/{cache,local}`, plus the repo's gitignored `.cursor/` |
| Hard-coded personal rules | One line — `implement-agent/SKILL.md:69` names an absolute path in one person's checkout |
| Provisioned `~/.cogwork` copies | `context-assembler.ts` copies a skill directory per Run into a name-keyed live path |
| External `sync` tool | `taylorfsteele/sync`, renders one asset set into Claude Code, Cursor, and Codex |

ADR 0013 enumerated one setting per contribution kind — six kinds, one on / off each. Nobody had
asked whether that setting carries information the file's own location does not. ADR 0014 made the
install record the way a Plugin's contributions enter. Nobody had asked what carries a file the
person wrote themselves, and the answer was that ADR 0016's closed act list has no way to admit one.

## Decision

### Three authoring trees and one provision root

A person authors contribution files in three trees, one per Scope that can hold them:

| Scope | Tree |
|---|---|
| Settings profile | `~/.agents/` |
| Workspace input | `<repo>/.agents/` |
| Private workspace overlay | `~/.cogwork/workspaces/<WorkspaceId>/` |

The Runtime host gets no tree; it holds machine facts, not contributions. Cogwork **scans** these
trees, and a file it finds is a contribution with `local` Authority — since ADR
[0011](./0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md)'s 2026-08-26 amendment,
qualified by the tree: `local:user`, `local:repo`, `local:private`. `~/.agents/skills` is not an
invention: Codex reads it at its user layer, Cursor uses it as its global skill directory, and
opencode reads the project form. The overlap with harness convention is `skills/` alone; the other
subdirectories are Cogwork's.

`~/.cogwork/` stays the **provision root** and takes only fetched bundle bytes, identity-keyed per
ADR 0014. Nothing a person authors is copied there, and nothing the engine provisions is authored.

**Install is for bytes that came from somewhere else.** A person installs nothing they wrote. This
is what dissolves the collision that surfaced the whole question: a Plugin absent a declared version
is identified by content revision, and [#135](https://github.com/taylorfsteele/cogwork/issues/135)
stages an update for acceptance — so a Plugin pointed at a live working directory would have turned
every save of a rule file into a pending update. An authored tree is read live and has no revision to
stage.

ADR 0016's act list is untouched. Scanning a tree is not an act; it is what makes the contribution
exist, and *set or clear a contribution's on / off* remains the only act over it.

### Presence is enablement for the four non-executing kinds

**Skill, Rules, Command and Subagent lose their setting.** They exist or they do not. The tree a file
sits in already says everything its on / off could say, so the setting carried no information. ADR
0013's first row collapses; its second row stands unchanged.

The line is *does it execute or connect*, not *is it a file*. **MCP server keeps its setting** and
keeps ADR 0013's scope set — Settings profile and Private workspace overlay — so a repository may
ship an MCP server file and only the principal may switch it on or off. That is what both reference
harnesses do: Codex leaves `mcp_servers` off its project-layer strip list and gates on *directory
trust* rather than a per-server switch, and Claude Code takes a project `.mcp.json` entry whole from
the highest-precedence source. Cogwork's trust act already exists and is `register`.

**Hook is deferred.** Every harness spells a hook differently, and no projection has been designed.
It stays a named contribution kind with its settings question unanswered, recorded as fog on the map.

ADR [0023](./0023-codex-runs-trust-ambient-hooks.md) later trusts repository Hooks that Codex finds
ambiently during a Run. Hook contribution projection and settings remain deferred.

A consequence taken knowingly: registering a workspace puts every Skill, Rules, Command and Subagent
file in its repository into your Runs. ADR 0013's "a repository may offer but never enable" narrows
to the executing kinds. Text handed to a model sits at the same trust level as the repo's
`AGENTS.md`, which Cogwork already reads ambiently.

Two trees may hold the same local name. Both reach the harness. Existing harnesses permit duplicate
skill names and leave the choice to the person, and Cogwork does the same rather than minting a
reconciliation rule. [#204](https://github.com/taylorfsteele/cogwork/issues/204) owned whether `local`
splits the person from the repository, and this decision — removing the setting that used to
distinguish two same-named files — is what sharpened it. **It has since answered yes**: the Authority
carries the tree, so two trees holding one local name are two identities, and this paragraph's
"Cogwork reconciles nothing" needs no reconciliation rule because there is nothing to reconcile. See
ADR [0011](./0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md)'s 2026-08-26 amendment.

### The Engine collects Rules and does not read them

The Engine decides *on or off*, *does the glob match*, and *where in the ladder*. It does not read the
text. Severity, contradictions, and which Subagent consults which file are the person's, not the
Engine's. So the glossary's "Rules … can never satisfy a required need or weaken Operating
Instructions" keeps its first half — a real Engine gate — and loses its second, which is a claim
about model behaviour that no Engine can enforce. Engine ADR 0007's amendment carries the same
sentence and is corrected with it.

This also settles what the engine owes a Subagent: nothing. The Engine does not wire relationships
between contributions.

### The cutover is by hand, with no importer, no window, and no rollback

Two files load, on one machine, for one person. There is no installed base, so there is no importer
and no printer: a person re-authors the workspaces through ADR 0016's acts, and the
`import()`-based loader is deleted in the same change that lands `register`. A compatibility window
would only create the drift the ticket asked us to detect. There is no rollback step — if the cutover
is wrong it is fixed forward.

Exactly one pair is ordered: the personal rules must be in `~/.agents/rules/` and reaching Runs
**before** the hard-coded path is struck from `implement-agent/SKILL.md`, or the rules reach nothing
in between. Everything else — `register`, the settings commands, deleting the loader, deleting the
three files — lands in any order.

Dispositions:

| Source | Disposition |
|---|---|
| `*.workspace.ts` and their loader | **Retired.** Fields route per ADR 0016's acts; `issueTracker`, `sourceControl`, `linearHistory`, `mcpSkills`, and all of `worktrees` become columns on the workspace record, off the Scope axis. The Workspace input has no settings file; [#332](https://github.com/taylorfsteele/cogwork/issues/332) amends the earlier split. |
| Engine Operating Instructions | **Kept as is.** Engine Authority, shipped with the binary, not a contribution and not in any tree. |
| `~/.agents/skills` | **Becomes the Settings profile tree.** Referenced where it lies, never copied. |
| Repository `.agents` inputs | **Becomes the Workspace input tree.** |
| Cursor Plugin caches | **Dropped from Cogwork's view.** Ambient to the harness only. |
| Hard-coded personal rules | **Retired.** The line is struck; the two files become `local:user` Rules in `~/.agents/rules/`. |
| Provisioned `~/.cogwork` copies | **Kept, narrowed.** Fetched bundles only, identity-keyed per ADR 0014. |
| External `sync` tool | **Out of scope.** It serves interactive sessions, which this map excludes. |

The Run Plan becomes the sole authority over **required** needs, and never over what a harness can
see. An external CLI Harness keeps reading its own stores; nothing ambient can satisfy a required
need or weaken Operating Instructions. That bound is what lets the cutover land without breaking
external CLI Harness users, and it is engine ADR 0007's amendment restated as a cutover rule rather
than a new decision.

## Considered Options

- **An importer from `*.workspace.ts` to Control store rows.** Rejected: code that must decode a
  shape only two files have, and must stay correct until it is deleted.
- **A compatibility window with both paths live.** Rejected: it needs a rule for what happens when a
  file and a row disagree, to serve one person cutting over three workspaces.
- **Keep the on / off for the repository tree alone.** Rejected: it re-splits the row this decision
  collapses, to protect against text.
- **A severity field on Rules frontmatter.** Rejected: a policy knob on a file the Engine does not
  enforce. An Operation's own gate raises a Rule to blocking, because Operating Instructions sit
  highest in the ladder.
- **A local-path Plugin for the personal rules.** Rejected once the authoring/provision split was
  drawn: it demands a manifest, an install record, and an update ceremony for consenting to your own
  typing.
- **A new tree name of Cogwork's own instead of `~/.agents/`.** Rejected: three harnesses already
  read that path, and sharing it means a Skill switched on for Runs is also present in interactive
  sessions with no copy step.

## Consequences

- **Customize stops being a settings surface for four of six kinds.** Skill, Rules, Command and
  Subagent become read-only rows showing what exists and which tree it came from. Only MCP server
  keeps a toggle, and Hook's row is undecided.
  [#131](https://github.com/taylorfsteele/cogwork/issues/131)'s prototype changes shape accordingly.
- ADR 0013 gains an amendment collapsing its first row. Its second row, its empty cells, and its
  Operation settings family are unchanged.
- ADR 0014's identity-keyed provision now has a narrower job — fetched bundles only — and
  `context-assembler.ts`'s name-keyed live copy is the gap that must close.
- Deregister deletes `~/.cogwork/workspaces/<WorkspaceId>/` alongside the rows ADR 0016 already
  cascades. The directory is keyed by the minted `WorkspaceId`, never by repo name, so it survives a
  checkout move — the case ADR 0013 kept re-binding hints for.
- `SchedulerStats.perWorkspace` stops being dishonest the day the loader dies, which is the symptom
  ADR 0016 flagged against this ticket by name.
- ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md) is undisturbed. The
  install it describes — establishing a Connection installs the Plugin that requires it — puts bundle
  bytes in the provision root and never in an Authoring tree. A Connection has no Scope and therefore no tree.
- `sync` gains a `~/.agents/rules/` target, or the two files are placed by hand. Either way `sync`
  stays the only writer to `~/.agents/`; Cogwork reads that tree and never writes it.

## Amendment (2026-09-01) — the private overlay tree may replace an Operating Instructions package

The disposition row "Engine Operating Instructions — kept as is. Engine Authority, shipped with the
binary, not a contribution and not in any tree" narrows. ADR
[0019](./0019-per-workspace-operating-instructions-overrides.md) lets a Workspace carry an
operator-authored replacement package at
`~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/`, which replaces the shipped
package whole for that operation's Runs in that Workspace.

"Not a contribution" stands: an override has no Customize row, no on / off, no Authority, and the
tree scan does not produce it — the Context assembler resolves it directly, and presence is its
whole state. "Not in any tree" is the part that falls. The deregister cascade this ADR already
records deletes the override with the rest of the overlay directory.

## Amendment (2026-11-05) — a Command file is a Skill

ADR [0037](./0037-commands-are-skills-and-subagent-files-follow-the-claude-code-shape.md) removes the
Command kind. Each tree's `commands/<name>.md` is still scanned, but as a Skill named `<name>` that
the model cannot start by itself. When the tree also has `skills/<name>/SKILL.md`, the Skill
directory wins. "Skill, Rules, Command and Subagent" above now reads "Skill, Rules and Subagent".
ADR 0037 also moves Subagent files from `subagents/` to `agents/`; that change lands separately.
