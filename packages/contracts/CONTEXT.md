# Contracts (shared kernel)

The Effect schemas that define the orchestration domain's shared vocabulary. Every other
orchestration context (`engine`, `cli`, `cursor-acp`) speaks these terms; this package owns them.
Definitions here are the source of truth — other contexts reference them rather than redefine.

## Language

### Work

**Work source**:
The external system that is authoritative for backlog work — its items, their human-visible roles, and the coordination markers written back onto them. Configured per workspace; GitHub and Linear are the adapters today.
_Avoid_: Backlog, control-plane database, internal store

**Work item**:
A single unit of backlog work observed from a work source, identified by a branded `WorkItemId` (e.g. a GitHub issue like `#13`, or a Linear identifier like `AUD-1`). Carries a title and, once observed, its roles, claim, attempts, and linked PR.
_Avoid_: Task, job, ticket (except when naming the work source's own UI)

**Workspace**:
A repo registered with the daemon: a checkout path bound to a work source, harness preferences, and playbook config. The unit of isolation and per-repo configuration.
_Avoid_: Project; not pnpm's or TanStack's "workspace"

### Lifecycle

**Lifecycle stage**:
One of `triage`, `implement`, `follow-up`, `verify` — the kind of work a run performs on an item. Chosen by classification from the item's roles and PR state.
_Avoid_: Step, phase, task type

**Triage role**:
A human-visible label expressing an item's triage outcome: `needs-triage`, `ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`. Roles drive classification; stages drive execution.
_Avoid_: Status, state, label (when you mean the role's meaning)

**Blocked / blocker / blocking**:
An item is *blocked* when its work source reports one or more open **blockers** — upstream items that must close before it can be worked — and it is *blocking* the items downstream of it. Blocking is the work source's own dependency relation (GitHub issue dependencies today; Linear blocking relations when its adapter reads them), read per adapter. A blocked item is held out of the `implement` stage until its blockers close, then becomes eligible on its own — no human acts. Neither eligible, claimed, nor needs-human.
_Avoid_: Depends-on (the inverse framing); needs-info / ready-for-human (those are needs-human — a person clears them); stuck / exhausted / stalled (failure outcomes, not dependencies).

**Needs-human reason**:
Why triage parked an item for a person: `needs-info` (waiting on the reporter) or `ready-for-human` (needs a human implementer). A needs-human item is neither eligible, claimed, nor blocked; a person clears it by changing the role.
_Avoid_: Block reason (blocking now means open dependencies), error, failure.

### Coordination

**Claim**:
A coordination record marking an item as being worked: `by`, `claimedAtMillis`, and an optional stage. Persisted onto the work source (a label plus a marker), so it survives a daemon restart.
_Avoid_: Lock, lease, reservation

**Attempt record**:
A coordination record of one finished stage attempt on an item: its stage, outcome (`succeeded` / `failed` / `abandoned`), and time. Persisted on the work source.
_Avoid_: Run — a run is the local execution; an attempt is the durable outcome

### Credentials

**Credential store**:
The daemon's durable, secret store of work-source credentials — an OAuth token pair (access + refresh) or a client-credentials token — keyed by the work source's account (a Linear organization). A seam: the backing layer is a `0600` file today, an OS keychain on desktop, a per-user database row on a hosted server. Unlike the run ledger it is **not** disposable — losing it logs the daemon out — and it is never committed to the repo.
_Avoid_: Run ledger (that one is disposable), config (the non-secret `client_id` lives in config, not here), keychain (only one possible backing layer).

### Runs

**Run**:
One execution of one stage against one work item by one harness, captured as a `RunRecord` (branch, session, token usage, status, timings). The daemon's disposable local record of an execution.
_Avoid_: Attempt (the durable, work-source form), job. Do not confuse with the harness's `RUN_STARTED` / `RUN_FINISHED` stream events, which are moments inside a run.

**Run ledger**:
The daemon's local store of runs and their events — in-memory, or SQLite at `~/.clanker-forge/runs.db`. Holds run history, harness sessions, and token usage. It does not hold scheduling budgets (those live only in the scheduler's memory), and losing it is safe because the work source stays authoritative for coordination.
_Avoid_: Source of truth, database, backlog. Not the GitHub coordination comment, whose anchor marker is also called a "ledger".

**Run event**:
One persisted, sequenced entry in a run's stream — an encoded harness event stored with a `seq` and timestamp.
_Avoid_: Log line, message

**Run activity**:
A live envelope broadcast while a run is in flight: run identity plus one harness event and its sequence. What the watch stream carries.
_Avoid_: Run event (the persisted form), notification

**Session**:
A harness's own conversation handle (`SessionId`), stored on a run so a later stage on the same branch can resume the same agent session.
_Avoid_: Run, connection

**Exhausted / stalled / stuck**:
The three failure outcomes — how the control plane stops spending tokens on an item after it has already tried. A run is *exhausted* when it gives up after too many failed attempts or a non-retryable error: the terminal `RunStatus`, which escalates the item to `ready-for-human`. A follow-up is *stalled* when it hits the no-progress limit without the checks going green or a human replying. An agent is *stuck* when its own output reports it cannot proceed — a non-retryable cause that feeds exhaustion. All three are distinct from *blocked*, which is about unresolved dependencies before any attempt.
_Avoid_: Blocked (dependencies now), failed (the single, still-retryable attempt status).

**Interrupted / crashed**:
The two restart outcomes, distinct from the failure outcomes above: neither is an **attempt record**, and neither advances an item toward *exhausted*. A run is *interrupted* when the daemon stops it gracefully during a drain — a shutdown finalizer records it, and it resumes its **session** on the next start. A run is *crashed* when startup finds it still `running` because the daemon died ungracefully — it also resumes, but a small per-item cap on consecutive crashes tips it to *exhausted*, so a poison-pill item cannot resume forever. Both keep their **claim** across the restart; resume is machine-local, since the session lives only in this daemon's run ledger.
_Avoid_: Failed (a real, still-retryable attempt), exhausted (the terminal failure outcome), stale claim (one we release — a resumable run's claim is not stale).

### Harness contract

**Harness**:
A coding agent (Cursor, Claude Code, …) the control plane drives to do work in a checkout, identified by a branded `HarnessName`. A harness bundles its own model access and tools.
_Avoid_: Model, provider, target (that word belongs to sync)

**Harness request**:
The input handed to a harness for one run: which harness, the checkout path, the prompt, an optional model, an optional harness-native effort level, and an optional session to resume.
_Avoid_: Prompt (that's one field), job

**Harness event**:
A normalized event streamed from a harness run — text, tool calls, session id, usage, finish reason. The engine persists these as run events and republishes them as run activity.
_Avoid_: Message, token

### Daemon status (read models)

**Daemon status**:
The snapshot the daemon reports over RPC: health, uptime, scheduler stats, per-workspace info, and load failures.
_Avoid_: State, health check

**Actionable / claimed / blocked / needs-human item**:
The status-facing shapes of a classified work item — eligible-to-run, currently-claimed, blocked on open dependencies, and parked for a person. Narrowed views of a work item, not new entities.
_Avoid_: Reusing "work item" for these narrowed views
