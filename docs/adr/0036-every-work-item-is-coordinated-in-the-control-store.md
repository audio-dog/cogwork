# 0036 — Every Work item is coordinated in the Control store

- **Status:** accepted
- **Date:** 2026-11-03
- **Supersedes:** ADR [0003](./0003-work-source-as-coordination-substrate.md)
- **Amends:** ADR [0033](./0033-work-items-without-a-tracker-are-coordinated-in-the-control-store.md),
  engine ADR [0002](../../packages/engine/docs/adr/0002-restart-recovery-resumes-sessions.md)

## Context

ADR 0003 kept Claims, Attempt records, and Handback records on the ticket, and ADR 0033 kept that for
tracker items while engine-minted items moved to the Control store. The tracker adapter that
implemented ADR 0003 was the fixed pipeline's comment ledger: role labels, stage markers, the claim
label, and `Reclassify` all wrote through it. The cut-over ([#823](https://github.com/taylorfsteele/cogwork/issues/823))
deletes that pipeline, and with it the only writer of tracker-side coordination.

## Decision

- **The Control store is the one coordination authority for every Work item**, tracker items
  included. The `Coordination` module still dispatches on the `WorkItemRef`, but every kind resolves
  to the Control store authority: the same Claim, Attempt record, Handback record, park, and source
  revision rows, append-only per engine ADR [0011](../../packages/engine/docs/adr/0011-coordination-records-are-append-only.md).
- **The tracker carries Workflow output, not coordination.** Labels, comments, and issues the plan
  writes stay on the tracker; the origin record and write markers stay on the artifacts they mark. No
  claim label and no coordination comment is written, and none written before the cut-over is read.
- **A park tells the person on the issue.** A park record stays in the Control store. When the
  parked item is an issue, the Coordination module also posts one marked comment on it. The comment
  gives the park reason and the Attention command that continues the item. This comment is Workflow
  output for a person, not a coordination record, and the engine never reads it back. The raw failure
  behind an `exhausted` park stays in Cogwork, because the tracker can be public. A comment that
  does not post does not stop the park.
- **Restart recovery releases the Claim.** A Run left `running` by a daemon that stopped without
  draining is marked `crashed` at the next boot, its Claim is released, and the item is admitted
  again. Three crashed Runs in a row for one item park it `exhausted`.

## Considered Options

- **Keep ADR 0003 for tracker items** with a new tracker adapter that writes only Claims and records.
  Rejected: it rebuilds a marker codec, a claim label, and a second write path that nothing else
  needs, while the Control store already holds the same records for every other kind of item.
- **Hold the Claim across a restart and resume the Session**, as engine ADR 0002 decided. Rejected for
  Workflow Runs: Workflow Runs have no resume path, and the multi-daemon window that motivated holding
  the Claim cannot open while one machine-local Control store is the only authority.

## Consequences

- A daemon on another machine cannot take over an issue by reading the tracker. Accepted: the
  Control store is machine-local and single-user, as ADR 0033 already accepted for engine-minted items.
- Losing the Control store loses coordination for every item. A rename-shaped schema change moves the
  store to a backup (ADR [0015](./0015-one-control-store-with-engine-owned-migrations.md)), so open
  issues are triaged again after one. The Control store fails closed, so dispatch stops rather than
  running under a lost Claim.
- Other people on a shared tracker no longer see a claim label or retry comments. They do see a
  park notice, because a parked issue waits for a person. Before the notice, a stuck Implement Run
  for [#901](https://github.com/taylorfsteele/cogwork/issues/901) parked with no trace on the issue,
  although its Operating Instructions told the agent that the engine posts the stuck summary.
