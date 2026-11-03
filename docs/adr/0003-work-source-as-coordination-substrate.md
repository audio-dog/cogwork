# 0003 — The work source is the coordination substrate

- **Status:** superseded by ADR [0036](./0036-every-work-item-is-coordinated-in-the-control-store.md)
- **Date:** 2026-07-28

## Context

The generalized orchestration daemon needs somewhere
to keep coordination state: claims ("a session is running against this ticket"), attempt
counts, and blocked markers. Two models were considered:

- **Ledger-owned coordination** — the daemon's local database is authoritative for locks and
  retries; the tracker only receives human-meaningful updates. Cleaner adapter contract,
  no plumbing writes to shared trackers, but the local DB becomes state you can lose.
- **Tracker-owned coordination** — claims and attempt records live on the
  ticket itself (labels, comment markers); the local DB is a disposable cache.

## Decision

Tickets stay the single source of truth, and the daemon keys off them. Each work-source
adapter (GitHub, Linear, …) represents claims and attempt records in that tracker's native
vocabulary. The run ledger is explicitly a disposable cache (session handles, progress
counters, budgets) that is rebuilt by reconciling against the work source.

The cost accepted with eyes open: every adapter must express coordination markers in its
tracker, including shared team trackers like Linear, and bot plumbing (retry comments, claim
labels) is visible to other humans there.

## Consequences

- The daemon is stateless-by-design: any machine with credentials can take over by reading
  the tracker. No ledger backup story is needed.
- The work-source adapter contract is wider than backlog CRUD — it must also model claim,
  release, attempt-count, and blocked semantics per tracker.
- Adapters for trackers that can't cheaply hide plumbing (e.g. Linear has no invisible
  HTML comments) must choose deliberately noisy or label-based representations.
