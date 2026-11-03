# Scheduler acts at most once per reconcile snapshot generation

Superseded by ADR 0015. Workflows and Trigger observation replace reconcile snapshots and generations.

The execute heartbeat ticks far faster than the reconcile worker refreshes its snapshot, and the scheduler's only guard against re-running a work item — the in-flight reservation — is released the moment a run completes. So a finished item stays `eligible` in the stale snapshot until the next reconcile, and the next tick re-claims it (this is how a single triage produced two proposals on FEL-156). We stamp each snapshot with a monotonic generation and have the scheduler act on a given work item at most once per generation, keeping the in-flight reservation only as a second guard for runs that outlive a generation boundary.

## Considered Options

- **Kick an immediate reconcile when a job completes and block re-picks until it lands.** Rejected: couples the scheduler to reconcile timing and still races if the tick fires first.
- **Re-check freshness in the executor right after claiming, aborting if a successful attempt already exists.** Rejected: a compensating guard at a third layer, plus an extra work-source read per run, to cover a window the generation guard already closes.
- **Gate `classify` on a succeeded attempt for the stage.** Rejected: duplicates the label's meaning and drags in follow-up's legitimate multi-round behaviour. `classify` is already correct given a fresh snapshot; the bug is the scheduler consuming a stale one.
- **Invert to a snapshot-push loop (plan once per new snapshot, drop the fast tick).** Rejected: the fast tick exists to fill freed concurrency slots promptly; losing it would idle capacity for up to a poll interval.

## Consequences

The scheduler now depends on the snapshot carrying a generation, and holds a small per-generation record of the work items it has acted on (pruned to items still present or in-flight, so it stays bounded).

Known limitation: if a work source ever reports a completed item as still `eligible` in a genuinely *newer* snapshot — a label write lagging a read — the per-generation record resets and the item could run again. Effectively nil for read-your-writes trackers; left documented rather than guarded, to avoid a redundant compensating layer.
