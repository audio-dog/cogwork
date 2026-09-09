# 0013 — Two settings families, each with its own Scope set

- **Status:** accepted
- **Date:** 2026-08-24
- **Amended:** 2026-08-25 — [a Connection has no Scope](#amendment-2026-08-25--a-connection-has-no-scope), and [the first settings row collapses](#amendment-2026-08-25--the-non-executing-kinds-lose-their-setting)

## Context

ADR 0011 named four Scopes — Settings profile, Runtime host, Workspace input, Private workspace overlay — and said resolution is declared per contribution kind as a triple of *(scope set, operator, direction)*. It did not say which settings each Scope may actually hold.

The planning ticket that followed assumed the answer was "all of them": six configuration sources on one ladder, every setting available at every Scope. That model is wrong twice.

Four of the six sources are Scopes. The other two — Workflow definitions and Operation Settings — are not. A Definition is engine-authored, so it is the Engine's floor beneath every Scope; and "Operation" is a *level a setting is written at*, not a place a setting lives.

The second error mattered more. **Nobody had listed the settings.** Precedence, merge semantics, and a proposed sixth resolution operator were all being reasoned about over a set that had never been enumerated. Writing the list out ended most of the argument:

| Kind | Settings | In the file, not a setting |
|---|---|---|
| Skill | on / off | name, description, body |
| Rules | on / off | globs, always-apply flag, body |
| Command | on / off | name, description, argument contract, prompt body |
| Subagent | on / off | name, description, prompt, tool list |
| Hook | on / off | event, command |
| MCP server | on / off | command, args, env or url |

Five of six kinds have exactly one setting. The sixth has one setting and a file. This follows directly from ADR 0011's decision that the manifest points at files and nothing is inlined: content lives in the file, at whatever Scope that file sits, and no second Scope holds a rival copy to merge against.

Operation settings — on / off, harness, model, effort, permission profile, bound contributions — are a different list describing a different thing.

## Decision

**There are two settings families, and they take different Scope sets.**

| Setting | Scopes that may hold it |
|---|---|
| A contribution's on / off — Skill, Rules, Command, Subagent | Settings profile · Workspace input · Private workspace overlay |
| A contribution's on / off — Hook, MCP server | Settings profile · Private workspace overlay |
| An Operation setting | Settings profile · Private workspace overlay — plus Runtime host for `harness` only |

The empty cells are empty by decision:

- **The Runtime host holds no contributions.** It holds machine facts — checkout paths, installed harnesses, credential storage location. A Skill is not a machine fact. The one Operation setting that *is* a machine fact, which Harness is installed here, is the single exception.
- **The Workspace input holds no Operation settings.** A committed file setting `model` is a cloned repository choosing what its owner spends. A large part of the Engine's job is stopping agents from burning tokens on work they cannot do; handing that dial to the repository inverts it.
- **The Workspace input cannot enable a Hook or an MCP server.** A repository may **offer** an executable contribution — shipping the file is shipping data, which satisfies ADR 0006 — but it may never start a process on a machine belonging to someone who merely cloned it.

Supporting decisions:

- **No collective noun over either family.** They are already named: `contribution` and `Operation setting`. The invented axis name *Target* is not adopted; say *default*, *Workflow*, or *Operation*.
- **A contribution has one setting, written as a default and nowhere else.** Turning something on for one Workflow or Operation is **binding**, an Operation setting.
- **An Operation setting may be written as a default, for a Workflow, or for an Operation**, and the most specific wins *before* Scope is consulted. A default must never outrank a value that names the work.
- **On and off are the only values.** Absence is not a third value; a key that is not in the file is not `false`. `override-scalar` down the direction below, and a Scope that says nothing shadows nothing.
- **Direction, low to high:** Settings profile → Runtime host → Workspace input → Private workspace overlay. No kind inverts it.
- **Composing the set of contributions across Scopes is a `union-values`, never a merge.** Identity carries Authority, so two contributions sharing a local name are two different things. Only a single identity with settings at more than one Scope resolves, and it resolves whole.
- **Cogwork mints every Scope identity** — `Principal`, `HostId`, `WorkspaceId`, `(Principal, WorkspaceId)` — and never derives one from the environment. Checkout path is a re-binding hint only.
- **One Engine ceiling.** Engine policy constrains rather than overrides and names its source. An Operation Definition's lock on a setting *is* Engine policy, not a second mechanism.
- **The resolution trace is embedded in the Run Plan**, always, not recomputed on demand.

## Considered Options

- **One ladder, every setting at every Scope** (the ticket's premise). Rejected once the settings were listed. It produced a 4 × 3 grid of which most cells were meaningless, and it invited per-repository model selection and repository-enabled Hooks — both of which the trust model forbids.
- **Naming the two families.** Rejected on the test ADR 0011 established for "capability": a grouping noun earns its place when the group has a rule its members lack **and** no existing term names the group. The first half passes; the second fails. Every candidate also collided — *agent inputs* against the **Workspace input** Scope, *provisions* against engine ADR 0007's skill provision, *run settings* against Run and Run Plan, *execution settings* against the Harness execution boundary.
- **Per-Operation enablement of a contribution.** Rejected: it gives one Skill three overlapping states — on globally, bound to triage, off for triage — with no honest rule for which wins. Per-Operation is binding, and binding is an Operation setting.
- **Field-wise merging of a single identity's settings across Scopes**, as Codex does for MCP servers. Rejected: a configuration assembled from two files is one no person authored and no person can debug. A sixth operator, `replace-by-key`, was drafted for this distinction and dropped with the problem.
- **Inverting precedence direction per kind** to protect trust, as opencode does for `experimental.policies`. Rejected: the scope set carries trust already, and a ladder that runs different directions for different kinds cannot be explained to the person reading it.
- **Engine policy as the top Scope.** Rejected in favour of a constraining second stack: a top-layer override is indistinguishable from "you never set it", and only a named refusal is actionable.
- **Deriving Workspace identity from the git remote or the folder path.** Rejected: two clones of one remote would collide, a repository with no remote would have no identity, and moving a folder would orphan its overlay.

## Consequences

- Storage (#126) knows exactly which cells exist, and there are far fewer than a 4 × 3 grid.
- Customize (#131) has two sections, not one, and needs an offer-versus-enable row state: *this repository offers this Hook. It is off. You can turn it on.*
- A repository writing `enabled: true` for a Hook is **inadmissible, not low-precedence** — dropped with a load-time diagnostic naming the file. Never silently ignored, because an unexplained disappearance cannot be debugged; never a hard error, because a colleague's commit must not stop your work.
- Four conflict classes with three surfaces. *Inadmissible*, *dangling*, and *ambiguous* resolve at load time; only *unsatisfiable* waits for a Run and becomes a Run Plan rejection. A refusal before dispatch costs no tokens.
- A new contribution kind must be placed in a family deliberately, and must state whether a repository may enable it.
- ADR 0011's operator list loses `merge-by-key`; see its amendment.
- `Connection` was to be scoped here and deliberately was not — the concept is undefined until [#172](https://github.com/colonylabs/cogwork/issues/172) and [#125](https://github.com/colonylabs/cogwork/issues/125) land. Its glossary entry is marked provisional. Scoping a concept before defining it is how the retracted "own scope ladder" claim entered the glossary.

Full reasoning: [#134](https://github.com/colonylabs/cogwork/issues/134). Research: `docs/research/harness-config-scopes-and-rules.md`.

## Amendment (2026-08-25) — a Connection has no Scope

This ADR declined to scope `Connection`, because the concept was undefined, and named
[#172](https://github.com/colonylabs/cogwork/issues/172).

That ticket defines it, and the answer is that **a Connection has no Scope at all**. It is
machine-level and engine-owned; a workspace references one by id, and **reference is not scoping**.
The reason is this ADR's own — a cloned repository must not be able to enable executable behaviour on
your machine, and it must equally not be able to authenticate as you.

One further conflict class is confirmed rather than added: two first-party Plugins requiring one
Connection is knowable with the manifests in hand, so it is a load-time diagnostic under this ADR's
when-is-it-knowable rule. See ADR [0017](./0017-connections-are-engine-owned-and-pair-with-one-plugin.md).

## Amendment (2026-08-25) — the non-executing kinds lose their setting

ADR [0018](./0018-contribution-files-live-in-three-authoring-trees.md) gives each Scope that can hold
a contribution its own **authoring tree**, and Cogwork scans those trees. That makes the first row of
the Decision table redundant: a file's tree already says everything its on / off could say, so
**Skill, Rules, Command and Subagent have no setting at all**. They exist or they do not.

The second row stands. **MCP server** keeps its setting and keeps this ADR's scope set — Settings
profile and Private workspace overlay — so a repository may *ship* an MCP server file and only the
principal may switch it on. **Hook** is deferred: it stays a named kind, and no harness projection
for it has been designed.

Two lines above are narrowed by this:

- "Five of six kinds have exactly one setting" becomes *one of six*, pending Hook.
- "A new contribution kind … must state whether a repository may enable it" applies to the executing
  kinds only. For the rest, registering a workspace is the trust act, and every such file in its
  repository is in play.

The Operation settings family, the empty cells, and the `(scope set, operator, direction)` triple are
unchanged, as is the Connection amendment above — a Connection has no Scope and therefore no tree.

## Amendment (2026-09-09) — Codex trusts ambient Hooks for registered Workspaces

ADR [0023](./0023-codex-runs-trust-ambient-hooks.md) makes a narrow Harness exception to the original
repository-Hook prohibition. A Codex Run trusts the ambient Hooks that Codex discovers in a
registered Workspace. This does not add Hook contributions or settle their Cogwork setting model.
