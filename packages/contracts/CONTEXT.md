# Contracts (shared kernel)

The Effect schemas that define the orchestration domain's shared vocabulary. Every other
orchestration context (`engine`, `cli`, `cursor-acp`) speaks these terms; this package owns them.
Definitions here are the source of truth — other contexts reference them rather than redefine.

## Language

### Work

**Issue tracker**:
The external system that is authoritative for backlog work — its items, their human-visible roles, and the coordination markers written back onto them. Configured per workspace; GitHub Issues and Linear are the adapters today. Renamed from "work source": once pull requests moved to their own port (the source control provider), what remained was purely the tracker.
_Avoid_: Work source, backlog, control-plane database, internal store

**Source control provider**:
The read-only port that answers two questions about a work item — what its pull request is, and what that PR's state is (checks, reviews, mergeable / base divergence, human comments). It resolves the PR by the item's link key and never writes: coordination stays on the issue tracker, and PR writes (open, push, rebase) stay with the agent. Chosen per workspace independently of the tracker; GitHub is the only provider today, and a GitHub issue tracker doubles as its own provider by default.
_Avoid_: Forge, code host, work source, git client (the HTTP client is a lower-level detail)

**Work item**:
A single unit of backlog work observed from an issue tracker, identified by a branded `WorkItemId` (e.g. a GitHub issue like `#13`, or a Linear identifier like `AUD-1`). Carries a title and, once observed, its roles, claim, and attempts; its pull request is resolved separately by the source control provider, not carried as a tracker property.
_Avoid_: Task, job, ticket (except when naming the tracker's own UI)

**Link key**:
The stable key tying a work item to its pull request across systems: `ticketSlug(item.id)`, the item-id-derived prefix of the branch the engine cuts for it (`fel-157-…`, `13-…`). The source control provider finds the open PR whose head branch starts with this slug. Stable because it derives from the immutable item id rather than the title, and enforced because the engine — not the agent — creates the branch.
_Avoid_: Closing keyword (`Closes #N`, the GitHub-only match this replaces), PR reference, branch name (the full branch also carries a title slug that can drift)

**Workspace**:
A repo registered with the daemon: a checkout path bound to an issue tracker and, optionally, a source control provider, plus harness preferences and playbook config. The unit of isolation and per-repo configuration.
_Avoid_: Project; not pnpm's or TanStack's "workspace"

### Lifecycle

**Lifecycle stage**:
One of `triage`, `implement`, `follow-up`, `verify` — the kind of work a run performs on an item. Chosen by classification from the item's roles and PR state.
_Avoid_: Step, phase, task type

**Triage role**:
A human-visible label expressing an item's triage outcome: `needs-triage`, `ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`. Roles drive classification; stages drive execution.
_Avoid_: Status, state, label (when you mean the role's meaning)

**Blocked / blocker / blocking**:
An item is *blocked* when its issue tracker reports one or more open **blockers** — upstream items that must close before it can be worked — and it is *blocking* the items downstream of it. Blocking is the issue tracker's own dependency relation (GitHub issue dependencies today; Linear blocking relations when its adapter reads them), read per adapter. A blocked item is held out of the `implement` stage until its blockers close, then becomes eligible on its own — no human acts. Neither eligible, claimed, nor needs-human.
_Avoid_: Depends-on (the inverse framing); needs-info / ready-for-human (those are needs-human — a person clears them); stuck / exhausted / stalled (failure outcomes, not dependencies).

**Needs-human reason**:
Why triage parked an item for a person: `needs-info` (waiting on the reporter) or `ready-for-human` (needs a human implementer). A needs-human item is neither eligible, claimed, nor blocked; a person clears it by changing the role.
_Avoid_: Block reason (blocking now means open dependencies), error, failure.

### Coordination

**Claim**:
A coordination record marking an item as being worked: `by`, `claimedAtMillis`, and an optional stage. Persisted onto the issue tracker (a label plus a marker), so it survives a daemon restart.
_Avoid_: Lock, lease, reservation

**Attempt record**:
A coordination record of one finished stage attempt on an item: its stage, outcome (`succeeded` / `failed` / `abandoned`), and time. Persisted on the issue tracker.
_Avoid_: Run — a run is the local execution; an attempt is the durable outcome

### Credentials

**Credential store**:
The daemon's durable, secret store of credentials for the external systems a workspace binds — an OAuth token pair (access + refresh) or a client-credentials token — keyed by the system's account (a Linear organization). A seam: the backing layer is a `0600` file today, an OS keychain on desktop, a per-user database row on a hosted server. Unlike the run ledger it is **not** disposable — losing it logs the daemon out — and it is never committed to the repo. Only the Linear issue tracker resolves through it today; GitHub still reads its token from the environment.
_Avoid_: Run ledger (that one is disposable), config (the non-secret `client_id` lives in config, not here), keychain (only one possible backing layer).

### Runs

**Run**:
One execution of one stage against one work item by one harness, captured as a `RunRecord` (branch, session, token usage, status, timings). The daemon's disposable local record of an execution.
_Avoid_: Attempt (the durable, issue-tracker form), job. Do not confuse with the harness's `RUN_STARTED` / `RUN_FINISHED` stream events, which are moments inside a run.

**Run ledger**:
The daemon's local store of runs and their events — in-memory, or SQLite at `~/.clanker-forge/runs.db`. Holds run history, harness sessions, and token usage. It does not hold scheduling budgets (those live only in the scheduler's memory), and losing it is safe because the issue tracker stays authoritative for coordination.
_Avoid_: Source of truth, database, backlog. Not the GitHub coordination comment, whose anchor marker is also called a "ledger".

**Run event**:
One persisted, sequenced entry in a run's stream — an encoded harness event stored with a `seq` and timestamp.
_Avoid_: Log line, message

**Run activity**:
A live envelope broadcast while a run is in flight: run identity plus one harness event and its sequence. What the watch stream carries.
_Avoid_: Run event (the persisted form), notification

**Session**:
A harness's own conversation handle (`SessionId`), stored on a run so a later stage on the same branch can resume the same agent session. It is written the moment the harness first emits it, not when the run ends, so a run that never reached a terminal status still names a session to resume.
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
The input handed to a harness for one run: which harness, the checkout path, the prompt, an optional model, an optional harness-native effort level, an optional session to resume, and the MCP skills to provision. Secret material (e.g. an MCP skill's bearer token) rides a channel that is never persisted or logged, not a plain field.
_Avoid_: Prompt (that's one field), job

**MCP skill**:
An external MCP server the engine provisions onto a run so the harness can call its tools — named and configured (endpoint + auth) by the engine, not by the harness. The engine assembles the set for a run; the harness runner projects each into the harness's native MCP channel (for an ACP harness like Cursor, the `newSession` `mcpServers` field — no config file is written; a file-based harness would instead get an `--mcp-config`). Read-only where the server offers a read-only endpoint. The name follows TanStack AI's `mcpSkill`; it is the first kind of engine-provisioned run capability.
_Avoid_: MCP server (the coding tools' native config term; sync renders those and now calls them "toolkit servers" — see `packages/sync/CONTEXT.md`), tool (one server exposes many), harness tool (the harness's own built-ins), plugin

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

### Client RPC

**Query RPC / command RPC**:
The two kinds of RPC a client sends the daemon. A *query* reads daemon state and changes nothing. A *command* is an imperative that changes daemon state or behavior — cancel a run, reclassify a work item, pause the scheduler. The split follows CQS/CQRS and gives the trust boundary one place to guard commands more strictly than queries.
_Avoid_: Write RPC (too narrow — a command may change behavior, like pausing the scheduler, not only write data), mutation, getter

**Daemon event**:
The unit a client watches on the daemon's live feed — a tagged envelope over everything a client view must react to: a harness event on a run (run activity), a work item's classification change, a run summary change, and a scheduler change. One subscription per client; the client fans out its own views.
_Avoid_: Run activity (now one kind of daemon event), notification, log line
