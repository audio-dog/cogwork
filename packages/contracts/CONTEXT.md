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

**Actor identity**:
Who the daemon acts *as* on a tracker — `issueTracker.actorUserId` (Linear user UUID) and `actorLogin` (GitHub login, on the tracker or the `sourceControl` block). It stamps claims and coordination comments and marks which comments/PRs are the daemon's own. One identity per workspace. (Renamed from `botUserId`/`botLogin`, since it can be any human or service account, not only a bot.)
_Avoid_: Bot id, owner (that's the allowlist), principal (that's an RPC caller)

**Assignee allowlist**:
`issueTracker.assigneeAllowlist` — an optional, non-empty-when-present list of tracker-native identities whose assigned tickets this workspace is *allowed to pick up*. Absent means no gate: every item is eligible, as before. Distinct from the actor identity: this is whose work the daemon may take, not who it acts as. Enforced in the engine's classification, not here.
_Avoid_: Assignee filter, owner list (it's an allowlist of several), actor

**Bot allowlist**:
`sourceControl.botAllowlist` (with the same fallback field on `issueTracker` the source-control target already borrows) — an optional, non-empty-when-present list of bot logins whose PR comments are trusted to *wake a follow-up*. Absent means the gate is off: no bot comment ever wakes one, exactly as before. A listed bot's comment is a wake signal only — it triggers a follow-up but does not reset the no-progress counter and can never set `/fresh`, so a stall still hands off to a human. It grants no steering: a trusted-bot finding is actionable context, like a failing check, never an instruction. Distinct from the actor identity (who the daemon acts as) and the assignee allowlist (whose tickets it may pick up).
_Avoid_: Bot filter, trusted authors (humans aren't on it), steering (a bot never steers)

### Lifecycle

**Lifecycle stage**:
One of `triage`, `implement`, `follow-up`, `verify` — the kind of work a run performs on an item. Chosen by classification from the item's roles and PR state.
_Avoid_: Step, phase, task type

**Priority**:
One of `urgent`, `high`, `medium`, `low` — a four-level scale (`priorityRank`, highest first) that orders work *within* a lifecycle stage and nowhere else. Stage is always the primary sort key, so a low-priority follow-up still runs before an urgent implement; priority only breaks ties between items of the same stage, and stable tracker order breaks ties between items of the same priority. Every observed item carries a resolved priority. Each adapter reads its own tracker's field and maps it onto this scale (`resolvePriority`, case-insensitive); anything absent, blank, or unrecognized becomes the `defaultPriority`, `medium`. Priority orders work — it never gates eligibility — so a value we can't read must never drop an item; it just lands in the middle.
_Avoid_: Stage priority (that's the fixed stage order, `stagePriority`), severity, weight, rank (alone — `priorityRank` is the ordering, priority is the value)

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
The daemon's local store of runs and their events — in-memory, or SQLite at `~/.cogwork/runs.db`. Holds run history, harness sessions, and token usage. It does not hold scheduling budgets (those live only in the scheduler's memory), and losing it is safe because the issue tracker stays authoritative for coordination.
_Avoid_: Source of truth, database, backlog. Not the GitHub coordination comment, whose anchor marker is also called a "ledger".

**Run event**:
One persisted, sequenced entry in a run's stream — an encoded harness event stored with a `seq` and timestamp.
_Avoid_: Log line, message

**Run activity**:
A live envelope broadcast while a run is in flight: run identity (run id / sequence / timestamp), the correlation ids for grouping, and the one whole harness event. What the watch stream carries. The same shape is rebuilt when a settled run's persisted events are replayed for the run drill-in, so live and history read identically.
_Avoid_: Run event (the persisted form), notification

**Session**:
A first-class entity with its own `SessionId`, grouping the runs that make up one conversation — a run points at it by foreign key (`RunRecord.session`), and runs on the same branch (or a resumed run) share one. It comes in two kinds. An **owned-transcript** session is the provider runner's: the whole conversation lives in our run ledger, so its transcript folds straight from the events and no handle is kept. An **opaque-handle** session is a CLI harness's: the harness keeps its own history and hands back an opaque `handle` (e.g. Cursor's session id) we store to resume it — `null` until the harness emits one. The kind is not a guess: each harness runner declares its `SessionKind` beside its name, and the session store mints the matching one. The session is minted when the run is inserted, before the harness has said anything (see engine ADR 0002), so a run always names a session even before it can be resumed.
_Avoid_: Run, connection, handle (that's one field of the opaque-handle kind, not the session itself)

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

**Harness-owned authentication**:
The credentials an external CLI harness owns and resolves from its host installation, such as a Codex CLI `codex login`. Cogwork selects and launches the harness but does not copy, store, refresh, or fall back from those credentials.
_Avoid_: Provider key, Cogwork login, harness fallback

**Harness execution boundary**:
The sandbox, approval mode, and native tools an external CLI harness enforces inside its agent loop. Cogwork chooses that boundary when it launches the harness, but its owned-tool policy cannot intercept native shell or file operations inside Cursor or Codex. An unattended harness must use a non-interactive approval mode and remain bounded to its worktree; full host access is not an unattended default.
_Avoid_: Owned tool policy, provider sandbox, fallback

**Harness request**:
The input handed to a harness for one run: which harness, the checkout path, the prompt, an optional model, an optional harness-native effort level, an optional session to resume, and the MCP skills to provision. Secret material (e.g. an MCP skill's bearer token) rides a channel that is never persisted or logged, not a plain field.
_Avoid_: Prompt (that's one field), job

**Stage result**:
The tagged, Effect-Schema-defined value a lifecycle stage returns through the harness stream. The shared kernel owns each stage's schema; triage returns exactly one `TriageStageResult` tagged `triage`, containing a terminal triage role (never the input-only `needs-triage`) and a non-empty, trimmed proposal. Prose remains ordinary streamed output and is never parsed as a stage result.
_Avoid_: Footer, sentinel, disposition line, text protocol

**Playbook skill**:
The coding playbook's named `SKILL.md` capability for a lifecycle stage (e.g. `triage-agent`). It is a required engine input: every harness runner receives the assembled playbook instructions and their provisioned resource path instead of relying on ambient harness discovery. Distinct from an MCP skill.
_Avoid_: Skill (alone), MCP skill, agent skill (TanStack Intent authoring docs)

**MCP skill**:
An external MCP server the engine provisions onto a run so the harness can call its tools — named and configured (endpoint + auth) by the engine, not by the harness. The engine assembles the set for a run; the harness runner projects each into the harness's native MCP channel. Secret values travel only through a secret or environment channel, never through a generated worktree config or command argument. Read-only where the server offers a read-only endpoint. The name follows TanStack AI's `mcpSkill`; it is the first kind of engine-provisioned run capability.
_Avoid_: MCP server, playbook skill, tool (one server exposes many), harness tool (the harness's own built-ins), plugin, provider skill (Anthropic/OpenAI hosted sandbox bundles)

**Harness event**:
The whole AG-UI event a harness run streams, carried inside a stable envelope rather than curated down to a fixed set of fields. A handful of fields are named because our folds and clients read them (text delta, tool call id/name, result, session id, usage, finish reason); every other key the harness emits — tool-call input, reasoning deltas, correlation ids, per-turn cost, and AG-UI fields we don't name yet — rides along instead of being dropped at decode. The engine persists these as run events and republishes them as run activity. The provider runner will emit AG-UI natively; cursor-acp maps its ACP stream best-effort.
_Avoid_: Message, token, curated event (the point is that it is not curated)

**Correlation ids**:
The stable ids a client uses to thread streamed deltas back into one message or one tool call — `threadId`, `messageId`, `toolCallId` — lifted out of the harness event into the run-activity envelope so a consumer can group activity without re-parsing the whole payload. Distinct from our `RunId`, which identifies the local execution, not a span inside it.
_Avoid_: Run id (that's the execution), message id alone (there are several)

### Daemon status (read models)

**Daemon status**:
The snapshot the daemon reports over RPC: health, uptime, scheduler stats, per-workspace info, and load failures.
_Avoid_: State, health check

**Actionable / claimed / blocked / needs-human item**:
The status-facing shapes of a classified work item — eligible-to-run, currently-claimed, blocked on open dependencies, and parked for a person. Narrowed views of a work item, not new entities. Each carries an optional **PR summary** when the source control provider resolved a pull request for it; an item with no PR simply omits it. A needs-human item also carries the halt reason and, when triage self-halted it, the **inline triage proposal** — the agent's proposal/question text, re-derived from the tracker on every reconcile so a surface can render the question in place without reading the comment thread. It is `null` when nothing self-halted the item (for example, an exhaustion hand-off).
_Avoid_: Reusing "work item" for these narrowed views

**Inline triage proposal**:
The agent's triage proposal/question text carried on a self-halted item's read model, lifted off the separate conversational tracker comment that still holds the human-facing copy. Present only when triage parked the item; re-derived from the tracker on reconcile, so it survives a daemon restart with no local state.
_Avoid_: Coordination detail (that carries hand-off explanations, not the proposal), proposal comment (the tracker comment this is lifted from)

**PR summary**:
The read-model view of a classified item's pull request, resolved by the source control provider from the item's link key: the PR number, a deep-link URL, its checks and review status, its mergeable / base-divergence signal, and a wait-time signal (the PR's last-activity instant, from which a consumer reads how long it has been waiting). Present only on items that have a PR. Shaped richly enough to host a later in-app review panel; the review and merge actions themselves stay on GitHub, reachable through the URL.
_Avoid_: Observed PR (the engine-internal form the provider reads, which also carries follow-up coordination state), PR state (too vague)

### Client RPC

**Query RPC / command RPC**:
The two kinds of RPC a client sends the daemon. A *query* reads daemon state and changes nothing. A *command* is an imperative that changes daemon state or behavior — cancel a run, reclassify a work item, pause the scheduler. The split follows CQS/CQRS and gives the trust boundary one place to guard commands more strictly than queries. `DaemonQueries` and `DaemonCommands` are the two groups; `DaemonRpcs` is their merge, what the daemon serves and a client generates against. The command group exists but is empty today — every RPC the daemon has is a read — and fills in with the mutating slice.
_Avoid_: Write RPC (too narrow — a command may change behavior, like pausing the scheduler, not only write data), mutation, getter

**Principal**:
The caller behind an RPC, injected into every handler's context by one `RpcMiddleware` so no handler assumes there is no caller. A fixed local owner today — the daemon is single-user — but the seam is where a real identity lands later, and where commands get guarded more strictly than queries. A token can ride along as a request header (`authTokenHeader`); it's unread today. The Principal is server-side context, never a serialized field on a read model.
_Avoid_: User, account, session (the harness's conversation handle), token (the credential, not the caller)

**Daemon event**:
The unit a client watches on the daemon's live feed — a tagged envelope over everything a client view must react to: a harness event on a run (run activity), a work item's classification change or removal, a run summary change, a workspace's state change, and a scheduler change. The subscription self-seeds — it opens by replaying the current state as ordinary events — so one subscription per client is the whole story; the client fans out its own views.
_Avoid_: Run activity (now one kind of daemon event), notification, log line

**Board**:
The view a client folds from the daemon event stream — the current items, running runs, and workspace and scheduler state. The fold is authored once, beside the daemon event; each client runs it locally, and folding the stream from its seed yields the same picture the status query reports.
_Avoid_: Dashboard, mission control (the product surface, not this view), status (the query is `GetStatus`; the board is the folded, live form)
