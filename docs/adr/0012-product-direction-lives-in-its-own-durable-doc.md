# 0012 — Product direction lives in its own durable doc, separate from the technical disposition

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Two agent surfaces answer questions in the maintainer's absence: `/triage`, when a ticket raises a
technical open question mid-pass, and `/grill-afk`, where an understudy subagent answers a griller's
interview from what the repo has written down. Both anchor their reasoning in "where the product is
going". Until now that anchor was a fourteen-line **Product direction** section inside
`docs/agents/technical-disposition.md`, whose one substantive link pointed at
`docs/spec/next-phase.md`.

That pointer was a category error twice over. `docs/spec/` is a snapshot folder by construction —
`/to-spec` publishes to the issue tracker and leaves a repo copy, and `desktop-shell-revamp.md` says
so in its own header — so a durable document was anchored to something explicitly point-in-time.
And `next-phase.md` had already rotted: `apps/desktop`, `packages/ui`, and `packages/codex-cli` all
exist, the three mutating RPCs are in `packages/contracts/src/rpc.ts`, and the file still described
that work as the next phase. It had four commits, none of them an update for what shipped.

The rot was structural, not neglect. The document's organising unit was a numbered roadmap of
twenty-eight slices with dependency ordering — content that cannot not go stale — and its title
carried a tense.

## Decision

**`docs/agents/product.md` holds what the product is, who it is for, where it is, and where it is
going.** It is committed, sibling to the technical disposition, and neither doc restates the other:
this one says what the product *is*, the disposition says how the maintainer *decides*.

- **Membership is bounded by two tests, stated in the document's own first lines.** The
  *roadmap-turn test* — if the next three tickets all landed, would this sentence need editing? —
  and the *cache test*, from the `writing-for-agents` rule that a document restating the
  environment is a cache earning its load only when the lookup is expensive. Slices, sequencing,
  and slice-level status are barred; the document explicitly redirects "is X built yet" to the
  issue tracker.
- **Position is recorded as an epoch, not a changelog.** Claims like "there is exactly one user and
  it is the maintainer" and "nothing is publicly released" each license a default answer to a class
  of questions, and no ticket landing changes them.
- **Capabilities are named, never numbered.** Mission control, the owned runtime, the proactive
  layer. The phase numbering *was* the sequencing claim, and sequencing is what rotted.
- **Claims are cited by a bolded lead-in phrase, not a number**, so an insert never breaks a
  citation already sitting in a closed ticket.
- **The standing constraints stay in the disposition.** Principles 9, 10, and 11 are decision
  heuristics — "when you face this choice, take that branch" — which is the disposition's kind. No
  cross-links in either direction. The one migrant is *session contracts are interactive-ready*,
  which is a claim about where the product is going, not a heuristic.
- **The escalation test and the harvest destination are now the same document.** The disposition's
  line reads against `product.md`, and an answered fork about product direction is written back
  into `product.md`. They were the same file by accident of layout before; they are the same file
  by construction now, which is what stops a question escalating twice.
- **`docs/agents/` holds two kinds of doc.** *Project substance* (`product.md`,
  `technical-disposition.md`) is committed, reviewed like code, and read by humans joining the
  project. *Agent config* (`issue-tracker.md`, `triage-labels.md`) describes a role whose value
  differs per machine, and a copy under `~/.agents/repo-config/<slug>/` resolves ahead of it. Only
  the second kind may be shadowed by a local override.
- **`product.md` is a soft dependency of `/grill-afk`, with a spoken degradation.** Absent it, the
  understudy still answers, but answers that would have been ⚡ derived drop to 🤔 inferred and the
  transcript header says so. The disposition remains a hard dependency.

`next-phase.md` keeps its file as a marked, superseded snapshot; its Decision log remains the index
from an area to the ticket holding the reasoning, and is linked rather than copied.

## Considered Options

- **Expand the Product direction section in place.** Rejected: the two halves have different change
  triggers — the disposition changes when a fork is answered, product context when the world moves
  — so merging them makes the doc that must be re-read verbatim every grilling round also the doc
  that churns most.
- **Three documents (identity / current state / trajectory).** Rejected: three things to keep in
  sync, and the four questions it answers are one story.
- **A capability status table (`shipped` / `building` / `next` / `later`).** Rejected as a cache of
  a cheap lookup. Agents have issue-tracker access by construction — that is the premise of the
  system — so slice status is findable, and a table of it is maintenance debt that reads as
  authoritative while stale.
- **Build a `/product-modeling` skill now**, as the analogue of `/domain-modeling`. Deferred.
  `/domain-modeling` earned skill-hood by owning two document types across many callers, with
  judgment needed at the moment of writing. This is one document, one bar of three lines, and two
  write-triggers already attached to steps that exist. Build it when a second caller needs to
  *write* to `product.md`.
- **Seed `product.md` from a setup template.** Rejected. A placeholder-sectioned file is worse than
  no file: a soft dependency that exists but says nothing reads as a covered question and produces
  confident citations resolving to an empty heading. It is created lazily, by the first harvested
  answer that earns it.

## Consequences

- A documentation-convention decision now lives in `docs/adr/`, which previously held only product
  and architecture decisions. Nothing stated that restriction, and this decision governs what every
  future agent session cites, escalates, and writes back.
- The disposition shrinks and gains a hop. An agent answering a direction-anchored question now
  reads two files instead of one — the price of each having a single source of truth.
- Withholding the disposition from the griller while asking it to verify ⚡ citations is a defect
  this ADR does not fix but does make visible: `product.md` is deliberately given to *both* agents
  so the citation-checking instruction is at least possible against it.
