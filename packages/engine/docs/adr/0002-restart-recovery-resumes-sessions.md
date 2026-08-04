# A daemon restart resumes the agent session and does not count as an attempt

When the daemon stops with a run in flight, claim recovery today marks the run `failed` and records a failed **attempt** — three restarts march an item to `exhausted` → `ready-for-human`, and the next run cold-starts because the **session** is only written to `RunRecord.session` when a run finishes, even though it was streamed as a run event all along. We instead treat a restart as its own outcome rather than an outcome of the work: a graceful stop marks its runs `interrupted`, an ungraceful death is detected as a run still `running` at startup and marked `crashed`, and neither records an attempt. Both keep their **claim** and resume the persisted session (written eagerly the moment the harness emits it), while a small per-item cap on consecutive `crashed` runs still tips a genuine poison-pill to `exhausted`. Resume is machine-local, because the session lives only in this daemon's run ledger.

## Considered Options

- **Keep counting a restart as a failed attempt (today's behaviour).** Rejected: a stop the operator initiated is not an outcome of the work, yet a few restarts evict a healthy item from automation.
- **Never count restarts and drop the guard entirely.** Rejected: an item whose agent reliably kills the daemon (e.g. OOM) would resume forever. The graceful/ungraceful split lets self-inflicted stops stay free while still capping real crash-loops.
- **Salvage the session at startup from run events instead of persisting it eagerly.** Rejected: duplicates the "where is the session" logic in recovery and buys nothing a single write on the first session-id event doesn't already cover for both interrupted and crashed runs.
- **Release the claim on restart and let the item re-observe as eligible (today's recovery).** Rejected: opens a window where, in a multi-daemon future, another daemon claims the item and cold-starts it — the session is machine-local, so only the original daemon can resume. Holding the claim keeps resume where the session lives.

## Consequences

`RunStatus` gains `interrupted` and `crashed`; claim recovery splits into a resumable path (hold the claim, reschedule, resume) and the existing stale/handoff path (release, hand off). A resumed run sends a short continuation nudge rather than the full stage prompt. Because resume is machine-local, moving a workspace to a new machine loses any in-flight session — acceptable, since the run ledger is already disposable and the work source stays authoritative for coordination.
