# How mattpocock/skills is architected

Date: 2026-08-24. Primary source: [mattpocock/skills](https://github.com/mattpocock/skills) at
commit [`6654f6b`](https://github.com/mattpocock/skills/commit/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76)
(cloned and read on disk), plus the older copies installed at `~/.claude/skills/`.

**Question:** We are designing a durable *product context* document for this repo, consumed by the
AFK grilling workflow (a `griller` subagent interviews an `understudy` subagent that answers in the
maintainer's place from the repo's written record). How is Matt Pocock's collection architected, so
we can wire the new doc in the same idiom and keep the workflow repo-agnostic?

**TL;DR:** The collection is a two-layer system. A **vocabulary layer** of small model-invoked
primitives (`grilling`, `domain-modeling`, `codebase-design`, `research`, `prototype`) that other
skills call by name, and an **orchestration layer** of user-invoked skills that compose them. Every
repo-specific fact is reached through one indirection: `AGENTS.md` / `CLAUDE.md` carries an
`## Agent skills` section of one-line pointers to `docs/agents/*.md`, which a run-once user-invoked
setup skill writes from seed templates. Documents are created **lazily**, kept alive by being read
on every run of the skills that consume them and updated **inline** at the moment a decision lands,
and each document type carries an explicit bar for when it earns the right to exist. Subagents are
never defined as files: there is no `.claude/agents/` in the repo at all; a parent skill constructs
each subagent's prompt and either pastes material in or names what to go read, deliberately.

For our case the copyable idiom is exact: **product context is a soft-dependency doc, pointed at
from `AGENTS.md`, resolved by name rather than by path, written lazily, and updated inline by the
skill that resolves the decision.** This repo already does most of it: `AGENTS.md` carries the
`## Agent skills` block and `docs/agents/technical-disposition.md` is already a fourth pointer in
that block.

---

## 1. Composition topology

### 1.1 Buckets and promotion

Skills live in bucket folders, and the bucket decides distribution, not behaviour
([`CLAUDE.md`](https://github.com/mattpocock/skills/blob/6654f6b/CLAUDE.md)):

> `engineering/`: daily code work
> `productivity/`: daily non-code workflow tools
> `misc/`: kept around but rarely used, not promoted
> `in-progress/`: beta: public on purpose, feedback wanted, not shipped in the plugin
> `deprecated/`: no longer used

Only `engineering/` and `productivity/` are **promoted**: they ship in the plugin, appear in the
top-level `README.md`, and get a human-facing docs page. That is a three-place invariant the repo's
own `CLAUDE.md` states and enforces by review, not by script.

### 1.2 The one axis that actually structures the graph

The composition graph is not "core versus composite". It is **invocation**, from
[`.agents/invocation.md`](https://github.com/mattpocock/skills/blob/6654f6b/.agents/invocation.md):

> Every `SKILL.md` in this repo is a skill. The one axis that splits them is **invocation**, who can
> reach it:
>
> - **User-invoked**: reachable **only by the human typing its name**. …
> - **Model-invoked**: reachable by **model or user**. …
>
> Each harness excludes a user-invoked skill from the model's reach in its own way, so nothing but
> the human can fire it: no other skill can. A user-invoked skill may invoke model-invoked skills,
> but it can never reach another user-invoked skill.

That invariant *is* the dependency graph's type system. Leaves must be model-invoked to be
reachable; orchestrators are user-invoked because a human starts them.

The stated test for staying model-invoked:

> The test for whether a skill should stay model-invoked: _could the model usefully reach for this
> autonomously?_ (Reuse is the reason to extract a skill, not the test.)

### 1.3 The invocation mechanism

There is exactly one operative mechanism, and it is prose naming a tool:

> Dependencies are expressed as an explicit instruction to **call the Skill tool** with the named
> skill (`Call the Skill tool with "grilling"`), not deep `../other-skill/FILE.md` cross-references,
> and not a bare `/skill`-style mention left for the model to interpret. Naming the tool is what
> gets it fired: most harnesses expose skill invocation as a tool the model calls, and spelling that
> out gets a higher hit rate than dropping a `/name` into prose and hoping it's read as a command.
> Dropping the leading `/` also keeps this harness-neutral rather than less…
> ([`.agents/invocation.md`](https://github.com/mattpocock/skills/blob/6654f6b/.agents/invocation.md))

Three corollaries the repo states explicitly:

- **One skill per call.** "A step that needs two skills is two calls, not one call with two names:
  say so (`Call the Skill tool twice, for "grilling" and "domain-modeling"`)."
- **Shared reference lives inside its owning skill.** "Shared reference docs live inside the skill
  that owns them; other skills reach that material by calling the Skill tool with it, not by linking
  across folders."
- **Router prose is exempt.** "Router prose that just names skills for a human to pick from
  (`ask-matt`, bucket `README.md`s) isn't invoking anything, so it keeps `/skill`-style names as
  plain labels."

And a hard carve-out, added after the convention shipped and broke six call sites
([`.changeset/user-invoked-skill-invocation.md`](https://github.com/mattpocock/skills/blob/6654f6b/.changeset/user-invoked-skill-invocation.md)):

> This whole convention only holds when the named skill is **model-invoked**. … When a step's
> precondition is a user-invoked skill (e.g. `setup-matt-pocock-skills`), phrase it as an instruction
> for the human to act on: "tell the user to run `/setup-matt-pocock-skills`", never as a Skill tool
> call.

Within a skill folder, the second mechanism is a plain relative **file include** by markdown link
(`[ADR-FORMAT.md](./ADR-FORMAT.md)`), used only for a skill's own sibling files. The third is a
**subagent spawn**, described in prose (§4).

### 1.4 The actual graph

Every edge in the shipped set, from `grep -rn "Skill tool" skills`:

| Caller | Callee | Mechanism |
| --- | --- | --- |
| `grill-with-docs` | `grilling`, `domain-modeling` | Skill tool ×2 (its entire body) |
| `grill-me` | `grilling` | Skill tool |
| `triage` | `grilling`, `domain-modeling` | Skill tool ×2, step 4 |
| `wayfinder` | `grilling`, `domain-modeling` | Skill tool ×2, at destination-naming and as default resolution |
| `wayfinder` | `research` | Skill tool, inside a spawned subagent |
| `wayfinder` | `prototype` | Skill tool, for `wayfinder:prototype` tickets |
| `improve-codebase-architecture` | `codebase-design`, `grilling`, `domain-modeling` | Skill tool, three separate steps |
| `tdd` | `codebase-design` | Skill tool, when interface shape is in question |
| `retro` (in-progress) | `writing-for-agents` | Skill tool, step 1 |
| `setup-ts-deep-modules` (in-progress) | `codebase-design` | Skill tool |
| `implement` | `tdd`, `code-review` | **bare `/tdd`, `/code-review` prose** (not yet migrated) |
| `code-review` | Standards + Spec reviewers | subagent spawn, prompts built inline |
| `codebase-design` → `DESIGN-IT-TWICE.md` | 3+ interface designers | subagent spawn, briefs built inline |
| `improve-codebase-architecture` | codebase walker | subagent spawn |
| `grilling` | fact-finder | subagent spawn, ad hoc per question |

**Leaves (model-invoked primitives, called by others, call nobody):**
`grilling`, `domain-modeling`, `codebase-design`, `research`, `prototype`, `writing-for-agents`,
`wizard`, `resolving-merge-conflicts`, `diagnosing-bugs`.

**Orchestrators (user-invoked, compose leaves):**
`grill-with-docs` (the thinnest possible composite: two Skill tool calls and nothing else),
`grill-me`, `triage`, `wayfinder`, `improve-codebase-architecture`, `implement`, `to-spec`,
`to-tickets`.

**Router (names skills, fires none):** `ask-matt`.
**Precondition (user-invoked, called by nobody, only named to the human):** `setup-matt-pocock-skills`.

`ask-matt` describes the whole thing as one main flow plus on-ramps
([`ask-matt/SKILL.md`](https://github.com/mattpocock/skills/blob/6654f6b/skills/engineering/ask-matt/SKILL.md)):
`grill-with-docs → to-spec → to-tickets → implement → code-review`, with `triage`,
`diagnosing-bugs`, and `wayfinder` merging on, and:

> Two model-invoked references that run *beneath* the other skills, each the single source of truth
> for its vocabulary.

`CLAUDE.md` makes keeping the router honest a maintenance obligation:

> whenever you add, rename, remove, or change how a user-reachable skill fits the flows, re-read
> `ask-matt`'s `SKILL.md` and update it so the map stays accurate: a new skill it never mentions, or
> a stale one it still routes to, is a router that lies.

**Copy this.** The thin-composite shape (`grill-with-docs` is literally one line) is the cheapest way
to give a human a memorable entry point over primitives, at zero context cost. Our `/grill-afk` is
the same object: an orchestrator over primitives, and its subagents should reach shared material by
name, not by path.

---

## 2. The doc-writing convention

### 2.1 Catalogue of every document type the collection knows how to write

| Document | Owner (creates) | Readers | On disk | Eager or lazy | Update trigger |
| --- | --- | --- | --- | --- | --- |
| `CONTEXT.md` (glossary) | `domain-modeling` | `domain.md` consumers: `to-spec`, `to-tickets`, `triage`, `tdd`, `diagnosing-bugs`, `improve-codebase-architecture`, `codebase-design`, `wait-what` | repo root, or per-context under `src/<context>/` | **lazy**: "create one when the first term is resolved" | a term is resolved, sharpened, or a new concept named. Updated **inline**, never batched |
| `CONTEXT-MAP.md` | `domain-modeling` | same set; `wait-what` follows it to the right `CONTEXT.md` | repo root | lazy, only for multi-context repos | a context is added or a relationship changes |
| ADRs `docs/adr/NNNN-slug.md` | `domain-modeling` | `to-spec`, `to-tickets`, `triage`, `tdd`, `diagnosing-bugs`, `improve-codebase-architecture` | `docs/adr/`, plus `src/<context>/docs/adr/` in multi-context repos | **lazy**: "Create the `docs/adr/` directory lazily: only when the first ADR is needed" | a decision clears the three-part bar (§6). Supersession by `Status` frontmatter |
| `docs/agents/issue-tracker.md` | `setup-matt-pocock-skills` | `to-tickets`, `to-spec`, `triage`, `code-review`, `wayfinder` | `docs/agents/` | **eager**, once per repo | re-run setup, or hand-edit ("Mention they can edit `docs/agents/*.md` directly later") |
| `docs/agents/triage-labels.md` | `setup-matt-pocock-skills` | `triage` | `docs/agents/` | eager, **and only if `triage` is installed** | hand-edit the right-hand column |
| `docs/agents/domain.md` | `setup-matt-pocock-skills` | every engineering skill, as the consumer rules for the two above | `docs/agents/` | eager | re-run setup |
| `## Agent skills` block | `setup-matt-pocock-skills` | every agent, always loaded | `CLAUDE.md` or `AGENTS.md` | eager | "If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate" |
| Spec | `to-spec` | `implement`, `code-review` (Spec axis) | the configured issue tracker (a GitHub issue, or `.scratch/<feature>/spec.md`) | on demand | none stated: written once, superseded by the next spec |
| Tickets | `to-tickets` | `implement`, `wayfinder` | tracker issues, or `.scratch/<feature-slug>/issues/<NN>-<slug>.md` | on demand | none stated |
| Agent brief (comment) | `triage` | AFK implement agents | a comment on the issue/PR | on `ready-for-agent` | rewritten on re-triage |
| `.out-of-scope/<concept>.md` | `triage` | `triage` itself, every subsequent run | `.out-of-scope/` at repo root | lazy, on the first rejection of that concept | **appended** on every repeat request; **deleted** if the maintainer reconsiders |
| Research notes | `research` | whoever asked; fed into `grill-with-docs` | "where the repo already keeps such notes; match the existing convention" | on demand | none stated |
| Wayfinder map | `wayfinder` | every session on that map | one tracker issue labelled `wayfinder:map` | on charting | **every ticket resolution** appends to Decisions-so-far and clears graduated fog |
| Handoff doc | `handoff` | the next agent | "the temporary directory of the user's OS - not the current workspace" | on demand | never: single-use |
| Architecture report | `improve-codebase-architecture` | the human, once | `<tmpdir>/architecture-review-<timestamp>.html`, "so nothing lands in the repo" | on demand | never: fresh file per run |
| Questionnaire | `to-questionnaire` | a human recipient | `to-questionnaire-<slug>.md` in the cwd | on demand | never |
| Wizard script | `wizard` | a human, once | scratch or `scripts/` | on demand | "ephemeral by default … Commit it only when the user wants a repeatable setup path" |
| Prototype | `prototype` | the spec, later | a `prototype/<name>` branch out of main, linked from the issue | on demand | never: kept as a **primary source**, not maintained |
| Teaching workspace (`MISSION.md`, `learning-records/`, `RESOURCES.md`, `NOTES.md`, `reference/`, `lessons/`, `assets/`) | `teach` | `teach`, next session | the cwd as a stateful workspace | lazy per file | mission change writes a learning record; supersession marks the old record |
| Docs page `docs/<bucket>/<skill>.md` | the repo's own `.agents/writing-docs.md` | humans on aihero.dev | `docs/engineering/`, `docs/productivity/` | eager per promoted skill | "Act whenever a promoted skill is added, renamed, or has its behaviour changed" |

### 2.2 The pattern for keeping a doc alive

Four distinct mechanisms, and they are worth naming separately because we need all four.

**(a) Read-on-every-run, by a pointer the consumers share.** The reason `CONTEXT.md` does not rot is
that `docs/agents/domain.md` tells every engineering skill to read it before exploring, and to use
its words:

> When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
> test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary
> explicitly avoids.
>
> If the concept you need isn't in the glossary yet, that's a signal: either you're inventing
> language the project doesn't use (reconsider) or there's a real gap (note it for
> `/domain-modeling`).
> ([`setup-matt-pocock-skills/domain.md`](https://github.com/mattpocock/skills/blob/6654f6b/skills/engineering/setup-matt-pocock-skills/domain.md))

A doc nothing reads is a doc nothing maintains. Liveness comes from being **load-bearing on every
run**, not from a review cadence.

**(b) Write-inline, never batched.** `domain-modeling`:

> When a term is resolved, update `CONTEXT.md` right there. Don't batch these up: capture them as
> they happen.

`improve-codebase-architecture` restates it as a set of trigger questions inside its grilling loop:

> - **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md`.
>   Create the file lazily if it doesn't exist.
> - **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there.
> - **User rejects the candidate with a load-bearing reason?** Offer an ADR…

**(c) Contradiction is surfaced, not silently overridden.** Also from `domain.md`:

> If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:
>
> > _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

`improve-codebase-architecture` adds the discipline of not crying wolf: "only surface it when the
friction is real enough to warrant revisiting the ADR. … Don't list every theoretical refactor an ADR
forbids."

**(d) Append-and-supersede rather than rewrite.** Three worked examples:

- `.out-of-scope/` is "One file per **concept**, not per issue", accumulating a `## Prior requests`
  list; on reconsideration "Delete the `.out-of-scope/` file", and old issues are left alone because
  "they're historical records".
- Learning records mark `Status: superseded by LR-NNNN` rather than being deleted, because "The
  history of how understanding evolved is itself useful signal."
- The wayfinder map is "an **index**, not a store … a decision lives in exactly one place, its
  ticket, so the map never restates it, only gists it and links."

The counter-pattern is equally explicit. Docs the collection deliberately **abandons** go to the OS
temp dir (`handoff`, the architecture HTML report) or to an out-of-main branch (`prototype`). Where
a doc is single-use, the skill says where it goes *so it never lands in the repo*.

### 2.3 The anti-duplication rule

Two skills state it in the same words. `handoff`:

> Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits,
> diffs). Reference them by path or URL instead.

`implement-spec`:

> Communication to and from subagents should be sparse. Communicate primarily through **context
> pointers**: to the spec, tickets, research notes, and previous commits.

And `writing-for-agents` gives it a name and a test:

> The **environment** is a source of truth too (`package.json` scripts, config files, the directory
> layout, `--help` output), and a document that restates it is a **cache**: a copy of a lookup,
> earning its load only when the lookup is expensive. Cache what the agent cannot find by looking:
> the unwritten convention, the reason behind a choice, the gotcha no config confesses.

**Copy this.** That last sentence is the single best test for what belongs in a product-context doc:
the unwritten trajectory, the reason behind a choice, the gotcha. Not anything an agent could derive
by reading the code.

---

## 3. Repo-agnosticism mechanics

### 3.1 The indirection, in full

The mechanism is a fixed **three-hop** chain, and every hop is quotable.

**Hop 1: the always-loaded pointer.** `setup-matt-pocock-skills` writes into whichever of
`CLAUDE.md` / `AGENTS.md` already exists:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout: "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

The file-selection rule is stated as a hard invariant:

> - If `CLAUDE.md` exists, edit it.
> - Else if `AGENTS.md` exists, edit it.
> - If neither exists, ask the user which one to create; don't pick for them.
>
> Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa); always edit the one
> that's already there.

**Hop 2: the config doc at a fixed path**, `docs/agents/<name>.md`, written from a seed template that
ships inside the setup skill folder (`issue-tracker-github.md`, `issue-tracker-gitlab.md`,
`issue-tracker-local.md`, `triage-labels.md`, `domain.md`).

**Hop 3: skills refer to the *role*, never the value.** Skills speak canonical vocabulary and let the
config doc resolve it. `triage`:

> These are canonical role names. The actual label strings used in the issue tracker may differ. The
> mapping should have been provided to you. If not, tell the user to run
> `/setup-matt-pocock-skills`.

And `triage-labels.md` is a two-column mapping table whose right-hand column the user owns: "Edit the
right-hand column to match whatever vocabulary you actually use."

The same trick handles operations, not just names. `wayfinder` never says `gh`:

> **Where the map, its child tickets, blocking, and frontier queries physically live is
> tracker-specific.** The issue tracker should have been provided to you. If not, tell the user to
> run `/setup-matt-pocock-skills`. Consult the tracker doc's "Wayfinding operations" section for how
> _this_ repo expresses them. If no tracker has been provided, default to the local-markdown tracker.

`issue-tracker-github.md` then carries the concrete `gh api` incantations under headings that are
*named after the abstract phrase the skill uses*:

> ## When a skill says "publish to the issue tracker"
>
> Create a GitHub issue.
>
> ## When a skill says "fetch the relevant ticket"
>
> Run `gh issue view <number> --comments`.

**Copy this.** Naming the config-doc section after the sentence the caller says is a very cheap,
very reliable dispatch mechanism. It survives rewording better than a path reference does.

### 3.2 Hard versus soft dependency

The most transferable rule in the whole repo, from
[`.agents/adr/0001`](https://github.com/mattpocock/skills/blob/6654f6b/.agents/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md):

> - **Hard dependency** (`to-tickets`, `to-spec`, `triage`): include an explicit one-liner: _"…
>   should have been provided to you; run `/setup-matt-pocock-skills` if not."_ Without the mapping,
>   output is wrong, not just fuzzy.
> - **Soft dependency** (`diagnose`, `tdd`, `improve-codebase-architecture`): reference "the
>   project's domain glossary" and "ADRs in the area you're touching" in vague prose only. If the
>   docs aren't there, the skill still works; output is just less sharp.
>
> The split keeps soft-dependency skills token-light and avoids cargo-culting the setup pointer into
> places where it isn't load-bearing.

Soft dependencies are also required to be **silent** when the doc is missing, which is what stops
every session opening with a nag:

> If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
> creating them upfront. (`domain.md`)

### 3.3 Setup as a prompt-driven interview, not a script

> This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm
> with the user, then write.

Its exploration list is the discovery contract, and it is worth reading as a template for any
setup skill we write:

> - `git remote -v` and `.git/config`: is this a GitHub repo? Which one?
> - `AGENTS.md` and `CLAUDE.md` at the repo root: does either exist? Is there already an
>   `## Agent skills` section in either?
> - `CONTEXT.md` and `CONTEXT-MAP.md` at the repo root
> - `docs/adr/` and any `src/*/docs/adr/` directories
> - `docs/agents/`: does this skill's prior output already exist?
> - `.scratch/`: a sign that a local-markdown issue tracker convention is already in use
> - Is the `triage` skill installed? … This decides whether Section B runs at all.
> - Monorepo signals: a `pnpm-workspace.yaml`, a `workspaces` field in `package.json`…

Two design moves inside it are worth stealing:

- **Skip a section outright when exploration already settled it.** "skip the section entirely when
  exploration already settled it (Section B when `triage` isn't installed, Section C when there's no
  monorepo)". A config question for a skill you have not installed is pure friction.
- **Lead with the recommended answer.** "Lead each section with the recommended answer so the user
  can accept it in a word."

The collection also declined to build a verify mode for it, and recorded why
([`.out-of-scope/setup-skill-verify-mode.md`](https://github.com/mattpocock/skills/blob/6654f6b/.out-of-scope/setup-skill-verify-mode.md)):

> The intended workflow is: **run `/setup-matt-pocock-skills` and tell it to verify your current
> setup.** The skill is prompt-driven, so the maintainer can scope it to a verification pass … without
> needing a separate code path.

### 3.4 The local fork proves the indirection is a real seam

`~/.claude/skills/setup-repo-config/` is a local-only variant of the setup skill that writes the
same four config files **outside the target repo**:

> The slug is derived from `git remote get-url origin`: `<owner>--<repo>` … The engineering skill
> forks resolve each config file as `~/.agents/repo-config/<slug>/<file>` first, then the repo's
> committed `docs/agents/<file>`. This skill only ever writes to the external home, never to the
> repo, and never to the repo's `AGENTS.md`/`CLAUDE.md`.

That is a two-tier resolution order layered on the upstream convention without touching any consumer
skill, which is only possible because consumers reference the doc by *role*. Note the cost it pays:
with no in-repo `AGENTS.md` pointer, discovery depends entirely on the skill knowing the resolution
order. It also adds a write-location decision to its Section C, recommending the external home "when
exploration found conflicting committed doc conventions, or when the user can't commit
skill-generated files to this repo."

### 3.5 What the collection is silent on

- **No schema, no validation, no version field** on `docs/agents/*.md`. Drift between a seed template
  and a written file is handled by re-running the setup skill conversationally, and by nothing else.
- **No mechanism for a skill to *discover* an unknown config doc.** The set of four filenames is
  hard-coded in both the setup skill and each consumer. Adding a fifth doc type means editing both
  sides. There is no "read everything under `docs/agents/`" instruction anywhere.
- **No product/roadmap document type at all.** The closest artifacts are the wayfinder map's
  `## Destination` and `## Notes` blocks, which are per-effort and live on the tracker, not in the
  repo. Our `docs/agents/technical-disposition.md` is a genuine extension of the idiom, not a copy of
  something upstream.

---

## 4. Subagent conventions

**There is no `.claude/agents/` directory in the repo.** Every `agents/` folder under `skills/` holds
exactly one file, `openai.yaml`, which is Codex UI metadata, not a subagent definition:

```yaml
interface:
  display_name: "Research"
  short_description: "Research from high-trust sources"
```

…plus, for user-invoked skills, `policy.allow_implicit_invocation: false`. The repo states the
pairing rule: "Keep the two in sync: a skill is user-invoked in both harnesses or neither."

So the collection defines **no persistent subagent files**. Every subagent is constructed inline by
the parent skill at spawn time. That is itself the repo-agnosticism strategy: there is no file that
could hard-code a repo fact.

### 4.1 How material is handed over

Both mechanisms are used, and the choice is deliberate and stated.

**Paste it in, when the subagent cannot otherwise reach it.** `code-review`:

> **Standards sub-agent prompt** should include:
>
> - The full diff command and commit list.
> - The list of standards-source files you found in step 3, **plus the smell baseline from step 3
>   pasted in full** (the sub-agent has no other access to it).

The parenthetical is the reasoning: the smell baseline lives in the parent's `SKILL.md`, which the
subagent will not load, so it must travel in the prompt. By contrast the standards-source files are
handed over as *a list of paths*, because the subagent can open those itself.

**Name what to read, when it is on disk.** `DESIGN-IT-TWICE.md`:

> Prompt each sub-agent with a separate technical brief (file paths, coupling details, dependency
> category from [DEEPENING.md](DEEPENING.md), what sits behind the seam). The brief is independent of
> the user-facing problem-space explanation in Step 1. …
>
> Include both [SKILL.md](SKILL.md) vocabulary and CONTEXT.md vocabulary in the brief so each
> sub-agent names things consistently with the architecture language and the project's domain
> language.

**Tell it to call a skill.** `wayfinder` hands its research subagents no material at all, only an
instruction: "spin up a subagent that calls the Skill tool with 'research' to resolve it in
parallel". The subagent then re-derives everything it needs, including where to save its notes.

### 4.2 Stated reasoning for using a subagent at all

Three distinct reasons appear:

- **Context isolation.** `code-review`: "Both axes run as **parallel sub-agents** so they don't
  pollute each other's context, then this skill aggregates their findings." And the aggregation rule
  guards it: "Do **not** merge or rerank findings, because the two axes are deliberately separate."
- **Not blocking the human.** `grilling`: "When a frontier question needs a fact from the environment
  … dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself.
  Don't block on it: a running exploration is an unsettled prerequisite, so only the questions
  downstream of it wait for the sub-agent to report; ask the rest of the frontier now."
- **Hiding post-completion steps across a real boundary.** `writing-for-agents`:
  "Hiding only works across a real context boundary (a hand-off or a subagent dispatch; an inline
  call leaves the later steps in context and clears nothing)."

`ask-matt`'s phase-boundary tree adds the selection rule: a subagent is the right answer when "the
task can be done AFK … scoped tightly enough to run with you away from the keyboard, no steering".

### 4.3 The rule most relevant to us

`wayfinder`'s HITL/AFK split names, and forbids, exactly the failure mode an `understudy` risks:

> Every ticket is either **HITL** (human in the loop, worked _with_ a human who speaks for
> themselves) or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live
> exchange; the agent never stands in for the human's side of it (**a grilling agent that answers its
> own questions has broken this**).

Our `griller`/`understudy` pair is a deliberate, eyes-open violation of that rule, which is precisely
why the understudy's answers must be **cited to the written record**. That is the design constraint
`docs/agents/technical-disposition.md` already encodes ("Cite what you resolve from … An answer that
no source entails is not wrong, but it is a weaker kind of answer and must be marked as one"). The
product-context doc's job is to widen the set of questions the understudy can honestly cite.

---

## 5. Frontmatter and description conventions

### 5.1 Fields actually in use

Across all 37 `SKILL.md` files, exactly four keys appear:

| Field | Used by | Notes |
| --- | --- | --- |
| `name` | all | matches the folder name |
| `description` | all | see below; quoted only when it contains a `:` (there is a changeset, `fix-yaml-frontmatter-colons.md`, for exactly that bug) |
| `disable-model-invocation: true` | all user-invoked skills (22 of 37) | never set to `false`; omitted for model-invoked |
| `argument-hint` | `handoff`, `claude-handoff`, `teach`, `loop-me` | e.g. `argument-hint: "What would you like to learn about?"` |

**No `tools:`, no `allowed-tools:`, no `skills:`, no `model:`, no `license`, no `version`.**
Dependencies are prose, not frontmatter. The collection is silent on tool restriction entirely.

### 5.2 The description convention

The description's job is defined by invocation mode
([`SKILL-MECHANICS.md`](https://github.com/mattpocock/skills/blob/6654f6b/skills/productivity/writing-for-agents/SKILL-MECHANICS.md)):

> - A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously … The
>   description is the skill's top-level context pointer, forced to stay loaded at all times:
>   permanent context load in exchange for discoverability. … Mechanics: omit
>   `disable-model-invocation`, and write a model-facing description carrying the trigger branches…
> - A **user-invoked** skill strips the description from the agent's reach … Zero context load, but
>   it spends cognitive load: you are the index that must remember it exists. Mechanics: set
>   `disable-model-invocation: true`; the `description` becomes human-facing: a one-line summary,
>   trigger lists stripped.

The observable convention, from `writing-for-agents`'s **context pointer** section:

> A pointer does two jobs: state what the material is, and list the **branches** that should trigger
> reaching it (a branch is a distinct case the document handles, so different runs take different
> paths through it). Every word of an always-loaded pointer costs on every turn, so it earns even
> harder pruning than the body:
>
> - **Front-load the leading word**: the pointer is where it does its triggering work.
> - **One trigger per branch.** Synonyms that rename a single branch are one branch written twice;
>   collapse them and keep only genuinely distinct branches.
> - **Cut identity the body already carries.**

You can see the rule applied and then re-applied. Model-invoked descriptions are `<what it does>.
Use when <branch>, <branch>, or <branch>.`:

> `diagnosing-bugs`: Diagnosis loop for hard bugs and performance regressions. Use when the user says
> "diagnose"/"debug this", or reports something broken/throwing/failing/slow.

And `domain-modeling`'s description was deliberately rewritten toward concrete artefacts
([`.changeset/domain-modeling-trigger-context-adr.md`](https://github.com/mattpocock/skills/blob/6654f6b/.changeset/domain-modeling-trigger-context-adr.md)):

> trigger on discussing codebase terminology and on writing or editing a CONTEXT.md or an ADR
> directly, replacing the narrower "pin down domain terminology or a ubiquitous language" / "record
> an architectural decision" phrasing. Also drops the "another skill needs to maintain the domain
> model" caveat, since that's the invoking skill's job to state explicitly, not this description's.

Note the last clause: **the caller states the dependency, not the callee's description.** Our locally
installed `domain-modeling` still carries the old, superseded phrasing (§7).

User-invoked descriptions are bare one-liners with no triggers at all: `wait-what`: "Stop. That last
message did not land: re-pitch it."

### 5.3 Related writing levers worth naming

`writing-for-agents` is the collection's densest document and three of its levers bear directly on a
context doc:

- **The two loads.** "**Context load** is the cost of always-loaded material … **Cognitive load** is
  the cost on the human: which documents exist and when to reach for each. The human is the index."
- **Leading words.** "A **leading word** is a compact concept already living in the model's
  pretraining that the agent thinks with while running the document (_lesson_, _fog of war_, _tracer
  bullets_). … a made-up word recruits no priors: you pay in definition tokens what a pretrained word
  gives free; reach for an existing word first."
- **Negation is a failure mode.** "steering by prohibition drags the forbidden behaviour into context
  and makes it _more_ available … Prompt the **positive**."
- **Completion criteria have clarity and demand.** "'Every modified model accounted for' forces
  thorough work where 'produce a change list' does not."

---

## 6. How a document earns the right to exist

Every document type in the collection carries an explicit bar. Collected:

**ADR: the three-part bar** ([`ADR-FORMAT.md`](https://github.com/mattpocock/skills/blob/6654f6b/skills/engineering/domain-modeling/ADR-FORMAT.md)):

> 1. **Hard to reverse**: the cost of changing your mind later is meaningful
> 2. **Surprising without context**: a future reader will look at the code and wonder "why on earth
>    did they do it this way?"
> 3. **The result of a real trade-off**: there were genuine alternatives and you picked one for
>    specific reasons
>
> If a decision is easy to reverse, skip it: you'll just reverse it. If it's not surprising, nobody
> will wonder why. If there was no real alternative, there's nothing to record beyond "we did the
> obvious thing."

…with a seven-item "What qualifies" list (architectural shape, integration patterns, lock-in
technology choices, boundary and scope decisions, deliberate deviations, constraints not visible in
the code, non-obvious rejected alternatives) and the note that "The explicit no-s are as valuable as
the yes-s."

**ADR format bar: one paragraph is enough.** "That's it. An ADR can be a single paragraph. The value
is in recording *that* a decision was made and *why*, not in filling out sections."

**`CONTEXT.md`: a project-specificity test**
([`CONTEXT-FORMAT.md`](https://github.com/mattpocock/skills/blob/6654f6b/skills/engineering/domain-modeling/CONTEXT-FORMAT.md)):

> **Only include terms specific to this project's context.** General programming concepts (timeouts,
> error types, utility patterns) don't belong even if the project uses them extensively. Before
> adding a term, ask: is this a concept unique to this context, or a general programming concept?
> Only the former belongs.

…plus a purity rule from the skill itself: "`CONTEXT.md` should be totally devoid of implementation
details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation
decisions. It is a glossary and nothing else."

**`.out-of-scope/`: durability, and a hard exclusion**
([`OUT-OF-SCOPE.md`](https://github.com/mattpocock/skills/blob/6654f6b/skills/engineering/triage/OUT-OF-SCOPE.md)):

> The reason should be durable. Avoid referencing temporary circumstances ("we're too busy right
> now"); those aren't real rejections, they're deferrals.

> Do **not** write here when something is closed as `wontfix` because it's **already implemented**.
> That's a built feature, not a rejected one; recording it would poison the dedup checks with false
> rejections.

**Learning records: an evidence bar and an explicit non-qualifying list.** Four qualifying triggers
(demonstrated understanding, disclosed prior knowledge, corrected misconception, mission shift), then:

> - Material that was merely covered. Coverage is not learning. Wait for evidence.
> - Anything already captured tersely in [[GLOSSARY.md]] as a term definition. Don't duplicate.
> - Session-by-session activity logs. Learning records are not a journal: they are decision-grade
>   insights.

**Wayfinder ticket versus fog: a statability test.**

> **Fog or ticket?** The test is whether you can state the question precisely now, _not_ whether you
> can answer it now.

…and a third bucket, **Out of scope**, separated on a different axis: "Scope, not sharpness, lands it
here."

**ADR offer discipline** (`improve-codebase-architecture`): "Only offer when the reason would actually
be needed by a future explorer to avoid re-suggesting the same thing; skip ephemeral reasons ('not
worth it right now') and self-evident ones."

**Any agent-facing document: the no-op test** (`writing-for-agents`):

> Hunt **no-ops** sentence by sentence: an instruction the model already obeys by default pays load
> to say nothing. The test (does it change behaviour versus the default?) is model-relative, not
> reader-relative: two people disagreeing about a no-op disagree about the default, and settle it by
> running the document, not by debate.

…and the named decay mode:

> Without a pruning discipline the default fate is **sediment**: stale layers that settle because
> adding feels safe and removing feels risky, until you must core down through them to find what is
> still live.

**Docs pages: a "Done when" checklist.** `.agents/writing-docs.md` ends with fifteen checkable
conditions, including an honesty bar on invented content: "the count stays honest to the evidence. A
well-discussed skill earns six; an obscure one earns one or two, or none at all. Padding a thin skill
out to match a rich one is how the section fills with questions nobody has."

**Meta-bar for existence itself** (`retro`): "Docs: use docs as references files, pointed to by other
files. **Look for existing docs before writing new ones.**"

---

## 7. Drift between upstream and `~/.claude/skills/`

Every one of the 25 installed Pocock skills differs from upstream. The local copies are dated
2026-08-05 and predate two repo-wide changes.

**(a) The em-dash purge.** Upstream removed em-dashes repo-wide
(`.changeset/remove-em-dashes-repo-wide.md`; `CLAUDE.md` now bans them). Most local/upstream diff
lines are only this. Cosmetic.

**(b) The Skill tool invocation convention. This one is behavioural.** The local copies still use
bare slash prose, which upstream explicitly identifies as unreliable:

| Local (`~/.claude/skills/`) | Upstream |
| --- | --- |
| `grill-with-docs`: "Run a `/grilling` session, using the `/domain-modeling` skill." | "Call the Skill tool twice, for \"grilling\" and \"domain-modeling\"." |
| `grill-me`: "Run a `/grilling` session." | "Call the Skill tool with \"grilling\"." |
| `wayfinder`: "Always invoke the /grilling and /domain-modeling skills." | "Always call the Skill tool twice, for \"grilling\" and \"domain-modeling\"." |
| `triage`: "run the `/grilling` and `/domain-modeling` skills together" | "call the Skill tool twice, for \"grilling\" and \"domain-modeling\"" |
| `improve-codebase-architecture`: "run the `/grilling` skill" | "call the Skill tool with \"grilling\"" |

Upstream's own changeset says why this matters:

> A skill that names another skill in prose ("run the `/grilling` skill") does not reliably cause it
> to load. **This is the documented rough edge behind `grill-with-docs`'s most-reported problem.**

`grep -rn "Skill tool" ~/.claude/skills` returns nothing. Every installed cross-skill edge is on the
unreliable mechanism.

**(c) Substantive per-skill drift** (normalised diff lines, em-dashes ignored): `wayfinder` 74,
`diagnosing-bugs` 64, `setup-matt-pocock-skills` 60, `triage` 58, `ask-matt` 46, `prototype/UI.md` 46,
`writing-for-agents` 40. Two examples with direct bearing on this work:

- **`grilling`** upstream now shows a **two-question** round template with a `---` separator between
  questions (`.changeset/grilling-add-hr-between-questions.md`). The local copy shows one question
  and says "Each question should be formatted like so". If our griller's output format was calibrated
  against the local copy, it is calibrated against a superseded template.
- **`domain-modeling`**'s description was rewritten (§5.2). Local still carries the pre-rewrite text,
  including the "when another skill needs to maintain the domain model" caveat upstream deliberately
  dropped.

**(d) Local-only skills.** `setup-repo-config` (§3.4), `grill-afk`, and a set unrelated to this
collection (`adversarial-review`, `git-master`, `improve`, `prefactor`, `react-*`, and the
`*-agent` orchestration-daemon skills).

**Upstream's own answer to drift** is `scripts/link-skills.sh`, which symlinks each skill into
`~/.claude/skills` and `~/.agents/skills` so "a `git pull` keeps installed skills current". The local
install is a copy, not a symlink, which is why it froze.

---

## 8. What this means for the product-context doc

Concretely, in the collection's idiom:

1. **Make it a `docs/agents/` doc with an `AGENTS.md` pointer.** This repo's `AGENTS.md` already has
   the `## Agent skills` block with four sub-blocks; `### Technical disposition` is already the
   fourth. A product-context doc is either a fifth sub-block or a section inside the disposition doc.
   Follow the block's existing shape: one line of summary, then `See docs/agents/<name>.md`.

2. **Refer to it by role, not by path, from the consuming skills.** `/grill-afk` and its `understudy`
   should say "the repo's product context, which should have been provided to you" and let the
   `AGENTS.md` pointer resolve it, exactly as `wayfinder` does for the issue tracker. That is the
   whole of the repo-agnosticism mechanism.

3. **Decide hard or soft, then write the pointer to match** (ADR-0001). An understudy without product
   context gives fuzzier answers, not wrong ones, so it is a **soft** dependency: vague prose, no
   setup nag, and **proceed silently** when the doc is absent.

4. **Create it lazily and update it inline.** No eager scaffold. The doc comes into existence when the
   first durable product fact is settled, and every subsequent grilling session that settles one
   appends to it in the same turn. That is `domain-modeling`'s discipline verbatim, and it is the
   only liveness mechanism in the collection that demonstrably works.

5. **Give it a bar, and write the bar into the doc.** Model it on the ADR triple. A candidate line
   earns its place when it is (a) durable rather than a deferral (`.out-of-scope/`'s test), (b) not
   derivable by reading the code (`writing-for-agents`'s cache test), and (c) load-bearing on a
   technical call the understudy would otherwise have to escalate. Add the non-qualifying list too:
   the learning-record format shows how much work an explicit "what does *not* qualify" section does.

6. **Keep the boundary with `CONTEXT.md` and ADRs sharp.** `CONTEXT.md` is a glossary and nothing
   else; ADRs are settled reversals-that-would-hurt. Product context is the third thing: **trajectory
   and priorities**, the material neither of those two is allowed to hold. Say so in the doc, or it
   will silently absorb both.

7. **Hand it to the understudy by name, not by paste.** `code-review`'s rule is the discriminator: paste
   only what the subagent cannot otherwise reach. The understudy has `Read`, so name the doc and let
   it read. That also keeps the spawn prompt free of repo-specific content, which is what makes
   `/grill-afk` portable to another repo.

8. **Fix the local invocation drift first.** If `/grill-afk` composes `grilling` or `domain-modeling`,
   write those edges as `Call the Skill tool with "grilling"`, not `/grilling`. Upstream changed this
   precisely because the slash form "does not reliably cause it to load", and our installed copies are
   all still on the old form.

**Where the collection is silent, and we must decide ourselves:** it has no product/roadmap document
type, no schema or drift check for `docs/agents/*.md`, no mechanism for a skill to discover a config
doc it was not told about, and no convention for a document read by a subagent that answers *as* a
human. Those four are ours to invent, not to copy.

---

## Sources

All paths relative to [mattpocock/skills@`6654f6b`](https://github.com/mattpocock/skills/tree/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76).

| Claim area | File |
| --- | --- |
| Buckets, promotion, router obligation, em-dash ban | `CLAUDE.md` |
| The repo's own glossary (dogfooding `CONTEXT.md`) | `CONTEXT.md` |
| Invocation axis, Skill tool convention, user-invoked carve-out | `.agents/invocation.md` |
| Hard vs soft dependency | `.agents/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md` |
| Docs-page template and "Done when" | `.agents/writing-docs.md` |
| Setup interview, `## Agent skills` block, file-selection rule | `skills/engineering/setup-matt-pocock-skills/SKILL.md` |
| Domain-doc consumer rules, proceed-silently, ADR conflict flagging | `skills/engineering/setup-matt-pocock-skills/domain.md` |
| Tracker dispatch by phrase, wayfinding operations | `skills/engineering/setup-matt-pocock-skills/issue-tracker-{github,gitlab,local}.md` |
| Role-to-label mapping table | `skills/engineering/setup-matt-pocock-skills/triage-labels.md` |
| Lazy creation, inline update, ADR three-part bar | `skills/engineering/domain-modeling/SKILL.md` |
| ADR format, numbering, what qualifies | `skills/engineering/domain-modeling/ADR-FORMAT.md` |
| Glossary format, project-specificity test, context map | `skills/engineering/domain-modeling/CONTEXT-FORMAT.md` |
| Two-axis subagent split, prompt construction, paste-vs-name | `skills/engineering/code-review/SKILL.md` |
| Parallel design subagents, brief contents | `skills/engineering/codebase-design/DESIGN-IT-TWICE.md` |
| Map/ticket/fog/out-of-scope, HITL vs AFK, tracker indirection | `skills/engineering/wayfinder/SKILL.md` |
| Triage state machine, role indirection, `.out-of-scope/` flow | `skills/engineering/triage/SKILL.md` |
| Durable briefs, no file paths or line numbers | `skills/engineering/triage/AGENT-BRIEF.md` |
| Institutional memory, dedup, durability bar | `skills/engineering/triage/OUT-OF-SCOPE.md` |
| Rounds, frontier, facts-are-the-agent's-job | `skills/productivity/grilling/SKILL.md` |
| Context pointers, two loads, information hierarchy, leading words, pruning | `skills/productivity/writing-for-agents/SKILL.md` |
| Frontmatter mechanics, router skills, splitting by invocation | `skills/productivity/writing-for-agents/SKILL-MECHANICS.md` |
| Stateful workspace, learning records as ADR analogue | `skills/productivity/teach/SKILL.md`, `LEARNING-RECORD-FORMAT.md` |
| Research output convention | `skills/engineering/research/SKILL.md` |
| Flow map, phase boundaries, vocabulary layer | `skills/engineering/ask-matt/SKILL.md`, `PHASE-BOUNDARIES.md` |
| Prototype as primary source | `skills/engineering/prototype/SKILL.md` |
| Handoff to temp dir, no duplication | `skills/productivity/handoff/SKILL.md` |
| Convention history | `.changeset/skill-tool-invocation-terminology.md`, `.changeset/user-invoked-skill-invocation.md`, `.changeset/domain-modeling-trigger-context-adr.md`, `.changeset/grilling-add-hr-between-questions.md` |
| Setup verify mode declined | `.out-of-scope/setup-skill-verify-mode.md` |

Local copies read on disk: `~/.claude/skills/*` (25 Pocock skills, snapshot 2026-08-05), plus the
local-only `~/.claude/skills/setup-repo-config/`.
