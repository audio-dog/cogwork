# 0029 — Triage owns context acquisition

- **Status:** accepted
- **Date:** 2026-09-23

## Context

The 2026-09-23 retrospective caught an implement Run whose work item did not carry its requirements:
the final UI copy and design decisions lived in chat threads and a design file. The Run spent ~15
minutes and 22 chat searches reconstructing the brief before its first edit — made worse by an
expired tracker credential — and that cost repeats on every attempt, because an implement Run starts
fresh. Triage, by contrast, runs once per work item, on the cheapest model (ADR
[0028](./0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md)), at a median of ~5
minutes.

The stage that scavenges is the wrong one. The work item and its comments are the durable brief —
the shipped instructions already say everything is reconstructable from the Issue tracker — but
nothing made triage responsible for making that true.

## Decision

Context acquisition is triage's job, done once, landed on the work item:

- **The triage proposal carries a requirements digest.** Whatever the requirement actually is —
  final copy, design node links, decisions made in chat threads — triage resolves it from the linked
  artifacts and inlines it into the proposal, so the work item becomes a self-contained brief.
- **The proposal names review requirements.** Triage flags which judgment reviews the change's shape
  demands, and the implement Run honors them. The security review is not selectable: it runs on
  every diff regardless (ADR
  [0027](./0027-headless-review-is-one-bounded-round-of-report-only-reviewers.md)).
- **Implement treats the brief as complete.** An implement Run consults chat or design systems only
  where the digest points at them, never as a search.

## Considered options

- **Implement gathers its own context** (status quo): the cost repeats per attempt, lands on the
  expensive stage, and leaves the work item unreadable for humans too.
- **A separate enrichment operation between triage and implement**: new machinery without a live
  case; triage already reads the item, its thread, and the linked systems.

## Consequences

- The shipped `triage-agent` package gains the digest and review-requirements steps; the implement
  and follow-up packages drop their scavenging affordances.
- Triage Runs get somewhat longer and need the chat and design MCP access implement used to invoke;
  the spend moves to the cheapest model and stops repeating.
- Work items become self-contained briefs, which also serves the humans reading them.
