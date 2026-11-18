# Runs

Part of the [Contracts (shared kernel)](CONTEXT.md) glossary.

**Run plan**:
The immutable, engine-validated resolution of one Operation and its Work Context. Its members, named after TanStack AI: Harness Adapter, Instructions, Messages, Work Context, Tools, Skills, MCP, Subagents, Hooks, Middleware, Sandbox (optional Workspace and Policy), Structured Output, Persistence, Connections, and Provenance. Messages contain the resolved user turn. Instructions stay separate. Work Context freezes the admitting snapshot's coordination facts and the work item's prose — its body and comment thread, read through the issue-tracker port at admission — beside the work-item reference (ADR 0030).
Run Plan members are **not** the same list as contribution kinds. Rules is a kind but not a member — it resolves into Instructions. Tools, Connections, and Middleware are members but never contributions.
Every plan carries a mandatory **provenance stamp**: a Plugin item's declared version where it has one, a content revision where it does not. No contribution carries its own version — no platform in the field versions the capabilities inside a bundle. The plan is accepted before dispatch and never changed by runtime observations.
_Avoid_: Run manifest, resolved stage, harness request, operation settings

**Run**:
One execution of one run plan by one harness, captured with its events, outcome, usage, and timings. The run records what was projected and observed without changing its plan.
A Run is `declined` when the Harness finished its work but the Engine refused the requested pull request because the pushed head was missing or not ahead of its base. The decline is an Engine outcome, records a failed coordination attempt, and releases the claim for normal retry or a park. In a Workflow the same refusal is the precondition of *Open a pull request*, checked when the engine builds the action plan.
_Avoid_: Attempt (the durable coordination form), job. Do not confuse with the harness's `RUN_STARTED` / `RUN_FINISHED` stream events, which are moments inside a run.

**Run ledger**:
The daemon's local store of runs, their immutable Run Plans, and their events — in-memory, or a region of the Control store on disk. A Run and its Plan are accepted together before dispatch, keyed by Run ID. It also holds run history, harness sessions, and token usage. It does not hold the scheduler's daily usage, and losing it is safe because coordination lives in the Control store outside the ledger's region and stays authoritative.
_Avoid_: Source of truth, database, backlog, Control store (the ledger is one disposable region of it).

**Run event**:
One persisted, sequenced entry in a run's stream — an encoded harness event stored with a `seq` and timestamp.
_Avoid_: Log line, message

**Run activity**:
A live envelope broadcast while a run is in flight: run identity (run id / sequence / timestamp), the correlation ids for grouping, and the one whole harness event. What the watch stream carries. The same shape is rebuilt when a settled run's persisted events are replayed for the run drill-in, so live and history read identically.
_Avoid_: Run event (the persisted form), notification

**History end**:
The marker a run's watch stream (`WatchActivity`) sends after the replayed history and before the live run activity. The stream's item type, `RunWatchItem`, is either a run activity or this marker. It is a stream-control item, like `SeedEnd`: it carries a delivery fact, not a domain fact. A client shows history-derived state, such as the latest status line, only after it. A stream that stops on a terminal event in history ends without it, and the end of the stream means the same thing.
_Avoid_: Caught up, seed end (that is the `WatchEvents` marker)

**Session**:
A first-class entity with its own `SessionId`, grouping the runs that make up one conversation — a run points at it by foreign key (`RunRecord.session`), and runs on the same branch share one while their selected harness remains unchanged. Every session is permanently owned by the harness that created it and can be resumed only by that harness; model, model-option, operation, and instruction changes do not affect compatibility. A fresh start always mints a new session. It comes in two kinds. An **owned-transcript** session is the provider runner's: the whole conversation lives in our run ledger, so its transcript folds straight from the events and no handle is kept. An **opaque-handle** session is a CLI harness's: the harness keeps its own history and hands back an opaque `handle` (e.g. Cursor's session id) we store to resume it — `null` until the harness emits one. The kind is not a guess: each harness runner declares its `SessionKind` beside its name, and the session store mints the matching one. The session is minted when the run is inserted, before the harness has said anything (see engine ADR 0002), so a run always names a session even before it can be resumed.
_Avoid_: Run, connection, handle (that's one field of the opaque-handle kind, not the session itself)

**Session resume**:
A new Run and new native invocation that continue an existing Session. Cogwork sends the Session's `SessionId` as TanStack `threadId`; an opaque native handle, when present, goes only into the adapter's native `modelOptions.sessionId`. A resume never continues the old Run.
_Avoid_: Retry (why the new Run started), replacement Run (one recovery reason), Run takeover (continuation of the same invocation)

**Retry**:
The control plane starting another Run after a retryable failure. The new Run can resume the failed Run's Session, but retry describes failure policy, not conversation identity.
_Avoid_: Session resume, replacement Run, Run takeover

**Replacement Run**:
The new Run started after an interrupted or crashed Run. It can resume the same Session, but it starts a new native invocation with a continuation Message that treats the prepared Worktree as ground truth.
_Avoid_: Retry (interruption and crash are not attempts), Run takeover

**Run takeover**:
A successor driver adopting the same live native invocation and continuing the same Run after driver loss. It requires an exact delivery log, persistent native status, durable cancellation, distributed locking and fencing, and scheduled reaping. Cogwork does not enable it.
_Avoid_: Session resume, retry, replacement Run, human attach

**Harness switch**:
A run selecting a different harness from the branch's latest session. It begins a new session with the full operating instructions while preserving the worktree, branch, code progress, claim, and historical run records; only conversation continuity is discarded. Switching back never resurrects an older session from that harness.
_Avoid_: Session migration, session transfer, cross-harness resume

**Exhausted / stuck**:
The two failure outcomes that stop spending tokens after work starts. A Run is *exhausted* after three consecutive failed attempts for one Workflow Operation. An agent is *stuck* when its result reports it cannot proceed; the item parks at once with the summary. A new qualifying source revision can clear the park as a handback. Both are distinct from *blocked*, which is unresolved dependencies before an attempt.
_Avoid_: Blocked (dependencies now), failed (the single, still-retryable attempt status).

**Interrupted / crashed**:
The two restart outcomes, distinct from the failure outcomes above: neither is an **attempt record**, and neither advances an item toward *exhausted*. A run is *interrupted* when the daemon stops it gracefully during a drain. A run is *crashed* when startup finds it still `running` because the daemon died ungracefully. Recovery starts a replacement Run that resumes the Session; it never takes over the prior native invocation. A small per-item cap on consecutive crashes tips the item to *exhausted*, so a poison-pill item cannot restart forever. Both keep their **claim** across the restart; Session resume is machine-local, since the Session lives only in this daemon's Run ledger.
_Avoid_: Failed (a real, still-retryable attempt), exhausted (the terminal failure outcome), stale claim (one we release — a resumable run's claim is not stale).
