---
name: create-patterns
description: Codify a library's idioms as agent pattern docs from real evidence, then sweep the codebase for violations and publish disjoint remediation tickets.
disable-model-invocation: true
---

# Create Patterns

One session, two artifacts: **pattern docs** agents follow, and a board of **remediation tickets** that make the codebase agree with them. The premise: agents copy whatever code they land on, so the codebase is itself a prompt — every wrong shape teaches the next agent to repeat it, every exemplar is a free instruction. The cycle raises both floors at once: the rulebook and the code it describes.

Arguments: optionally the subject (a library or framework — `effect`, `react`) and how many new patterns to produce (default 1-3). No subject given: the repo's dominant framework, especially one that already has a pattern-doc set to extend.

## Resolve the ground first

- **Pattern docs home**: the repo's existing pattern-doc directory (e.g. `docs/agent-patterns/`). The docs already in it ARE the house format — read one before writing any. No directory yet: create it, and this cycle's docs establish the format.
- **Reference corpus**: everything that counts as evidence — vendored exemplar repos (`.repos/*`), the library's own vendored source, its ai-docs/llms teaching files, local skills. Enumerate the corpus before phase 1.
- **The pinned source is the API authority.** Resolve the exact dependency version from the lockfile/catalog. Every API a doc names gets verified against that source — exemplar repos routinely pin older versions whose API names died before the pinned release. Vendored teaching files with an upstream (ai-docs on GitHub) get diffed against upstream before being cited.
- **Documented decisions bind.** Glossaries (`GLOSSARY.md`) and ADRs that touch a candidate pattern are constraints the doc must honor, not defects to fix. A deliberate looseness stays; the doc targets what drifts around it.

## Phase 1 — Survey the gap

Fan out two read-only background agents:

1. **Repo audit**: rate the repo's own non-test source across every dimension of the subject the existing pattern docs do not already cover — none / minor / significant, with file:line evidence, 2-4 examples per dimension. Explicitly clear the dimensions that are fine, so the shortlist is trustworthy.
2. **Corpus catalog**: the recurring idioms the reference corpus demonstrates in those same dimensions, with exemplar file:line refs and notable variations between repos.

Done when: a ranked shortlist where each candidate has both a systemic in-repo gap with evidence AND rich exemplar material in the corpus. Both must hold — a gap without source material means inventing patterns rather than documenting them, and the corpus agent should say so ("no evidence base — do not write this one").

## Phase 2 — Pick the patterns

Choose the target count from the shortlist. Systemic beats one-off; **copy-risk** ranks — how likely the next agent lands on the shape and imitates it. State the picks, each with one paragraph of evidence, and what was ruled out and why. Check each pick against the documented decisions before committing.

## Phase 3 — Fact packs

One background agent per pattern gathers, before any doc writing, a **fact pack**:

- Verbatim excerpts (file:line) of the repo's anchor sites — the offenders the doc will retire and the in-repo exemplars it will canonize.
- Exemplar excerpts from the corpus.
- API verification: every API the doc will name, confirmed in the pinned source with exact name, location, and one-line signature — renames flagged loudly (the older-beta name in an exemplar repo is the classic trap).
- Any documented-decision text the doc must quote or honor.

Done when: every claim the doc will make traces to an excerpt or a verified signature. The writer works only from fact packs.

## Phase 4 — Write and review the docs

Mirror the house format from the existing docs. The two parts that carry the value:

- Each section pairs a real in-repo avoid-shape with the idiomatic replacement — code from the fact packs, and invented snippets only for shapes the repo does not have yet.
- Sources cite the pinned library source, the corpus exemplars, and the repo files — including the offenders the pattern retires, and a version-drift warning wherever an exemplar repo's API names differ from the pinned release.

Then a reviewer agent verifies every API name, call shape, and repo claim in the finished docs against the pinned source. A wrong call shape is severity-1: agents copy it verbatim. Done when: the review returns zero API or repo-claim errors, fixes applied.

Each new doc also gets one pointer line in the repo's always-loaded agent instructions (`AGENTS.md`): filename plus its trigger branches, matching the existing index. The pointer's wording is what makes agents reach the doc; a doc behind a weak pointer is a variance bug.

## Phase 5 — Sweep for violations

One background agent per pattern doc — the new ones AND every pre-existing one; the old docs have never been swept against the code that grew since they were written. Each agent reads its doc as the rulebook and hunts the repo for violations.

Each sweep also re-verifies its doc's own exemplar citations. Docs go stale, and a stale citation points agents at fixed code as the anti-pattern — the single most misleading sentence a rulebook can carry. Doc fixes land inline in this session, immediately; code fixes become tickets.

Finding contract, per finding: file:line with a short quote, the doc rule violated, the fix shape in one sentence, **every file the fix touches**, and a LOC estimate — the last two feed phase 6. Each sweep ends with a deduplicated per-file list ranked by copy-risk, plus an explicit checked-and-clean list so the next cycle skips cleared suspects.

## Phase 6 — Cut and publish tickets

Partition the findings into tickets under two hard constraints:

- **Disjoint ownership**: two tickets that may run in parallel share zero files, tests included. A shared file becomes a blocking edge or a merged ticket. Each ticket body carries a "Scope (owned files)" section so implementers stay inside their set.
- **Under ~1000 changed LOC per PR.**

Sequencing rules that follow from ownership:

- A wide refactor goes expand–contract: expand ticket first, per-surface migration tickets blocked on it, one contract ticket blocked on all migrations.
- Mechanical tail sweeps (unit constants, import forms) land last, blocked by every ticket sharing their files.
- Test-hygiene refactors sequence after the code tickets touching the same test files — code fixes stay unblocked.
- Every ticket cites the pattern doc it enforces; acceptance criteria include conformance to it.

Publish tickets via /to-tickets and follow it — including the quiz step, which presents the numbered breakdown with blocking edges for approval before anything is created. After publishing, verify with a read-back (issue count, edges).

## Session shape

- Every survey, fact-pack, sweep, and review runs as a background subagent; the main context does only selection, synthesis, doc writing, and ticket cutting.
- Phases are strictly ordered, but within a phase everything parallelizes.
- The next cycle starts from a truer floor: closed tickets, the checked-and-clean lists, and the corrected rulebook are its inputs.
