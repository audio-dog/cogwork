# Engine (orchestration runtime)

The work control plane packaged as an embeddable library — the machinery that discovers, schedules,
and runs work. It owns the *verbs*; the nouns live in the shared kernel
([contracts](../contracts/CONTEXT.md)). It has no process identity of its own; the daemon hosts it.

Role in the flow: **reconcile → schedule → execute → dispatch to a harness**. See the root
`CONTEXT-MAP.md` for the end-to-end story.

## Language

**Daemon**:
The long-lived host process that runs the engine on one machine: it serves the RPC group and drives two heartbeats (reconcile and execute). Not a class — a set of modules composed at startup. The composition itself is the **seam** `Daemon.serverLayer(hostAdapters)`: it assembles the RPC server, its handlers, and the NDJSON framing on top of the engine's own services, taking a host's adapters (credential store, run ledger, workspace registry, worktree platform, harness runners, scheduler config, RPC transport) as its one argument. The one-credential-store rule lives here — the issue-tracker reads and the MCP-server bearer must share one store instance. `Daemon.serializationLayer` is exported so a client frames its end of the wire the same way. Any host (the CLI today, desktop next) builds those adapters and calls this.
_Avoid_: Engine, orchestrator app, server (that's the RPC transport)

**Reconcile worker**:
The background worker that polls every workspace's issue tracker, asks its configured source control provider to resolve a trusted pull request for every observed work item, classifies the combined results, and stores them in an in-memory reconcile snapshot. A coordination comment is the record of acting, not a precondition for observing a pull request. One of the daemon's two heartbeats. A workspace whose rate-limit scope is inside a cooldown window is skipped before any request goes out, so a pinned credential is not hammered.
_Avoid_: Sync, poll loop. Distinct from worktree reconcile (cleanup) and claim recovery (resuming this daemon's own interrupted runs or releasing genuinely stale claims).

**Rate-limit scope**:
The key an issue tracker hands the reconcile worker to say *whose* request budget a poll spends. Linear's budget is per user and shared across every key that user owns, so its scope is the token env var — all workspaces reading through one token back off together. GitHub returns none: its client already fails fast inside its own cooldown, so there is nothing for reconcile to add.
_Avoid_: Credential id (the credential store's business), workspace key (the point is that it is *not* per workspace)

**Cooldown window**:
The span a rate-limit scope is held out of polling for, opened when a source reports `rate-limited`. Length comes from the source's own retry timing when it has any (Linear's `retryAfter` / `requestsResetAt`), and from exponential backoff when it doesn't. Entering a window warns once; the skipped ticks in between are quiet, and a successful poll closes it.
_Avoid_: Circuit breaker (nothing is tripped open by error rate), throttle

**Classification**:
The partition of an issue tracker's observed items into eligible, claimed, blocked, needs-human, and ready-to-merge. The first four shapes state whether or why an agent can act; ready-to-merge carries a required PR summary and waits for a person. *Blocked* means the issue tracker reports open blockers, so implementation is held until they close; *needs-human* means triage parked it for a person. Produced by `classify`.
_Avoid_: Filtering, triage (triage is an operation, not this)

**Assignee ownership gate**:
A per-workspace precondition inside `classify`: when `issueTracker.assigneeAllowlist` is set, an observed item is silently dropped from every bucket unless one of its assignees is on the list. Absent allowlist means the gate is off and every item passes, exactly as before. The check is a re-evaluated precondition, not an action — it never releases a claim or interrupts an in-flight run; an item that loses its owner just stops being picked up on the next poll, honoring the tracker as the source of truth. The bound Connection's authenticated account (who the daemon *acts as*) is distinct from the allowlist (whose tickets the daemon is *allowed to pick up*).
_Avoid_: Assignee filter (it gates all stages, not just a view), permission check

**Scheduler**:
The in-memory concurrency gate. It picks candidates from the reconcile snapshot under a global limit, per-workspace limits, and a daily budget, then forks an executor for each. The limits are seeded from durable Control store rows; in-flight counts and daily usage stay in memory. It acts on a given work item at most once per snapshot generation: a completed item is not re-picked until a newer snapshot re-confirms it is eligible, which is what stops a fast execute tick from re-running work that a slow reconcile has not yet caught up on (see ADR 0001).
_Avoid_: Queue, dispatcher, runner

**Drain**:
The scheduler's graceful stop: it picks no further candidates and gives the runs already in flight a **grace window** to finish on their own and record their normal outcome. Whatever is still running when the window closes — or when a second stop signal ends the wait early — is recorded `interrupted` and its agent torn down.
_Avoid_: Shutdown (the whole process exit, of which this is one step), quiesce, graceful kill

**Claim recovery**:
The startup pass and repeatable live sweep that make this daemon's claims consistent after a stop, crash, or incomplete claim. Startup recovery preserves resumable runs; the live sweep releases a daemon-owned claim only when no current run requires it and the scheduler does not hold the work item in flight. A terminal run whose factual gate decline recorded `claimDisposition: hold` still requires its current claim.
_Avoid_: Reconcile worker (that polls and classifies; this only reads its snapshot), drain (that's the scheduler's graceful stop, the mirror image of this), stale-claim cleanup (that's one of the three paths, not the whole thing)

**Claim hold-off**:
What the executor does with a **refused claim**: the item is held out of claiming for a growing window, keyed by workspace, item and operation, so one refusal cannot re-write coordination on every generation — the failure is not contention, so the next poll would get the same answer. A refusal the port reports as permanent also parks the item: the refusal is posted as a note *before* the role writes, since those writes can hit the very refusal being reported, then `ready-for-human` escalates it. A cleared claim clears the window, so the item recovers on its own once a person fixes the tracker.
_Avoid_: Rate-limit cooldown (the reconcile worker's, keyed by credential scope — same mechanism, different scope), backoff, retry, exhausted (a run that gave up after trying)

**Admit**:
The narrow scheduler capability that reserves capacity for a recovered run and starts it. It always launches because recovery is resuming work this daemon already claimed; the scheduler separately exposes whether a work item is in flight so the live sweep cannot release a claim while its run starts.
_Avoid_: Tick (that picks new candidates under the caps), schedule, enqueue

**Snapshot generation**:
The monotonic counter the reconcile worker stamps on each snapshot it publishes. It is how the scheduler tells one observation of the issue tracker from the next, so it can act on each work item at most once per observation.
_Avoid_: Version, revision, epoch

**Candidate**:
A schedulable pairing of a registered workspace with one eligible work item, plus the reservation keys that keep it from being picked twice.
_Avoid_: Job, task

**Executor**:
The unit that runs one candidate end to end: claim, worktree, resolve its operation, assemble and atomically persist the Run with its Run Plan, dispatch the accepted plan to the harness, stream events through the run recorder, decode the terminal structured operation result once through the shared Effect Schema, and record the attempt. A Run without a Plan is never dispatched. A missing, duplicate, or malformed operation result is a retryable harness failure, not a text-parsing fallback.
_Avoid_: Runner, worker, harness

**Run recorder**:
The one seam a run's harness events cross between the harness runner and everything that reads them. Recording is one act with four parts: assign the event's sequence, encode it as a run event, append it to the run ledger (capturing an opaque session handle when one rides the event), and publish the same moment as run activity. Reads come back through the same seam — a settled run replays as run activity for the drill-in, and a session's events decode for the transcript fold — so live and replayed activity are identical by construction. The recorded-event codec is shared only with the replay harness, which needs the same decode boundary.
_Avoid_: Run ledger (the store it writes to), daemon event bus (the transport it publishes on), event log, persistence (the TanStack adapter the session store hands the provider runner)

**Session store**:
The place sessions are minted and the read model a runner pulls a session's history from, given a `SessionId`. `mint` takes a harness name and the harness service's kind lookup, chooses the session kind from that runner's declaration, and inserts the row — owned-transcript for the provider runner (the run ledger holds the conversation), opaque-handle for a CLI harness (the harness holds its own history, with a null handle until one is captured). The executor asks for a session and never names a kind itself. It hands the provider runner a real `@tanstack/ai-persistence` adapter (`persistence`) that the runner runs under via `withPersistence`. Its **message store** is a ledger projection: `loadThread` folds the session's transcript out of the run ledger — every event across the runs that share the session (oldest run first), including terminal structured results, projected into ordered model messages — and `saveThread` is a no-op, because the run recorder already appends every event, so the event-sourced ledger stays the one source of truth. Beside the message store sit process-scoped **run** and **interrupt** stores that wire durable pause/resume ahead of the interactive phase; they live in memory, matching the run ledger's own durability, and a persistent ledger backend will carry them too. `resumeHandle` still hands back the session's opaque handle, the thing a CLI runner needs to resume its own history. An empty transcript is `[]` and an unhandled session is a null handle, never a failure. There is no second transcript store: the run ledger is the only place a conversation lives.
_Avoid_: Message store (that's the persistence library's term for the one piece of the adapter), transcript database, second store

**Harness request**:
The projection the executor hands the harness for one accepted Run Plan, plus secret MCP credentials and a `session` reference — the `SessionId` this run continues, or null for a fresh start. The harness consumes the Plan's frozen Messages, Instructions, model, effort, and policy. It references a session rather than shipping one; no frozen transcript crosses the seam, so compaction can live inside the runner's loop where context actually grows.
_Avoid_: Prompt (that's now one field of the envelope), transcript (the request carries a reference, not history)

**Harness service**:
The engine's registry and dispatcher for Harness runners. It exposes each runner's Session kind, operational profile, controlled option catalog, and readiness; performs static preflight before claim and full Plan preflight before launch; and dispatches only to the selected runner, with no Harness or authentication fallback. Machine-local enablement is a separate Control-store fact: absent means enabled, and disabled refuses new or resumed Runs before claim without changing observational readiness or an accepted Run.
_Avoid_: Harness (the concept, defined in contracts), model

**Harness runner**:
A pluggable implementation of one agent backend. Beside dispatch it declares its Session kind, operational facts, explicit authentication binding, catalog sources, observational readiness, and authoritative preflight; unavailable runners remain registered without preventing unrelated Harnesses from running.
_Avoid_: Harness service, adapter (adapter is the issue-tracker term)

**Harness capability profile**:
The runner-declared operational facts TanStack does not expose at runtime: supported authentication modes, Session affinity, fork and human-attach behavior, structured-output reliability, policy and file-event fidelity, usage quality, readiness diagnostics, and journal/takeover support. File-event fidelity is `terminal-only`, `best-effort`, or `absent`. It is a declaration a client reads, never a switch: whether the runtime feeds a descriptor's file activity from the checkout is the descriptor's own `transport.runtimeFileDiffFeed`, so making a profile more honest cannot turn file activity off. Claude Code and Codex declare journal and takeover support; Cursor ACP declares neither. These facts describe adapter capability only. They do not activate durable execution. Adapter models, provider options, modalities, middleware requirements, and Sandbox requirements stay TanStack-owned runtime facts.
_Avoid_: Feature flags, adapter metadata, projection matrix

**External Harness runtime**:
The engine-owned execution module beneath Claude Code, Codex, and Cursor. It preflights the explicit authentication binding, mandatory Harness Workspace and MCP projection, descriptor-required shared Git metadata, and selected Sandbox provider before composing the typed TanStack adapter, `chat()` stream, cancellation, event bridge, and optional usage estimate. It normalizes supported native file activity to `sandbox.file.diff` without rebuilding the payload, and for a descriptor with no native file events it merges the engine's own File-diff feed instead of enabling the Sandbox watcher, holding `RUN_FINISHED` back until that feed has drained so the last write is not recorded behind the event a client stops reading at. It passes the Cogwork `RunId` as TanStack `runId`, the Cogwork `SessionId` as `threadId`, and any opaque native handle only through adapter model options. Its `withSandbox` call is intentionally nondurable: no Run store, stream durability, journal, detach, attach, or takeover option is present. Driver loss therefore cannot leave an intentional detached agent or trigger attach-first recovery. It also derives which Git paths a Run may write: a linked Worktree gets its own Worktree entry plus the common directory's `objects`, `refs`, and `logs`, never the common directory itself, so no Run can write the shared `config`, install a hook, or disturb a sibling Worktree.
_Avoid_: Harness service (the dispatcher above it), Harness runner (the engine-facing backend seam), provider runner (the owned-transcript path)

**Harness Workspace projection**:
The one portable TanStack Workspace definition the external Harness runtime creates for each Run. It carries fresh per-Run authentication and MCP `SecretRef`s. By default it also carries resolved MCP servers; a descriptor that declares native MCP projection consumes those servers from its request instead. The runtime also carries the Context assembler's ordered mandatory Instructions and the host-provisioned Operating Instructions package path, then uses the descriptor's native instruction channel. TanStack renders each Workspace input into the native Harness form. The work-specific Message remains the user turn, public MCP servers get no invented secret, and secret values resolve only into the live Sandbox environment. Events and Harness errors are scrubbed before they reach the caller or ledger. When the Workspace has secrets but no files to project, the runtime hands the adapter an already-satisfied projection, so the adapter's file-based projection pass writes nothing into the prepared checkout. Its source is `none` and snapshots are off: the selected Sandbox provider binds the prepared checkout, while the Worktree manager continues to own checkout, branch, Git metadata, and cleanup. A missing required projection is a launch refusal, never ambient discovery.
_Avoid_: Workspace (the registered repository), Workspace registry, Worktree, native Harness config

**MCP server assembler**:
Turns a Workspace's configured MCP servers into the resolved set a Run gets, filling in authentication and checking MCP server readiness before dispatch. Registry identity/version remains provenance and runtime `serverInfo` remains observed metadata; secret values travel on the Harness Request only, never into the ledger or event log.
_Avoid_: MCP skill assembler, credential store (it delegates to that, it is not that), context assembler (that builds instruction layers)

**Context assembler**:
Builds the required layered operating instructions for one harness turn — broad personal, then workspace, then operation-specific — and provisions their resource directory outside the worktree. Every runner renders this output into its native instruction channel; ambient CLI discovery may add optional context but never replaces required operating instructions.
_Avoid_: Prompt builder, system prompt (those are outputs of rendering), MCP server assembler

**Instruction layer**:
One provenance-bearing slice of the context assembler's output, such as broad personal, workspace, or operation-specific operating instructions. Distinct from the work context supplied for one run.
_Avoid_: Context source (opencode's term), rules file

**Owned tool set**:
The owned tools the engine hands a run instead of leaning on the harness's built-ins: `read`, `write`, `edit`, `bash`, `glob`, `grep`, and `webfetch`. Each is a TanStack `toolDefinition` with an Effect handler, and each runs through the run's worktree sandbox rather than touching the host directly. There is no tracker or PR tool — `git` and `gh` ride in on `bash`. File-touching tools go through path confinement first; failures surface as a typed `ToolError`.
_Avoid_: Built-in tools (those are the harness's), MCP server (one server exposes Tools; this set is native)

**Worktree sandbox**:
An `ai-sandbox` `localProcessSandbox` opened onto a run's worktree, so the owned tools read, write, and exec against that checkout and nothing else. Opened as an Effect resource (acquire the handle, release on scope close); the release only tears down the sandbox handle, never the checkout itself. The base SHA it reports is `git rev-parse HEAD`, or `""` when the checkout is not a git repo.
_Avoid_: Worktree manager (that owns the git lifecycle; this is the process boundary a run's tools execute inside), container

**Path confinement**:
The rule that keeps a file-touching tool inside the worktree root: a requested path is normalized (drop leading `/` and any `/workspace` prefix, resolve `.` and `..`) and any path that would climb above the root is rejected as an `out-of-bounds` `ToolError` before the sandbox is asked to do anything. The typed refusal at the tool layer is the point — it fails clearly instead of leaning on the sandbox's more generic error.
_Avoid_: Sandboxing (that's the process boundary), chroot, jail

**File-diff feed**:
The stream of file-change events the live run view consumes. One watcher serves both paths: it batches events, asks `git check-ignore` what to withhold, debounces per path, and computes a unified diff per change against the Run's base SHA, capped per file. Owned tools consume it directly, and an External Harness with no native file events has it merged into its Run. An External Harness that does report native events normalizes them to the same `AgUiEvent`: a `CUSTOM` event named `sandbox.file.diff`. Payload and metadata remain whole, so fidelity stays runner-declared instead of inferred by the client.
_Avoid_: Event log (that's the durable run record), file watcher (that's the mechanism, this is the diff stream on top of it)

**Policy profile**:
The allow/ask/deny rules a run's owned tools are gated by, chosen from the selected operation and its settings. Two engine-owned defaults over one shared tool set: **read-only** for triage (read/glob/grep/webfetch; writes and shell refused), and **full** for implementation and follow-up (everything, with only the hard-deny list as a floor). A profile is a TanStack `ai-sandbox` `SandboxPolicy`, so the engine reuses that package's `evaluateCommand` to match bash against command globs; `write`/`edit` ride the `fileWrite` capability, `webfetch` rides `network`, and `read`/`glob`/`grep` are always allowed. The Harness request carries the resolved profile. A runner declares which profiles it can enforce, plus non-interactive and worktree-confined postures; the Harness service refuses a missing hard posture before the executor claims the item or records a Run. Per-workspace overrides wait for settings-as-data.

`LifecycleStage` is the retained wire name for the three Operations. It maps without aliases: triage uses `read-only`; implement and follow-up use `full`. Run Plan resolution chooses this profile once. The Harness consumes that immutable choice and rejects a mismatched Sandbox policy.

An external Harness receives the same `SandboxPolicy` as engine-owned tools. Its native built-in tools are not Cogwork's bridged server tools: the native adapter projects the policy into its own permission, tool, command, and Sandbox controls, while MCP projection stays a separate transport. `policyFidelity` reports whether that native projection is exact, profile-only, or absent. Provider selection is a separate input to the shared external Harness runtime, not part of Harness selection.

The local-process Sandbox provider is a trusted Runtime Host process boundary. It sets the checkout working directory and scrubs environment variables; it is not container or filesystem isolation. A runner may claim worktree confinement only when its native controls or a future isolated provider enforce it.
_Avoid_: Sandbox isolation (that's the process boundary; this is the decision layer above it), per-tool allowlist (bash is command-matched, not all-or-nothing)

**Ask-compiles-to-deny**:
The AFK keystone. The full allow/ask/deny vocabulary is authored in the profiles, but with no human in the session there is nothing to answer an `ask`, so `ask` compiles to `deny` before the tool runs. A denied call is not an error or a park — it returns a `denied` result the model reads and adapts to, adding no approval RPC and never handing the item to a person. The loop budget, not a human, bounds any thrashing.
_Avoid_: Approval flow / interrupt (that's the interactive phase this defers), tool error (a denial is a normal result, not a failure)

**Hard-deny rule**:
A command-glob rule refused in every profile, for every operation — the small floor under even the full profile. Three destructive shapes: force-pushing to `main`/`master`, piping a download straight into a shell (`curl … | sh`), and recursively deleting an absolute or home path. The model is treated as fallible, not adversarial, so the globs are coarse and a hard-deny just returns `denied` like any other refusal.
_Avoid_: Confinement (that keeps writes inside the worktree root; this bounds shell commands), sandbox isolation

**Operating-instructions package**:
The Operation-owned instruction document and supporting directory carrying its mandatory Operating Instructions. It is supplied through an instruction-specific resource path outside the driven worktree; `SKILL.md` and Skill paths are reserved for real Skills. The engine ships the default package, and a Workspace may replace it whole with an operator-authored package in its private overlay tree (`~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/`); a replacement that is present but has no readable, non-empty `INSTRUCTIONS.md` fails the Run rather than falling back. Either source stays mandatory, last and highest in the instruction ladder, and is never a contribution (ADR 0019).
_Avoid_: Skill, `SKILL.md`, playbook skill, MCP server

**Operation resolution**:
The engine's combination of an Operation Definition, Operation Settings, Operating Instructions, Work Context, Tools, Skills, MCP servers, Middleware, and Sandbox Policy into an immutable Run Plan before dispatch.
_Avoid_: Playbook, resolved stage, prompt assembly

**Issue tracker adapter**:
A concrete implementation of the issue tracker port. `GitHub.adapterLayer` and `Linear.adapterLayer` are the real ones; daemon composition routes by the tracker `type`. Both adapters are the coordination tracker bound to a per-tracker coordination host: the host reads tracker-native issues/labels/comments and supplies the native writes; the choreography — coordination state into a bot-owned coordination comment, human-facing notes (triage proposals) as separate comments — lives in the coordination tracker, once. Linear's host pre-fetches its coordination comments in the item listing and its Canceled-on-wontfix write rides the after-role-change hook. **Claim identity is adapter-owned**: the port's `claim` write takes no `by`; GitHub stamps the authenticated Connection account and Linear stamps `cogwork`, then each reports on every observed item whether that claim is one it would itself have written (`claimedByUs`). Nothing above the seam supplies or compares an identity string. Both hosts resolve their authenticated identity before reading coordination state, so an identity failure stops observation instead of making that state appear absent. Linear reads open blockers from an issue's inverse `blocks` relations (a blocker counts until its own state is `completed` or `canceled`). The tracker no longer observes pull requests — that moved to the source control provider.
_Avoid_: Work source adapter, client (the HTTP/GraphQL client is a lower-level detail), plugin

**Source control provider adapter**:
A concrete implementation of the source control provider port, with GitHub the only one today. Given every observed work item, it resolves the item's PR by the link key: a GitHub closing reference for numeric GitHub items, or the open PR whose head branch starts with `ticketSlug(item.id)`. A pull request is trusted when the actor opened it or a write-access account opened it. It reads checks, reviews, mergeable / base-divergence signal, human comments, the draft flag, and the head branch. Its narrow writes open a pull request and post the daemon's marked round summary. A non-draft same-repository head can drive a follow-up worktree on its exact branch. A draft remains attached to the work item but cannot enter follow-up. A GitHub issue tracker doubles as its own provider by default; a Linear tracker pairs with a GitHub provider through an explicit `sourceControl` config block.
_Avoid_: Forge, code host, client (the HTTP client is a lower-level detail), plugin

**Credential store**:
The seam every Connection credential is resolved through. A Connection id selects a stored API key, an environment-variable reference, or a stored browser grant; the caller receives the token and discovered identity, never the persisted secret. Both Linear and GitHub resolve through it. A stored browser grant refreshes at read time when possible, and a rejected credential can be invalidated. The same store resolves **provider keys** (see below), so one instance holds external-system credentials and AI-provider keys in one file. A keychain-backed layer can arrive behind the same seam later.
_Avoid_: Secret manager, token cache (the credential file, not the store, holds tokens), auth provider

**Provider key**:
An AI provider's API key, resolved through the credential store beside Connection credentials. A provider account is just a provider id plus the env vars a key can live in (most-specific first); resolution prefers a stored key over the environment, and a missing key is an error naming the env vars to set. Keys are durable — no expiry, no refresh — so they persist as a plain `StoredProviderKey` in the `version: 3` credential file; versions 1 and 2 still decode. Bring-your-own-key is the whole story today: a key arrives from the environment or is pasted through `login key`.
_Avoid_: Bearer token (that's the issue-tracker credential with an identity and expiry), secret manager

**Supported providers**:
The in-engine registry of the AI providers cogwork has a runner for — Anthropic, OpenAI, OpenRouter, Google — each with its display name and the env vars its key resolves from. It is the deterministic, offline source of truth for "which providers, which env vars," so key resolution never depends on a network fetch; the models.dev catalog only feeds the model list. A provider is **configured** when a key resolves for it (stored or env); unconfigured providers drop out of the picker silently rather than erroring.
_Avoid_: Model catalog (that's the network list of models; this is the local capability set), provider adapter

**Model catalog**:
The models.dev `api.json` read at runtime for the model picker — provider-keyed JSON decoded down to each model's id and label, filtered to the configured providers. Cached in memory with a TTL; a refresh that fails after a good load serves the stale copy rather than failing the picker, and a cold-cache failure surfaces a typed `CatalogError`. TanStack AI's per-model types remain the compile-time layer; this is the live half.
_Avoid_: Supported providers (that's the local registry), operation model (that's the harness-native model string an operation resolves)

**Model adapter resolution**:
The one owned path from a `provider/model` reference to a live TanStack text adapter: parse the reference, find the wired provider, resolve its key through the credential store, and build the adapter (`resolveModelAdapter` in `src/provider-resolve.ts`). It fails typed — `unknown-model` for an unwired provider prefix or a model the factory has no adapter for, `no-key` when the credential store finds no key. The provider runner resolves through it; the utility-call path (engine ADR 0006's cheap off-session model calls) will resolve through the same seam when its first caller lands — the service was removed until then.
_Avoid_: Provider adapter (that's the per-provider factory this calls), model catalog (that's the picker list, not resolution)

**Token refresh**:
The exchange that trades a stored refresh token for a rotated pair at the issue tracker's token endpoint, and the store's rule for when to run it. It is **reactive** — nothing schedules it, a read that finds an expired or near-expired token triggers it — and **single-flight** per stored credential, so concurrent reads share one exchange rather than racing to spend the same refresh token. The rotated pair is written back to the credential file before the token is handed out, keeping the file the source of truth. A refresh that fails is an auth error, not a quiet fall back to the env var. The store owns the timing; the issue tracker's adapter owns the exchange (`Linear.OAuth.makeTokenRefresh`).
_Avoid_: Token renewal loop, background refresh (there are no timers), re-authentication (that is a fresh grant, not a refresh)

**Client-credentials grant**:
The store's non-interactive OAuth source: it trades an app client id and a client secret read from an environment variable for an app-actor token. It is an adapter capability, never workspace configuration. The minted token is held until its lifetime runs out or the store is told it was rejected; this grant has no refresh token, so a rejection means minting a new one.
_Avoid_: Service account, machine token, app token (that is what it mints, not the source)

**Stored credential**:
One organization's OAuth grant as it is persisted: the token pair, its expiry and scopes, the OAuth client id needed to refresh it, and the identity discovered when it was granted (the organization and the `actorUserId` the app posts as). Keyed by issue tracker and organization, so one file can hold grants for several organizations. The engine defines the shape and the read path; where it lives on disk is the CLI's business.
_Avoid_: Session, Connection record (the `login linear` command mints the grant; the Connection only references it)

**Coordination tracker**:
The single implementation of the issue tracker port's choreography — claim, release, note, the observe-side parse that builds a tracker item, and the **coordination outcomes** (the operation-result writes) — written once over a **coordination host**: the per-tracker bundle of native operations (comment list/edit/create, label add/remove, id resolution, item listing with coordination comments attached), the wire codec, the claim identity, role mapping, and an after-role-change hook (Linear's `wontfix` → Canceled state write). GitHub and Linear both supply a host; a third tracker is a host plus a codec. It exposes coordination outcomes, not the raw step writes: the role change, the attempt record, and the follow-up marker are its private detail, so nothing above the seam sequences them.
_Avoid_: Issue tracker adapter (the host-supplying side), coordination module (the payload and comment policy this calls), shell (say coordination tracker)

**Coordination outcome**:
The single issue-tracker write that records what an operation attempt produced, composing the role change, the attempt record, the follow-up marker, and any note behind one verb on the issue tracker port. The verbs are `triaged`, `implemented`, `followedUp`, `attemptFailed`, `handOff`, `stalled`, and the human-driven `reclassify` and `handBack`; the surviving primitives beside them are `observe`, `claim`, `release`, `note` (free-text operator/recovery prose), and `rateLimitScope`. The executor names the outcome and keeps the exhaustion decision — on a failed attempt it calls `attemptFailed`, then `handOff` only when the attempt count is spent — but it never sequences the tracker writes itself, and it settles its own **run** on the run ledger separately (a coordination outcome touches the tracker only, never the local run). Each verb takes already-parsed data (a role, a proposal string, a `FollowUpMarker`), never the run's raw text.
_Avoid_: Attempt record (one marker an outcome may write), step verb (the raw `setRoles`/`recordAttempt`/`recordFollowUp` an outcome now hides), apply (the executor's old per-operation handler this replaces)

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
The git worktree lifecycle for the repos cogwork *drives*: ensure a branch's checkout exists, list them, remove them, and reconcile away idle ones. It also reports whether the prepared implement worktree is still on the Engine-cut branch and whether that head is ahead of the configured base before the Engine can open a pull request. "Reconcile" here means worktree cleanup — not the reconcile worker. It links only the paths a driven workspace's config declares (`linkPaths`); it is not the setup a coding harness runs when it opens a worktree of *this* repo to work on cogwork itself — that is a repo-local developer concern, deliberately kept separate (see ADR 0005).
_Avoid_: Checkout, clone, worktree setup (that is the repo-local harness concern, not this)

**Branch divergence**:
A worktree branch holding commits its remote branch lacks while the remote holds commits the branch lacks, so no fast-forward can bring them together. The worktree manager resolves it by rebasing the local commits onto the remote; when that rebase will not apply, the divergence is a non-retryable prepare failure that hands the item to a human with its commits untouched (see ADR 0002).
_Avoid_: Conflict (that's one reason a rebase fails), drift, stale branch (that's just being behind)

**Base divergence**:
A pull request's branch and its base branch (`main`) have each gained commits the other lacks and those commits overlap, so the branch can no longer merge into the base. The engine reads it from the source control provider's mergeable signal (GitHub's `dirty`) on the reconcile poll and treats it as a fourth follow-up trigger; the follow-up agent integrates the base — a merge commit by default, a rebase with `--force-with-lease` only where the repo requires linear history — and pushes to the same branch (see ADR 0003). A branch merely *behind* its base (no overlap, still mergeable) is not this and is left alone.
_Avoid_: Branch divergence (that's the branch versus its own remote, not the base), merge conflict (one reason integrating the base fails), stale branch (that's merely behind)

**Workspace registry**:
The Control-store-backed set of registered workspaces and Workspace-input failures, held in a cell folded from workspace management acts. Register mints each `WorkspaceId`. Update replaces the mutable non-path record and leaves Private workspace overlays intact. Re-bind changes only its checkout path. Deregister removes it from the cell before the next scheduler pick, while a Run already holding its workspace value finishes normally. Each act publishes the matching workspace change or removal. The engine's view of which repos it is driving.
_Avoid_: Config store. Distinct from the harness runner map, which is also a "registry" of sorts.

**Telemetry store**:
The dedicated local SQLite file (`~/.cogwork/telemetry.db`) holding the app's own spans and metric snapshots — observations about the process, disposable and pruned, never authoritative product records (ADR 0020). Deliberately not the Control store, so the instrument never queues behind the write lock it measures.
_Avoid_: Control store (the authoritative store; ADR 0015's one-database rule stands for product records), run ledger (a run's harness events, which are product history), log file

**Performance sensor**:
Deterministic engine code that watches the telemetry store's health signals and, on a sustained threshold breach, files a thin evidence ticket at `needs-triage` with an `origin:selfperf` label and a fingerprint marker (ADR 0021). The proactive layer's first non-tracker sensor; it fires on transitions into alarm, dedups against the tracker itself, and never reopens a closed issue.
_Avoid_: Detector, watchdog, monitor (a Datadog-style alert rule), triage (the stage that verifies what the sensor files)

**Replay runner**:
A measurement-only harness runner that decodes an exported Run fixture and streams its recorded AG-UI events at recorded speed or a selected multiplier. It enters through the normal harness seam, so downstream recorder, ledger, bus, transport, and clients are measured without starting an agent subprocess or doing worktree I/O. Count stability is the correctness gate; timing comparison needs at least 10 warm-ups, 10 paired samples, and a confidence interval that excludes no-change.
_Avoid_: Fake runner (a test double asserting behavior; this one generates load), simulator, benchmark (the measurement around it, not the runner)

**Signal**:
One health number the performance sensor watches: a named reading from the telemetry store (the daemon's event-loop delay p99, heap headroom) paired with a fixed threshold and window. The set is enumerated and deliberately small; the filing cap bounds the tickets, never how many signals may be watched (ADR 0021).
_Avoid_: Metric (the raw telemetry reading a signal is defined over), alert (an alerting product's rule), alarm (the state a breached signal enters, not the signal itself)

**Fingerprint**:
The stable identity of one regression: a string over signal, subsystem, and direction — measured values excluded — carried as a marker in a machine-filed ticket's body, so dedup derives from the tracker itself. Many firings with different numbers share one fingerprint and therefore one open ticket (ADR 0021).
_Avoid_: Hash (an implementation detail), signature (audiodog's word for the same idea), occurrence (one firing, which a fingerprint groups)
