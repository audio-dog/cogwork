# A daemon restart resumes the agent session and does not count as an attempt

When the daemon stops with a run in flight, claim recovery today marks the run `failed` and records a failed **attempt** — three restarts march an item to `exhausted` → `ready-for-human`, and the next run cold-starts because the **session** is only written to `RunRecord.session` when a run finishes, even though it was streamed as a run event all along. We instead treat a restart as its own outcome rather than an outcome of the work: a graceful stop marks its runs `interrupted`, an ungraceful death is detected as a run still `running` at startup and marked `crashed`, and neither records an attempt. Both keep their **claim** and resume the persisted session (written eagerly the moment the harness emits it), while a small per-item cap on consecutive `crashed` runs still tips a genuine poison-pill to `exhausted`. Resume is machine-local, because the session lives only in this daemon's run ledger.

## Considered Options

- **Keep counting a restart as a failed attempt (today's behaviour).** Rejected: a stop the operator initiated is not an outcome of the work, yet a few restarts evict a healthy item from automation.
- **Never count restarts and drop the guard entirely.** Rejected: an item whose agent reliably kills the daemon (e.g. OOM) would resume forever. The graceful/ungraceful split lets self-inflicted stops stay free while still capping real crash-loops.
- **Salvage the session at startup from run events instead of persisting it eagerly.** Rejected: duplicates the "where is the session" logic in recovery and buys nothing a single write on the first session-id event doesn't already cover for both interrupted and crashed runs.
- **Release the claim on restart and let the item re-observe as eligible (today's recovery).** Rejected: opens a window where, in a multi-daemon future, another daemon claims the item and cold-starts it — the session is machine-local, so only the original daemon can resume. Holding the claim keeps resume where the session lives.

## Consequences

`RunStatus` gains `interrupted` and `crashed`; claim recovery splits into a resumable path (hold the claim, reschedule, resume) and the existing stale/handoff path (release, hand off). A resumed run sends a short continuation nudge rather than the full stage prompt. Because resume is machine-local, moving a workspace to a new machine loses any in-flight session — acceptable, since the run ledger is already disposable and the work source stays authoritative for coordination.

## Amendment (#195): the session is its own entity, written at insert

Session is now a first-class entity with its own id, and `RunRecord.session` is a foreign key to it rather than a loose handle string. That shifts the eager write this ADR promised. Before, we wrote the harness's session id onto the run "the moment the harness emits it" — the first `session-id` event. Now the engine **mints the session when it inserts the run**, before the harness has said anything, and the run points at it from the start. Runs on the same branch (and a resumed run) share one session, so their transcript reads as one conversation.

The harness handle is a separate thing. Cursor keeps its own history and hands back an opaque id we store to resume it; that lands on the session's `handle` the moment the harness emits it, exactly as before. So "resume needs a handle" still holds — a branch run only offers itself for resume once its session has a handle — but the *engine session identity* no longer waits on the harness. Recovery threads the engine session id (the FK) so a rescheduled run continues the same session, and resolves the handle from that session when it needs to tell the harness (or a human) how to pick the conversation back up.

Sessions come in two kinds. Every session today is `opaque-handle`, because the only runner is a CLI harness. The `owned-transcript` kind is reserved for the first-party runner, whose whole conversation lives in our own run ledger — at which point `loadThread` folds the transcript straight from the events (see `SessionStore`) instead of leaning on a handle at all.
