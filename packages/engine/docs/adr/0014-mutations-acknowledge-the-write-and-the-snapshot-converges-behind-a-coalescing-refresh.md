# Mutations acknowledge the write; the snapshot converges behind a coalescing refresh

Saving a workspace record took 10–15 seconds because `UpdateWorkspace` — and the contribution-setting and plugin mutations with it — awaited `submitAfterCurrent`: a full network poll of every workspace, queued behind whatever poll was already in flight, bounded only by the 30-second receipt timeout. We decided that a daemon mutation acknowledges its durable Control-store write: each handler writes, publishes from registry and store state, offers one **snapshot refresh** signal, and returns. A forked publisher worker drains the signal — a sliding queue of capacity one, so bursts coalesce — runs a reconcile that starts after the last write, and re-publishes items and workspaces. Register and deregister offer the same signal, so a new workspace gets its first poll promptly and a removed workspace's items clear without waiting for the heartbeat. The Control store is the authority a save writes; the reconcile snapshot is derived state, and derived state converges on its own ("Name the authority; derive the rest").

The shape is a convergence, not a borrow: opencode's sync events acknowledge the mutation and let projectors converge every reader, and t3code's command handlers commit events in one transaction, publish after commit, and hand follow-up work to queue-backed workers. No spec sits between them.

## Considered Options

- **Keep awaiting, but poll only the changed workspace.** Rejected: it needs a targeted-poll capability the reconcile worker does not have, it still holds the RPC for one network round trip, and the Connection and plugin mutations affect every workspace anyway.
- **Keep awaiting with a shorter timeout.** Rejected: it tunes the instance and keeps the class. The save still rides the tracker's latency, and a timeout that fires returns before convergence anyway — the same staleness this decision accepts, bought at the worst price.
- **Optimistic updates in the renderer.** Rejected: it hides the latency without removing it, the CLI would keep the full wait, and the renderer's draft mechanism already shows edited values until the daemon catches up.

## Consequences

For the seconds until the signaled reconcile lands, published classification reflects the previous config while the record is already new; the board does not mark this, matching the staleness every snapshot already has between polls. The 30-second receipt timeout stays on the publisher worker: a reconcile that overruns it publishes once prematurely and the next heartbeat corrects it. `submitAfterCurrent`'s only caller is the publisher worker; no RPC handler may await it, and a new mutation handler follows the write → publish → signal shape.
