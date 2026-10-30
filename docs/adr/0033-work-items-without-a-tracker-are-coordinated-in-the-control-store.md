# 0033 — Work items without a tracker are coordinated in the Control store

- **Status:** accepted
- **Date:** 2026-10-27
- **Amends:** ADR [0003](./0003-work-source-as-coordination-substrate.md)

## Context

ADR 0003 made the issue tracker the coordination substrate: claims, attempt records, and handback
records live on the ticket, and the Run ledger is a disposable cache rebuilt from the tracker. That
holds while every Run is about a tracker item.

Workflows ([#656](https://github.com/taylorfsteele/cogwork/issues/656)) start Runs from Triggers that
have no tracker behind them — a Granola note, a Slack message, a schedule tick, a pull request no
issue links, and the child items a list-valued Operation result fans out into. Each still needs a
claim, attempt records, a handback, and the failure counters. `product.md` names the seam: "the
coordination store becomes ours when a work item has no tracker". Settled on
[#782](https://github.com/taylorfsteele/cogwork/issues/782).

## Decision

- **A Work item is the one thing a Run acts on.** An issue tracker supplies it, or the Engine mints it
  from a Trigger event. Its identity derives from an immutable source identity — a Granola `note_id`
  under its Connection, a Slack `(team_id, channel, ts)`, a `(Workflow, scheduled instant)`, or a
  parent item plus the Run and element position for a fan-out child. No author writes a key.
- **Each Work item has exactly one coordination authority.** A tracker item keeps ADR 0003 unchanged.
  An Engine-minted item is coordinated in the **Control store**, outside the Run ledger's disposable
  region, with the same Claim, Attempt record, and Handback record shapes, append-only per engine ADR
  [0011](../../packages/engine/docs/adr/0011-coordination-records-are-append-only.md).
- **One coordination interface, two adapters.** Classification, the exhaustion rule, and the handback
  barrier read coordination through one interface and never branch on where an item came from.
- **An Engine-minted item is level-triggered.** It carries the newest revision observed and the newest
  revision processed, and is eligible when the first is ahead and no claim is held. A redelivered
  event moves nothing; edits during a Run coalesce into one next Run.
- **Lineage is coordination.** Every Claim and Attempt record carries a lineage root and parent, in the
  item's own authority. The Engine writes an origin record on every artifact it creates; an event the
  daemon's actor caused on that artifact inherits its lineage, and an event a person caused starts a
  new root. A per-lineage hop cap is a fourth failure counter and takes the handback barrier at the
  one composition ADR 0011 names.

## Considered Options

- **Mint a tracker issue for every Trigger event**, so ADR 0003 stays whole. Rejected: every meeting
  and directed message would become a ticket, and `product.md` holds that a wrong ticket costs more
  trust than a missed one.
- **Keep it in the Run ledger**, as `docs/spec/next-phase.md` planned for the ingestion watermark.
  Rejected: the Run ledger is disposable because the tracker can rebuild it. Coordination for an item
  with no tracker has no other authority, so it is the state that "demonstrably cannot" be derived and
  must sit where loss stops dispatch rather than silently re-running work (ADR
  [0015](./0015-one-control-store-with-engine-owned-migrations.md)).
- **Edge-triggered Trigger events**, one Run per delivery. Rejected: redelivery and rapid edits each
  start a Run, and dedupe becomes a separate mechanism instead of a consequence of the item's state.

## Consequences

- A daemon on another machine cannot rebuild an Engine-minted item's coordination from the source
  system. That is accepted: the Control store is machine-local and single-user today, and its records
  are shaped to move behind a remote daemon with it.
- Losing the Control store loses trackerless coordination and lineage. The Control store already
  fails closed, so dispatch stops rather than re-running work under a lost claim.
- A tracker item created by a Workflow carries an Engine-written origin record on the tracker, so its
  lineage survives the way its claims do.
