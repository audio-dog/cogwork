# Engine (orchestration runtime)

The work control plane packaged as an embeddable library — the machinery that discovers, schedules,
and runs work. It owns the *verbs*; the nouns live in the shared kernel
([contracts](../contracts/CONTEXT.md)). It has no process identity of its own; the daemon hosts it.

Role in the flow: **reconcile → schedule → execute → dispatch to a harness**. See the root
`CONTEXT-MAP.md` for the end-to-end story.

## Language

**Daemon**:
The long-lived host process that runs the engine on one machine: it serves the RPC group and drives two heartbeats (reconcile and execute). Not a class — a set of modules composed at startup.
_Avoid_: Engine, orchestrator app, server (that's the RPC transport)

**Reconcile worker**:
The background worker that polls every workspace's work source, classifies the results, and stores them in an in-memory reconcile snapshot. One of the daemon's two heartbeats. A workspace whose rate-limit scope is inside a cooldown window is skipped before any request goes out, so a pinned credential is not hammered.
_Avoid_: Sync, poll loop. Distinct from worktree reconcile (cleanup) and claim recovery (releasing stale claims).

**Rate-limit scope**:
The key a work source hands the reconcile worker to say *whose* request budget a poll spends. Linear's budget is per user and shared across every key that user owns, so its scope is the token env var — all workspaces reading through one token back off together. GitHub returns none: its client already fails fast inside its own cooldown, so there is nothing for reconcile to add.
_Avoid_: Credential id (the credential store's business), workspace key (the point is that it is *not* per workspace)

**Cooldown window**:
The span a rate-limit scope is held out of polling for, opened when a source reports `rate-limited`. Length comes from the source's own retry timing when it has any (Linear's `retryAfter` / `requestsResetAt`), and from exponential backoff when it doesn't. Entering a window warns once; the skipped ticks in between are quiet, and a successful poll closes it.
_Avoid_: Circuit breaker (nothing is tripped open by error rate), throttle

**Classification**:
The partition of a work source's observed items into eligible, claimed, blocked, and needs-human, each tagged with a lifecycle stage. *Blocked* means the work source reports open blockers, so `implement` is held until they close; *needs-human* means triage parked it for a person. Produced by `classify`.
_Avoid_: Filtering, triage (triage is a stage, not this)

**Scheduler**:
The in-memory concurrency gate. It picks candidates from the reconcile snapshot under a global limit, per-workspace limits, and a daily budget, then forks an executor for each. In-flight counts and budgets live here and nowhere else. It acts on a given work item at most once per snapshot generation: a completed item is not re-picked until a newer snapshot re-confirms it is eligible, which is what stops a fast execute tick from re-running work that a slow reconcile has not yet caught up on (see ADR 0001).
_Avoid_: Queue, dispatcher, runner

**Drain**:
The scheduler's graceful stop: it picks no further candidates and gives the runs already in flight a **grace window** to finish on their own and record their normal outcome. Whatever is still running when the window closes — or when a second stop signal ends the wait early — is recorded `interrupted` and its agent torn down.
_Avoid_: Shutdown (the whole process exit, of which this is one step), quiesce, graceful kill

**Snapshot generation**:
The monotonic counter the reconcile worker stamps on each snapshot it publishes. It is how the scheduler tells one observation of the work source from the next, so it can act on each work item at most once per observation.
_Avoid_: Version, revision, epoch

**Candidate**:
A schedulable pairing of a registered workspace with one eligible work item, plus the reservation keys that keep it from being picked twice.
_Avoid_: Job, task

**Executor**:
The unit that runs one candidate end to end: claim, worktree, resolve playbook, dispatch to the harness, stream events into the ledger, record the attempt.
_Avoid_: Runner, worker, harness

**Harness service**:
The engine's dispatcher — given a harness request, it routes to the registered harness runner by name. Knows nothing about any specific agent.
_Avoid_: Harness (the concept, defined in contracts), model

**Harness runner**:
A pluggable implementation of one agent backend: a `name` plus a `run` that returns a stream of harness events. `cursorRunner` (from cursor-acp) is one; the CLI registers it at startup.
_Avoid_: Harness service, adapter (adapter is the work-source term)

**Playbook**:
A workspace's binding of a lifecycle stage to a prompt template, skill, and harness/model/effort choice. The engine resolves a stage's playbook into a `ResolvedStage` before executing. Model and effort are harness-native strings (e.g. Cursor CLI model ids and `effort=` bracket values); stages can be disabled per workspace; only `triage`, `implement`, and `follow-up` are wired today.
_Avoid_: Workflow, pipeline

**Work source adapter**:
A concrete implementation of the work source port. `GitHub.adapterLayer` and `Linear.adapterLayer` are the real ones; daemon composition routes by `workSource.type` via `workSourceRoutedLayer`. Each adapter reads tracker-native issues/labels/comments, writes coordination state into a bot-owned coordination comment, and posts human-facing notes (triage proposals) as separate comments. Linear returns `pr: null` and `openBlockers: 0` (PR follow-up and dependency blocking stay GitHub's problem for now).
_Avoid_: Client (the HTTP/GraphQL client is a lower-level detail), plugin

**Credential store**:
The seam every work-source credential is resolved through: given an account (the work source's logical identity, the env var naming its legacy API key, and the OAuth app to mint from when one is configured), it hands back a credential — the token, the source it came from, and any identity discovered alongside it — and logs which source it used. Precedence is the stored browser-login token, then client credentials, then the env-var API key. An expired stored token (or an ambiguous match across organizations) falls through, and so does an account that never asked for client credentials. `invalidate` drops whatever was minted for an account, which is how a rejected token gets replaced. Only the Linear client resolves through the store today; GitHub still reads its token from the environment directly. A keychain-backed layer arrives behind the same seam later.
_Avoid_: Secret manager, auth provider

**Client-credentials grant**:
The store's non-interactive source: it trades an OAuth app's `client_id` and a `client_secret` read from an env var for an `app`-actor token, which is how a headless or CI daemon authenticates with no browser. Naming the secret's env var in `workSource.oauth.clientSecretEnv` is what asks for the source at all — an app configured for browser login alone leaves it unset and keeps the env-key floor, while naming a var whose value is missing is an error rather than a silent fall-through. The minted token is held until its lifetime runs out or the store is told it was rejected; this grant has no refresh token, so a rejection means minting a new one.
_Avoid_: Service account, machine token, app token (that is what it mints, not the source)

**Stored credential**:
One organization's OAuth grant as it is persisted: the token pair, its expiry and scopes, and the identity discovered when it was granted (the organization and the `botUserId` the app posts as). Keyed by work source and organization, so one file can hold grants for several organizations. The engine defines the shape and the read path; where it lives on disk is the CLI's business.
_Avoid_: Session, login (the login command that mints these does not exist yet)

**Coordination markers**:
Machine-readable claim / attempt / follow-up / ledger records written into the coordination comment so the control plane's coordination state travels with the work source. GitHub embeds them as HTML comments; Linear writes the same payloads as visible `clanker-forge:…` plain-text lines (Linear has no hidden HTML comments).
_Avoid_: Metadata. The "ledger" marker here is not the run ledger.

**Coordination comment**:
The single bot-owned comment an adapter keeps on an issue for control-plane state. Every coordination write edits it in place rather than adding another comment. It holds the **status** (one line naming what the control plane is doing now), optional **detail** (a hand-off explanation such as a no-progress follow-up note), and the coordination markers. Triage proposals are not stored here — each triage round is a separate comment so the thread stays conversational and notifiable. A write that sets one part carries the others forward, so a status change never erases a hand-off detail.
_Avoid_: Ledger comment (the ledger marker is only its anchor), proposal comment (proposals are separate notes).

**Worktree manager**:
The git worktree lifecycle: ensure a branch's checkout exists, list them, remove them, and reconcile away idle ones. "Reconcile" here means worktree cleanup — not the reconcile worker.
_Avoid_: Checkout, clone

**Branch divergence**:
A worktree branch holding commits its remote branch lacks while the remote holds commits the branch lacks, so no fast-forward can bring them together. The worktree manager resolves it by rebasing the local commits onto the remote; when that rebase will not apply, the divergence is a non-retryable prepare failure that hands the item to a human with its commits untouched (see ADR 0002).
_Avoid_: Conflict (that's one reason a rebase fails), drift, stale branch (that's just being behind)

**Workspace registry**:
The loaded set of registered workspaces (and the failures from loading), built by folding workspace registration events. The engine's view of which repos it's driving.
_Avoid_: Config store. Distinct from the harness runner map, which is also a "registry" of sorts.
