# Client RPC

Part of the [Contracts (shared kernel)](CONTEXT.md) glossary.

**Query RPC / command RPC**:
The two kinds of RPC a client sends the daemon. A *query* reads daemon state and changes nothing. A *command* changes daemon state or behavior — cancel a Run, edit or publish a Workflow, or pause the scheduler. The split follows CQS/CQRS and gives the trust boundary one place to guard commands more strictly than queries. `DaemonQueries` and `DaemonCommands` are the two groups; `DaemonRpcs` is their merge.
_Avoid_: Write RPC (too narrow — a command may change behavior, like pausing the scheduler, not only write data), mutation, getter

**Principal**:
The caller behind an RPC, injected into every handler's context by one `RpcMiddleware` so no handler assumes there is no caller. A fixed local owner today — the daemon is single-user — but the seam is where a real identity lands later, and where commands get guarded more strictly than queries. A token can ride along as a request header (`authTokenHeader`); it's unread today. The Principal is server-side context, never a serialized field on a read model.
_Avoid_: User, account, session (the harness's conversation handle), token (the credential, not the caller)

**Daemon event**:
The unit a client watches on the daemon's live feed — a tagged envelope over everything a client view must react to: a harness event on a run (run activity), a work item's classification change or removal, a run summary change, a workspace's state change, the whole Control store picture, and a scheduler change. The subscription self-seeds — it opens by replaying the current state as ordinary events — so one subscription per client is the whole story; the client fans out its own views. Each seed is complete: derived state folds from the newest subscription's seed, and anything the seed does not re-state is gone. `RunActivity` is live-only on `WatchEvents`. `SeedEnd` is a subscription-control event: it carries a delivery fact, not a domain fact, and changes no derived state. The watch endpoint emits it after the seed and before the live tail; the daemon event bus never carries it.
_Avoid_: Run activity (now one kind of daemon event), notification, log line

**Board**:
The view a client folds from the daemon event stream — the current items, running runs, and workspace and scheduler state. The fold is authored once, beside the daemon event; each client runs it locally, and folding the stream from its seed yields the same picture the status query reports.
_Avoid_: Dashboard, mission control (the product surface, not this view), status (the query is `GetStatus`; the board is the folded, live form)
