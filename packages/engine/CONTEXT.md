# Engine (orchestration runtime)

The work control plane packaged as an embeddable library — the machinery that discovers, schedules,
and runs work. It owns the *verbs*; the nouns live in the shared kernel
([contracts](../contracts/CONTEXT.md)). It has no process identity of its own; the daemon hosts it.

Role in the flow: **reconcile → schedule → execute → dispatch to a harness**. See the root
`CONTEXT-MAP.md` for the end-to-end story.

## Language

**Daemon**:
The long-lived host process that runs the engine on one machine: it serves the RPC group and drives two heartbeats (reconcile and execute). Not a class — a set of modules composed at startup. The composition itself is the **seam** `Daemon.serverLayer(hostAdapters)`: it assembles the RPC server, its handlers, and the NDJSON framing on top of the engine's own services, taking a host's adapters (credential store, run ledger, workspace registry, worktree platform, harness runners, scheduler config, RPC transport) as its one argument. The one-credential-store rule lives here — the issue-tracker reads and the MCP-skill bearer must share one store instance. `Daemon.serializationLayer` is exported so a client frames its end of the wire the same way. Any host (the CLI today, desktop next) builds those adapters and calls this.
_Avoid_: Engine, orchestrator app, server (that's the RPC transport)

**Reconcile worker**:
The background worker that polls every workspace's issue tracker (and, when one is configured, attaches its source control provider's PR state), classifies the results, and stores them in an in-memory reconcile snapshot. One of the daemon's two heartbeats. A workspace whose rate-limit scope is inside a cooldown window is skipped before any request goes out, so a pinned credential is not hammered.
_Avoid_: Sync, poll loop. Distinct from worktree reconcile (cleanup) and claim recovery (resuming this daemon's own interrupted runs or releasing genuinely stale claims).

**Rate-limit scope**:
The key an issue tracker hands the reconcile worker to say *whose* request budget a poll spends. Linear's budget is per user and shared across every key that user owns, so its scope is the token env var — all workspaces reading through one token back off together. GitHub returns none: its client already fails fast inside its own cooldown, so there is nothing for reconcile to add.
_Avoid_: Credential id (the credential store's business), workspace key (the point is that it is *not* per workspace)

**Cooldown window**:
The span a rate-limit scope is held out of polling for, opened when a source reports `rate-limited`. Length comes from the source's own retry timing when it has any (Linear's `retryAfter` / `requestsResetAt`), and from exponential backoff when it doesn't. Entering a window warns once; the skipped ticks in between are quiet, and a successful poll closes it.
_Avoid_: Circuit breaker (nothing is tripped open by error rate), throttle

**Classification**:
The partition of an issue tracker's observed items into eligible, claimed, blocked, and needs-human, each tagged with a lifecycle stage. *Blocked* means the issue tracker reports open blockers, so `implement` is held until they close; *needs-human* means triage parked it for a person. Produced by `classify`.
_Avoid_: Filtering, triage (triage is a stage, not this)

**Assignee ownership gate**:
A per-workspace precondition inside `classify`: when `issueTracker.assigneeAllowlist` is set, an observed item is silently dropped from every bucket unless one of its assignees is on the list. Absent allowlist means the gate is off and every item passes, exactly as before. The check is a re-evaluated precondition, not an action — it never releases a claim or interrupts an in-flight run; an item that loses its owner just stops being picked up on the next poll, honoring the tracker as the source of truth. The `actorUserId`/`actorLogin` identity (who the daemon *acts as*) is distinct from the allowlist (whose tickets the daemon is *allowed to pick up*).
_Avoid_: Assignee filter (it gates all stages, not just a view), permission check

**Scheduler**:
The in-memory concurrency gate. It picks candidates from the reconcile snapshot under a global limit, per-workspace limits, and a daily budget, then forks an executor for each. In-flight counts and budgets live here and nowhere else. It acts on a given work item at most once per snapshot generation: a completed item is not re-picked until a newer snapshot re-confirms it is eligible, which is what stops a fast execute tick from re-running work that a slow reconcile has not yet caught up on (see ADR 0001).
_Avoid_: Queue, dispatcher, runner

**Drain**:
The scheduler's graceful stop: it picks no further candidates and gives the runs already in flight a **grace window** to finish on their own and record their normal outcome. Whatever is still running when the window closes — or when a second stop signal ends the wait early — is recorded `interrupted` and its agent torn down.
_Avoid_: Shutdown (the whole process exit, of which this is one step), quiesce, graceful kill

**Claim recovery**:
The startup pass that makes this daemon's claims consistent again after it stopped or died. It runs once at bootstrap, reading the reconcile snapshot instead of re-polling, and looks only at items this daemon still holds a claim on. For each one it checks the last run: an `interrupted` run reschedules on its saved session, a run still marked `running` is counted as a crash and either resumed (under the crash-loop cap) or handed to a human, and anything else closes the stale run, records a failed attempt, and releases the claim. It never touches the scheduler's counts or fibers directly — resumes go through the scheduler's **admit** capability, which is the only thing it borrows. Its own module (`src/recovery.ts`), and it owns the crash-loop cap as the sole consumer. Preserves ADR 0002.
_Avoid_: Reconcile worker (that polls and classifies; this only reads its snapshot), drain (that's the scheduler's graceful stop, the mirror image of this), stale-claim cleanup (that's one of the three paths, not the whole thing)

**Admit**:
The one narrow capability the scheduler hands claim recovery: reserve capacity for a resumed run and start it. It keeps in-flight counts and reservations inside the scheduler even when recovery is the one asking, and it always launches — a resume is picking up work this daemon already claimed, so it skips the fit checks a fresh candidate goes through.
_Avoid_: Tick (that picks new candidates under the caps), schedule, enqueue

**Snapshot generation**:
The monotonic counter the reconcile worker stamps on each snapshot it publishes. It is how the scheduler tells one observation of the issue tracker from the next, so it can act on each work item at most once per observation.
_Avoid_: Version, revision, epoch

**Candidate**:
A schedulable pairing of a registered workspace with one eligible work item, plus the reservation keys that keep it from being picked twice.
_Avoid_: Job, task

**Executor**:
The unit that runs one candidate end to end: claim, worktree, resolve playbook, dispatch to the harness, stream events through the run recorder, record the attempt.
_Avoid_: Runner, worker, harness

**Run recorder**:
The one seam a run's harness events cross between the harness runner and everything that reads them. Recording is one act with four parts: assign the event's sequence, encode it as a run event, append it to the run ledger (capturing an opaque session handle when one rides the event), and publish the same moment as run activity. Reads come back through the same seam — a settled run replays as run activity for the drill-in, and a session's events decode for the transcript fold — so live and replayed activity are identical by construction. The encoding between harness event and run event is its private detail; no other module decodes a run event's payload.
_Avoid_: Run ledger (the store it writes to), daemon event bus (the transport it publishes on), event log, persistence (the TanStack adapter the session store hands the provider runner)

**Session store**:
The place sessions are minted and the read model a runner pulls a session's history from, given a `SessionId`. `mint` takes a harness name and the harness service's kind lookup, chooses the session kind from that runner's declaration, and inserts the row — owned-transcript for the provider runner (the run ledger holds the conversation), opaque-handle for a CLI harness (the harness holds its own history, with a null handle until one is captured). The executor asks for a session and never names a kind itself. It hands the provider runner a real `@tanstack/ai-persistence` adapter (`persistence`) that the runner runs under via `withPersistence`. Its **message store** is a ledger projection: `loadThread` folds the session's transcript out of the run ledger — every event across the runs that share the session (oldest run first) projected into ordered model messages — and `saveThread` is a no-op, because the run recorder already appends every event, so the event-sourced ledger stays the one source of truth. Beside the message store sit process-scoped **run** and **interrupt** stores that wire durable pause/resume ahead of the interactive phase; they live in memory, matching the run ledger's own durability, and a persistent ledger backend will carry them too. `resumeHandle` still hands back the session's opaque handle, the thing a CLI runner needs to resume its own history. An empty transcript is `[]` and an unhandled session is a null handle, never a failure. There is no second transcript store: the run ledger is the only place a conversation lives.
_Avoid_: Message store (that's the persistence library's term for the one piece of the adapter), transcript database, second store

**Harness request**:
The envelope the executor hands the harness for one run: the checkout path, the turn's prompt, model/effort, MCP skills, and a `session` reference — the `SessionId` this run continues, or null for a fresh start. It references a session rather than shipping one; no frozen transcript ever crosses the seam, so compaction can live inside the runner's loop where context actually grows. The prompt is only this run's instruction, never accumulated history.
_Avoid_: Prompt (that's now one field of the envelope), transcript (the request carries a reference, not history)

**Harness service**:
The engine's dispatcher — given a harness request, it routes to the registered harness runner by name, and provides the `SessionStore` a runner pulls history through. It also exposes `sessionKind(name)`: the declared kind for a harness, read straight off the runner registry (an unregistered name falls back to opaque-handle, since its run fails at dispatch anyway). This is the one place kind lookup lives — no separate harness-to-kind map. Knows nothing about any specific agent.
_Avoid_: Harness (the concept, defined in contracts), model

**Harness runner**:
A pluggable implementation of one agent backend: a `name`, a declared **session kind**, and a `run` that returns a stream of harness events. The session kind says who owns the conversation: the Cursor runner declares opaque-handle (the harness keeps its own history and hands back a resume handle), the provider runner declares owned-transcript (the run ledger holds the conversation). It pulls the session's history in-process from the request's reference — a CLI runner its opaque resume handle, the owned runner the folded transcript. `cursorRunner` (from cursor-acp) is one; the CLI registers it at startup.
_Avoid_: Harness service, adapter (adapter is the issue-tracker term)

**MCP skill assembler**:
Turns a workspace's configured MCP skills into the resolved set a run gets, filling in auth just before dispatch. A skill that asks for `credential-store` auth borrows the workspace's own credential account (Linear today) so its bearer is minted and rotated alongside the token the engine already uses; the token comes back wrapped in a `Redacted` and travels on the harness request only, never into the ledger or the event log. Public skills pass straight through with no token and never touch the credential store.
_Avoid_: MCP server, credential store (it delegates to that, it is not that), context assembler (that builds instruction layers, not MCP capabilities)

**Context assembler**:
Builds the layered instruction set for one turn of the provider harness runner — global, then repo, then playbook. Returns structured layers the runner renders into model system prompts; does not run for CLI harnesses.
_Avoid_: Prompt builder, system prompt (those are outputs of rendering), MCP skill assembler

**Instruction layer**:
One slice of the context assembler's output: global (`~/.cogwork/AGENTS.md`), repo (every `AGENTS.md` from worktree cwd up to project root), or playbook (the stage's playbook skill body). Distinct from the user-message playbook prompt template.
_Avoid_: Context source (opencode's term), rules file

**Owned tool set**:
The owned tools the engine hands a run instead of leaning on the harness's built-ins: `read`, `write`, `edit`, `bash`, `glob`, `grep`, and `webfetch`. Each is a TanStack `toolDefinition` with an Effect handler, and each runs through the run's worktree sandbox rather than touching the host directly. There is no tracker or PR tool — `git` and `gh` ride in on `bash`. File-touching tools go through path confinement first; failures surface as a typed `ToolError`.
_Avoid_: Built-in tools (those are the harness's), MCP skill (that is an external capability, this set is native)

**Worktree sandbox**:
An `ai-sandbox` `localProcessSandbox` opened onto a run's worktree, so the owned tools read, write, and exec against that checkout and nothing else. Opened as an Effect resource (acquire the handle, release on scope close); the release only tears down the sandbox handle, never the checkout itself. The base SHA it reports is `git rev-parse HEAD`, or `""` when the checkout is not a git repo.
_Avoid_: Worktree manager (that owns the git lifecycle; this is the process boundary a run's tools execute inside), container

**Path confinement**:
The rule that keeps a file-touching tool inside the worktree root: a requested path is normalized (drop leading `/` and any `/workspace` prefix, resolve `.` and `..`) and any path that would climb above the root is rejected as an `out-of-bounds` `ToolError` before the sandbox is asked to do anything. The typed refusal at the tool layer is the point — it fails clearly instead of leaning on the sandbox's more generic error.
_Avoid_: Sandboxing (that's the process boundary), chroot, jail

**File-diff feed**:
The stream of file-change events the owned tools produce for the live run view's diff panel. It watches the worktree, computes a unified diff per change against the run's base SHA (synthesizing an add-patch for a brand-new file), and emits each as an `AgUiEvent` — a `CUSTOM` event named `sandbox.file.diff`. This is how a run's edits show up in the diff feed without the tools having to know the UI exists.
_Avoid_: Event log (that's the durable run record), file watcher (that's the mechanism, this is the diff stream on top of it)

**Policy profile**:
The allow/ask/deny rules a run's owned tools are gated by, chosen from the playbook's resolved stage. Two engine-owned defaults over one shared tool set: **read-only** for `triage` and `verify` (read/glob/grep/webfetch; writes and shell refused), and **full** for `implement` and `follow-up` (everything, with only the hard-deny list as a floor). A profile is a TanStack `ai-sandbox` `SandboxPolicy`, so the engine reuses that package's `evaluateCommand` to match bash against command globs; `write`/`edit` ride the `fileWrite` capability, `webfetch` rides `network`, and `read`/`glob`/`grep` are always allowed. Per-workspace overrides wait for settings-as-data.
_Avoid_: Sandbox isolation (that's the process boundary; this is the decision layer above it), per-tool allowlist (bash is command-matched, not all-or-nothing)

**Ask-compiles-to-deny**:
The AFK keystone. The full allow/ask/deny vocabulary is authored in the profiles, but with no human in the session there is nothing to answer an `ask`, so `ask` compiles to `deny` before the tool runs. A denied call is not an error or a park — it returns a `denied` result the model reads and adapts to, adding no approval RPC and never handing the item to a person. The loop budget, not a human, bounds any thrashing.
_Avoid_: Approval flow / interrupt (that's the interactive phase this defers), tool error (a denial is a normal result, not a failure)

**Hard-deny rule**:
A command-glob rule refused in every profile, in every stage — the small floor under even the full profile. Three destructive shapes: force-pushing to `main`/`master`, piping a download straight into a shell (`curl … | sh`), and recursively deleting an absolute or home path. The model is treated as fallible, not adversarial, so the globs are coarse and a hard-deny just returns `denied` like any other refusal.
_Avoid_: Confinement (that keeps writes inside the worktree root; this bounds shell commands), sandbox isolation

**Playbook skill**:
The `SKILL.md` (and its directory) named by a playbook for a lifecycle stage, authored under `packages/engine/skills/`. Distinct from an MCP skill.
_Avoid_: Skill (alone — ambiguous), MCP skill, sync skill

**Skill provision**:
A copy or link of a playbook skill directory onto a host path under `~/.cogwork/` that the run's tools can read, without writing into the driven worktree.
_Avoid_: Sync, install, gitSkill (TanStack sandbox's clone-into-workspace form — same idea, different path)

**Playbook**:
A workspace's binding of a lifecycle stage to a prompt template, playbook skill, and harness/model/effort choice. The engine resolves a stage's playbook into a `ResolvedStage` before executing. Model and effort are harness-native strings (e.g. Cursor CLI model ids and `effort=` bracket values); stages can be disabled per workspace; only `triage`, `implement`, and `follow-up` are wired today.
_Avoid_: Workflow, pipeline

**Issue tracker adapter**:
A concrete implementation of the issue tracker port. `GitHub.adapterLayer` and `Linear.adapterLayer` are the real ones; daemon composition routes by the tracker `type`. Both adapters are the coordination tracker bound to a per-tracker coordination host: the host reads tracker-native issues/labels/comments and supplies the native writes; the choreography — coordination state into a bot-owned coordination comment, human-facing notes (triage proposals) as separate comments — lives in the coordination tracker, once. Linear's host pre-fetches its coordination comments in the item listing and its Canceled-on-wontfix write rides the after-role-change hook. **Claim identity is adapter-owned**: the port's `claim` write takes no `by`, and each host stamps its own — GitHub its configured `actorLogin` or the `cogwork` fallback, Linear always `cogwork` — then reports on each observed item whether that claim is one it would itself have written (`claimedByUs`). Nothing above the seam supplies or compares an identity string. Linear reads open blockers from an issue's inverse `blocks` relations (a blocker counts until its own state is `completed` or `canceled`). The tracker no longer observes pull requests — that moved to the source control provider.
_Avoid_: Work source adapter, client (the HTTP/GraphQL client is a lower-level detail), plugin

**Source control provider adapter**:
A concrete implementation of the source control provider port — read-only PR observation, GitHub the only one today. Given a work item, it resolves the item's PR by the link key (the open PR whose head branch starts with `ticketSlug(item.id)`) and reads its checks, reviews, mergeable / base-divergence signal, and human comments; it writes nothing. A GitHub issue tracker doubles as its own provider by default; a Linear tracker pairs with a GitHub provider through an explicit `sourceControl` config block.
_Avoid_: Forge, code host, client (the HTTP client is a lower-level detail), plugin

**Credential store**:
The seam every issue-tracker credential is resolved through: given an account (the issue tracker's logical identity, the env var naming its legacy API key, the OAuth app id for browser-login refresh, and the OAuth app to mint from when client credentials are configured), it hands back a credential — the token, the source it came from, and any identity discovered alongside it — and logs which source it used. Precedence is the stored browser-login token (refreshed first when at or near expiry — see token refresh), then client credentials, then the env-var API key. An expired stored token it cannot refresh — no refresh token, no OAuth client id — or an ambiguous match across organizations falls through, and so does an account that never asked for client credentials. `invalidate` drops whatever was minted for an account, which is how a rejected token gets replaced. Only the Linear client resolves through the store today; GitHub still reads its token from the environment directly. The same store resolves **provider keys** (see below), so one instance holds both issue-tracker tokens and AI-provider keys in one file. A keychain-backed layer arrives behind the same seam later.
_Avoid_: Secret manager, token cache (the credential file, not the store, holds tokens), auth provider

**Provider key**:
An AI provider's API key, resolved through the credential store beside the issue-tracker tokens. A provider account is just a provider id plus the env vars a key can live in (most-specific first); resolution prefers a stored key over the environment, and a missing key is an error naming the env vars to set. Keys are durable — no expiry, no refresh — so they persist as a plain `StoredProviderKey` (a `Redacted` value keyed by provider) in the `version: 2` credential file, which reads a `version: 1` file as one with no provider keys. Bring-your-own-key is the whole story today: a key arrives from the environment or is pasted through `login key`; the one sanctioned browser login that mints a key (OpenRouter OAuth) is a follow-up that will write the same `StoredProviderKey`.
_Avoid_: Bearer token (that's the issue-tracker credential with an identity and expiry), secret manager

**Supported providers**:
The in-engine registry of the AI providers cogwork has a runner for — Anthropic, OpenAI, OpenRouter, Google — each with its display name and the env vars its key resolves from. It is the deterministic, offline source of truth for "which providers, which env vars," so key resolution never depends on a network fetch; the models.dev catalog only feeds the model list. A provider is **configured** when a key resolves for it (stored or env); unconfigured providers drop out of the picker silently rather than erroring.
_Avoid_: Model catalog (that's the network list of models; this is the local capability set), provider adapter

**Model catalog**:
The models.dev `api.json` read at runtime for the model picker — provider-keyed JSON decoded down to each model's id and label, filtered to the configured providers. Cached in memory with a TTL; a refresh that fails after a good load serves the stale copy rather than failing the picker, and a cold-cache failure surfaces a typed `CatalogError`. TanStack AI's per-model types remain the compile-time layer; this is the live half.
_Avoid_: Supported providers (that's the local registry), playbook model (that's the harness-native model string a stage resolves)

**Model adapter resolution**:
The one owned path from a `provider/model` reference to a live TanStack text adapter: parse the reference, find the wired provider, resolve its key through the credential store, and build the adapter (`resolveModelAdapter` in `src/provider-resolve.ts`). It fails typed — `unknown-model` for an unwired provider prefix or a model the factory has no adapter for, `no-key` when the credential store finds no key. The provider runner and the utility-call path both resolve through it, so an off-session call reaches a model the exact same way a session run does.
_Avoid_: Provider adapter (that's the per-provider factory this calls), model catalog (that's the picker list, not resolution)

**Utility model call**:
A one-shot model call the engine makes off the session path — routing, ranking, drafting, summaries, and later meeting extraction — served by the `UtilityModel` service (`src/utility-call.ts`). It resolves the provider and key through the shared model adapter resolution, runs a single non-streaming turn (a system prompt plus one user turn), and hands back the whole reply as a string. No harness, no session, no tools, no worktree sandbox, and nothing touches the run ledger — this is the deliberately unequal path a coding session never takes (engine ADR 0006, technical-disposition principle 9). The default model is the small one (`anthropic/claude-haiku-4-5`), since utility work is meant to be cheap and fast; a caller names a different `provider/model` when it needs more.
_Avoid_: Harness runner (that runs coding sessions and streams events), session (a utility call has none), summarize (that's one use, not the path)

**Token refresh**:
The exchange that trades a stored refresh token for a rotated pair at the issue tracker's token endpoint, and the store's rule for when to run it. It is **reactive** — nothing schedules it, a read that finds an expired or near-expired token triggers it — and **single-flight** per stored credential, so concurrent reads share one exchange rather than racing to spend the same refresh token. The rotated pair is written back to the credential file before the token is handed out, keeping the file the source of truth. A refresh that fails is an auth error, not a quiet fall back to the env var. The store owns the timing; the issue tracker's adapter owns the exchange (`Linear.OAuth.makeTokenRefresh`).
_Avoid_: Token renewal loop, background refresh (there are no timers), re-authentication (that is a fresh grant, not a refresh)

**Client-credentials grant**:
The store's non-interactive source: it trades an OAuth app's `client_id` and a `client_secret` read from an env var for an `app`-actor token, which is how a headless or CI daemon authenticates with no browser. Naming the secret's env var in `issueTracker.oauth.clientSecretEnv` is what asks for the source at all — an app configured for browser login alone leaves it unset and keeps the env-key floor, while naming a var whose value is missing is an error rather than a silent fall-through. The minted token is held until its lifetime runs out or the store is told it was rejected; this grant has no refresh token, so a rejection means minting a new one.
_Avoid_: Service account, machine token, app token (that is what it mints, not the source)

**Stored credential**:
One organization's OAuth grant as it is persisted: the token pair, its expiry and scopes, and the identity discovered when it was granted (the organization and the `actorUserId` the app posts as). Keyed by issue tracker and organization, so one file can hold grants for several organizations. The engine defines the shape and the read path; where it lives on disk is the CLI's business.
_Avoid_: Session, login (the login command that mints these does not exist yet)

**Coordination tracker**:
The single implementation of the issue tracker port's choreography — claim, release, note, the observe-side parse that builds a tracker item, and the **coordination outcomes** (the stage-result writes) — written once over a **coordination host**: the per-tracker bundle of native operations (comment list/edit/create, label add/remove, id resolution, item listing with coordination comments attached), the wire codec, the claim identity, role mapping, and an after-role-change hook (Linear's `wontfix` → Canceled state write). GitHub and Linear both supply a host; a third tracker is a host plus a codec. It exposes coordination outcomes, not the raw step writes: the role change, the attempt record, and the follow-up marker are its private detail, so nothing above the seam sequences them.
_Avoid_: Issue tracker adapter (the host-supplying side), coordination module (the payload and comment policy this calls), shell (say coordination tracker)

**Coordination outcome**:
The single issue-tracker write that records what a stage attempt produced, composing the role change, the attempt record, the follow-up marker, and any note behind one verb on the issue tracker port. The verbs are `triaged`, `implemented`, `followedUp`, `attemptFailed`, `handOff`, `stalled`, and the human-driven `reclassify`; the surviving primitives beside them are `observe`, `claim`, `release`, `note` (free-text operator/recovery prose), and `rateLimitScope`. The executor names the outcome and keeps the exhaustion decision — on a failed attempt it calls `attemptFailed`, then `handOff` only when the attempt count is spent — but it never sequences the tracker writes itself, and it settles its own **run** on the run ledger separately (a coordination outcome touches the tracker only, never the local run). Each verb takes already-parsed data (a role, a proposal string, a `FollowUpMarker`), never the run's raw text.
_Avoid_: Attempt record (one marker an outcome may write), step verb (the raw `setRoles`/`recordAttempt`/`recordFollowUp` an outcome now hides), apply (the executor's old per-stage handler this replaces)

**Coordination module**:
The single home of the coordination-comment policy (`src/coordination.ts`), shared by both issue-tracker adapters. It owns the upsert choreography (read comments → select the ledger → carry status/markers/detail forward → edit-or-create), ledger selection, strict reads, the `key=value` payload codec, status prose, body layout, and note formatting. Each adapter supplies a **wire codec** — encode a marker, scan a body into marker spans, name the ledger anchor — plus its normalized comments (`list` / `edit` / `create`); the module does the rest. Everything else about a marker change lives here, so it touches one file, not two.
_Avoid_: Markers file (each adapter's `markers.ts` now holds only its wire codec and role-label mapping, not the policy).

**Coordination markers**:
Machine-readable claim / attempt / follow-up / ledger records written into the coordination comment so the control plane's coordination state travels with the issue tracker. The coordination module owns the shared payload format; each adapter's wire codec only dresses it for the host. GitHub embeds markers as HTML comments; Linear writes the same payloads as visible `cogwork:…` plain-text lines (Linear has no hidden HTML comments), and a Linear marker is only real at the start of a line. Claim markers carry `stage=` on both hosts; older stage-less markers still decode. A claim marker's `by=` value is each adapter's own wire detail — filled on write and matched on read to decide ownership — never a value handed down from above the seam.
_Avoid_: Metadata. The "ledger" marker here is not the run ledger.

**Coordination comment**:
The single bot-owned comment an adapter keeps on an issue for control-plane state — specifically, the **oldest** bot comment bearing the ledger marker, so a forgery posted later can never displace it. Every coordination write edits it in place rather than adding another comment, and reads take claim / attempts / follow-up / status / detail from it alone (markers in other bot comments are ignored). It holds the **status** (one line naming what the control plane is doing now), optional **detail** (a hand-off explanation such as a no-progress follow-up note), and the coordination markers. Triage proposals are not stored here — each triage round is a separate comment so the thread stays conversational and notifiable. A write that sets one part carries the others forward, so a status change never erases a hand-off detail.
_Avoid_: Ledger comment (the ledger marker is only its anchor), proposal comment (proposals are separate notes).

**Worktree manager**:
The git worktree lifecycle for the repos cogwork *drives*: ensure a branch's checkout exists, list them, remove them, and reconcile away idle ones. "Reconcile" here means worktree cleanup — not the reconcile worker. It links only the paths a driven workspace's config declares (`linkPaths`); it is not the setup a coding harness runs when it opens a worktree of *this* repo to work on cogwork itself — that is a repo-local developer concern, deliberately kept separate (see ADR 0005).
_Avoid_: Checkout, clone, worktree setup (that is the repo-local harness concern, not this)

**Branch divergence**:
A worktree branch holding commits its remote branch lacks while the remote holds commits the branch lacks, so no fast-forward can bring them together. The worktree manager resolves it by rebasing the local commits onto the remote; when that rebase will not apply, the divergence is a non-retryable prepare failure that hands the item to a human with its commits untouched (see ADR 0002).
_Avoid_: Conflict (that's one reason a rebase fails), drift, stale branch (that's just being behind)

**Base divergence**:
A bot pull request's branch and its base branch (`main`) have each gained commits the other lacks and those commits overlap, so the branch can no longer merge into the base. The engine reads it from the source control provider's mergeable signal (GitHub's `dirty`) on the reconcile poll and treats it as a fourth follow-up trigger; the follow-up agent integrates the base — a merge commit by default, a rebase with `--force-with-lease` only where the repo requires linear history — and pushes to the same branch (see ADR 0003). A branch merely *behind* its base (no overlap, still mergeable) is not this and is left alone.
_Avoid_: Branch divergence (that's the branch versus its own remote, not the base), merge conflict (one reason integrating the base fails), stale branch (that's merely behind)

**Workspace registry**:
The loaded set of registered workspaces (and the failures from loading), built by folding workspace registration events. The engine's view of which repos it's driving.
_Avoid_: Config store. Distinct from the harness runner map, which is also a "registry" of sorts.
