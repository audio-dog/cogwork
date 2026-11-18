# Engine (orchestration runtime)

The work control plane packaged as an embeddable library — the machinery that discovers, schedules,
and runs work. It owns the *verbs*; the nouns live in the shared kernel
([contracts](../contracts/CONTEXT.md)). It has no process identity of its own; the daemon hosts it.

Role in the flow: **observe → schedule → run → dispatch to a harness**. See the root
`CONTEXT-MAP.md` for the end-to-end story.

## Language

**Daemon**:
The long-lived host process that runs the engine on one machine: it serves the RPC group and drives Trigger observation, scheduling, and performance-regression heartbeats. Not a class — a set of modules composed at startup. `Daemon.serverLayer(hostAdapters)` assembles the RPC server, framing, stores, registry, Harnesses, scheduler, Trigger sources, and Workflow runner.
_Avoid_: Engine, orchestrator app, server (that's the RPC transport)

**Trigger observation**:
The background service that asks every active Trigger source for source revisions, matches each event to published Workflows, and durably admits each match. It is the scheduler's source of waiting work.
_Avoid_: Reconcile worker, snapshot, classifier

**Rate-limit scope**:
The key the Linear client backs off on to say *whose* request budget a call spends. Linear's budget is per user and shared across every key that user owns, so its scope is the token env var — all workspaces reading through one token back off together. The GitHub client fails fast inside its own cooldown instead.
_Avoid_: Credential id (the credential store's business), workspace key (the point is that it is *not* per workspace)

**Cooldown window**:
The span a rate-limit scope is held out of polling for, opened when a source reports `rate-limited`. Length comes from the source's own retry timing when it has any (Linear's `retryAfter` / `requestsResetAt`), and from exponential backoff when it doesn't. Entering a window warns once; the skipped ticks in between are quiet, and a successful poll closes it.
_Avoid_: Circuit breaker (nothing is tripped open by error rate), throttle

**Ready-to-merge view**:
A read-model projection of Cogwork-opened pull requests that are open, not drafts, green, conflict-free, and approved. It runs no model and changes no Workflow state.
_Avoid_: Classification, merge stage, role

**Assignee ownership gate**:
A per-workspace Trigger-observation precondition: when `issueTracker.assigneeAllowlist` is set, an observed tracker item is admitted only when an assignee is on the list. A pull request is admitted only when a work item that its link key names has an assignee on the list. When no work item is linked, the pull request author must be on the list. A pull request event without its author and link key is not admitted. Absent means no gate. The bound Connection's account is distinct from whose work the daemon may take.
_Avoid_: Assignee filter (it gates every Workflow, not just a view), permission check

**Scheduler**:
The in-memory concurrency gate. It picks eligible Trigger admissions under global, per-workspace, and daily-budget limits, then forks a Workflow Run. Waiting work orders by whether the Workflow already acted on the item, priority, then oldest observed revision.
_Avoid_: Queue, dispatcher, runner

**Drain**:
The scheduler's graceful stop: it picks no further candidates and gives the runs already in flight a **grace window** to finish on their own and record their normal outcome. Whatever is still running when the window closes — or when a second stop signal ends the wait early — is recorded `interrupted` and its agent torn down.
_Avoid_: Shutdown (the whole process exit, of which this is one step), quiesce, graceful kill

**Crash recovery**:
The boot pass that runs once before the first scheduler tick. Each Run still `running` from a daemon that stopped without draining is marked `crashed`, the Claim this daemon holds on its item is released so the item is admitted again, and three crashed Runs in a row since the last handback park the item `exhausted` (ADR 0036).
_Avoid_: Claim recovery (the fixed pipeline's sweep, deleted), drain (the graceful stop, the mirror image of this)

**Candidate**:
A schedulable Trigger admission plus the reservation keys that keep it from being picked twice.
_Avoid_: Job, task

**Workflow runner**:
The unit that executes one admission: claim, prepare the Run, resolve and persist the Run Plan, dispatch the Harness, record events, decode the document-derived Operation result, freeze and execute the Action plan, then complete the Run and route a hand-off or Stop. It orchestrates; the decisions sit in **Run Plan resolution** and **Run completion**.
_Avoid_: Executor, fixed pipeline, stage runner

**Run preparation**:
The step between claim and dispatch that ensures the checkout, chooses the Session, provisions the instruction layers, runs Harness preflight, and gathers the facts Run Plan resolution decides over. It owns every side effect a Run needs before it starts; it makes no decision about the Plan's contents.
_Avoid_: Setup, bootstrap, Run Plan resolution (the decision this step feeds)

**Run completion**:
The decision, taken from a Run's result and the item's coordination view, of what follows: retry, exhaust, park stuck, fan out, complete, or hand off. One decision serves a fresh Run, a resumed Action plan, and a review-plan refresh, so the failure counters and park reasons are applied in one place. An accepted Run always settles. A typed failure or a defect after the Claim is an input to this decision. It records one failed attempt and settles the Run `failed` or `exhausted`. An interruption settles the Run `interrupted` and records no attempt (ADR 0016).
_Avoid_: Outcome handling, completion closure, failure policy (one input to it), disposition

**Run recorder**:
The one seam a run's harness events cross between the harness runner and everything that reads them. Recording is one act with four parts: assign the event's sequence, encode it as a run event, append it to the run ledger (capturing an opaque session handle when one rides the event), and publish the same moment as run activity. Reads come back through the same seam — a settled run replays as run activity for the drill-in, and a session's events decode for the transcript fold — so live and replayed activity are identical by construction. The recorded-event codec is shared only with the replay harness, which needs the same decode boundary.
_Avoid_: Run ledger (the store it writes to), daemon event bus (the transport it publishes on), event log, persistence (the TanStack adapter the session store hands the provider runner)

**Session store**:
The place sessions are minted and the read model a runner pulls a session's history from, given a `SessionId`. `mint` takes a harness name and the harness service's kind lookup, chooses the session kind from that runner's declaration, and inserts the row — owned-transcript for the provider runner (the run ledger holds the conversation), opaque-handle for a CLI harness (the harness holds its own history, with a null handle until one is captured). The Workflow runner asks for a session and never names a kind itself. It hands the provider runner a real `@tanstack/ai-persistence` adapter (`persistence`) that the runner runs under via `withPersistence`. Its **message store** is a ledger projection: `loadThread` folds the session's transcript out of the run ledger — every event across the runs that share the session (oldest run first), including terminal structured results, projected into ordered model messages — and `saveThread` is a no-op, because the run recorder already appends every event, so the event-sourced ledger stays the one source of truth. Beside the message store sit process-scoped **run** and **interrupt** stores that wire durable pause/resume ahead of the interactive phase; they live in memory, matching the run ledger's own durability, and a persistent ledger backend will carry them too. `resumeHandle` still hands back the session's opaque handle, the thing a CLI runner needs to resume its own history. An empty transcript is `[]` and an unhandled session is a null handle, never a failure. There is no second transcript store: the run ledger is the only place a conversation lives.
_Avoid_: Message store (that's the persistence library's term for the one piece of the adapter), transcript database, second store

**Harness request**:
The projection the Workflow runner hands the harness for one accepted Run Plan, plus secret MCP credentials and a `session` reference — the `SessionId` this run continues, or null for a fresh start. The harness consumes the Plan's frozen Messages, Instructions, model, model options, and policy. It references a session rather than shipping one; no frozen transcript crosses the seam, so compaction can live inside the runner's loop where context actually grows.
_Avoid_: Prompt (that's now one field of the envelope), transcript (the request carries a reference, not history)

**Harness service**:
The engine's registry and dispatcher for Harness runners. It exposes each runner's Session kind, operational profile, controlled option catalog, and readiness; performs static preflight before claim and full Plan preflight before launch; and dispatches only to the selected runner, with no Harness or authentication fallback. Machine-local enablement is a separate Control-store fact: absent means enabled, and disabled refuses new or resumed Runs before claim without changing observational readiness or an accepted Run.
_Avoid_: Harness (the concept, defined in contracts), model

**Harness runner**:
A pluggable implementation of one agent backend. Beside dispatch it declares its Session kind, operational facts, explicit authentication binding, managed option catalog, observational readiness, and authoritative preflight; unavailable runners remain registered without preventing unrelated Harnesses from running.
_Avoid_: Harness service, adapter (adapter is the issue-tracker term)

**Harness capability profile**:
The runner-declared operational facts TanStack does not expose at runtime: supported authentication modes, Session affinity, fork and human-attach behavior, structured-output reliability, policy and file-event fidelity, usage quality, readiness diagnostics, and journal/takeover support. File-event fidelity is `terminal-only`, `best-effort`, or `absent`. It is a declaration a client reads, never a switch: whether the runtime feeds a descriptor's file activity from the checkout is the descriptor's own `transport.runtimeFileDiffFeed`, so making a profile more honest cannot turn file activity off. Claude Code and Codex declare journal and takeover support; Cursor ACP declares neither. These facts describe adapter capability only. They do not activate durable execution. Adapter models, provider options, modalities, middleware requirements, and Sandbox requirements stay TanStack-owned runtime facts.
_Avoid_: Feature flags, adapter metadata, projection matrix

**External Harness runtime**:
The engine-owned execution module beneath Claude Code, Codex, and Cursor. It validates the prepared checkout before adapter work, builds the trusted local-process Sandbox provider, applies the descriptor's inherited-environment allow list, and preflights the explicit authentication binding, mandatory Harness Workspace and MCP projection, and descriptor-required shared Git metadata before composing the typed TanStack adapter, `chat()` stream, cancellation, event bridge, and optional usage estimate. It normalizes supported native file activity to `sandbox.file.diff` without rebuilding the payload, and for a descriptor with no native file events it merges the engine's own File-diff feed instead of enabling the Sandbox watcher, holding `RUN_FINISHED` back until that feed has drained so the last write is not recorded behind the event a client stops reading at. A descriptor declares `Tools` when its adapter carries `chat()` tools to the CLI through TanStack's host MCP tool bridge; only then does the Run Plan list the Operation's engine tools and the runtime pass them to `chat({ tools })`, and nothing is written for them into the checkout beyond the adapter's own per-Run files. Claude Code and Codex declare `Tools`; Cursor does not. A descriptor that declares `Skills` gets the Run Plan's Skills through the same bridge (see **Skills supply**); Claude Code and Codex declare it. It passes the Cogwork `RunId` as TanStack `runId`, the Cogwork `SessionId` as `threadId`, and any opaque native handle only through adapter model options. Its `withSandbox` call is intentionally nondurable: no Run store, stream durability, journal, detach, attach, or takeover option is present. Driver loss therefore cannot leave an intentional detached agent or trigger attach-first recovery. It also derives which Git paths a Run may write: a linked Worktree gets its own Worktree entry plus the common directory's `objects`, `refs`, `logs`, and its packed-ref files, never the common directory itself, a read-only Operation gets nothing at all because it commits nothing, and a checkout that owns its Git directory gets nothing either — that directory is the common one every Worktree shares, and Git's `index.lock` sits in its root, so there is nothing narrower to grant. No Run can write the shared `config`, install a hook, or disturb a sibling Worktree.
_Avoid_: Harness service (the dispatcher above it), Harness runner (the engine-facing backend seam), provider runner (the owned-transcript path)

**Harness Workspace projection**:
The one portable TanStack Workspace definition the external Harness runtime creates for each Run. It carries fresh per-Run authentication and MCP `SecretRef`s. By default it also carries resolved MCP servers; a descriptor that declares native MCP projection consumes those servers from its request instead. The runtime also carries the Context assembler's ordered mandatory Instructions and the host-provisioned Operating Instructions package path, then uses the descriptor's native instruction channel. TanStack renders each Workspace input into the native Harness form. The work-specific Message remains the user turn, public MCP servers get no invented secret, and secret values resolve only into the live Sandbox environment. Events and Harness errors are scrubbed before they reach the caller or ledger. When the Workspace has secrets but no files to project, the runtime hands the adapter an already-satisfied projection, so the adapter's file-based projection pass writes nothing into the prepared checkout. Its source is `none` and snapshots are off: the runtime's local-process Sandbox provider binds the prepared checkout, while the Worktree manager continues to own checkout, branch, Git metadata, and cleanup. A missing required projection is a launch refusal, never ambient discovery.
_Avoid_: Workspace (the registered repository), Workspace registry, Worktree, native Harness config

**Skills supply**:
How a Run gets the Skills its Run Plan admits. The Workflow runner admits every Skill contribution of the Run's Workspace from the three Authoring trees and from loaded Plugins, one per name: a Skill the Operation requires wins its name; otherwise the first identity in sort order wins (`local:private`, then `local:repo`, then `local:user`, then Plugins). The provider runner and each external Harness that declares `Skills` add TanStack's `withSkills` middleware over an engine-owned `SkillSource` that serves only the Run Plan's Skill members. The agent gets a catalog of those Skills in its system prompt and a `load_skill` tool that reads one Skill's `SKILL.md` and refuses any other name. A Skill whose file does not read or parse, or that does not fit the catalog limit, is left out of the catalog with a warning; the Run continues. Nothing is written into the checkout. Claude Code, Codex, and the provider runner project `Skills`; Cursor does not, so an Operation that requires a Skill gets a Run Plan rejection that names the Skill and the Harness. Codex can also show a Skill from `~/.agents/skills` or `.agents/skills` by its own discovery; that duplicate is accepted.
_Avoid_: Skill projection into the Workspace (no Skill file is written), Operating-instructions package (not a Skill)

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
An `ai-sandbox` `localProcessSandbox` opened onto a Run Plan's Workspace checkout, so the owned tools read, write, and exec against that checkout and nothing else. With no Workspace it owns an empty scratch directory instead. It is an Effect resource: scope close removes an owned scratch directory, but never a Workspace checkout. The base SHA it reports is `git rev-parse HEAD`, or `""` when the checkout is not a git repo.
_Avoid_: Worktree manager (that owns the git lifecycle; this is the process boundary a run's tools execute inside), container

**Path confinement**:
The rule that keeps a file-touching tool inside the worktree root: a requested path is normalized (drop leading `/` and any `/workspace` prefix, resolve `.` and `..`) and any path that would climb above the root is rejected as an `out-of-bounds` `ToolError` before the sandbox is asked to do anything. The typed refusal at the tool layer is the point — it fails clearly instead of leaning on the sandbox's more generic error.
_Avoid_: Sandboxing (that's the process boundary), chroot, jail

**File-diff feed**:
The stream of file-change events the live run view consumes. One watcher serves both paths: it batches events, asks `git check-ignore` what to withhold, debounces per path, and computes a unified diff per change against the Run's base SHA, capped per file. Owned tools consume it directly, and an External Harness with no native file events has it merged into its Run. An External Harness that does report native events normalizes them to the same `AgUiEvent`: a `CUSTOM` event named `sandbox.file.diff`. Payload and metadata remain whole, so fidelity stays runner-declared instead of inferred by the client.
_Avoid_: Event log (that's the durable run record), file watcher (that's the mechanism, this is the diff stream on top of it)

**Policy profile**:
The allow/ask/deny rules a Run's owned tools are gated by. A Workflow Operation chooses `read-only` or `full`. The Harness request carries the immutable choice, and a Harness declares which profiles it can enforce.

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

**Run Plan resolution**:
The decision that combines the published Operation, Default settings, Operating Instructions, Work Context, contributions, Sandbox Policy, and the tool needs its Action entries declare into one immutable Run Plan — or into a **Run Plan rejection** with its reason when the machine cannot satisfy the Operation. It decides over facts Run preparation gathered and performs no side effect.
_Avoid_: Fixed Operation resolution, stage resolution, prompt assembly, decline (the runner's act on a rejection)

**Action entry**:
One registered output action: its catalog row, the target it freezes, the write it performs, its phase in the Action plan's fixed order (approval, write, notify, terminal), and the engine Tools a Run needs to use it. Registered once under its full catalog key; the Trigger and action catalog's action rows derive from the registry, so a row cannot exist without its write. The row also gives the entry's **Workspace source**: where its target's Workspace comes from — the item, else the agent's choice (`item-else-agent`), or the agent's choice only (`agent`). The target producer reads the Workspace through that field, and the Operation result asks the agent for a Workspace only when the field says the agent chooses it.
_Avoid_: Action executor (one field), catalog row (one field), handler, action definition

**Issue tracker adapter**:
A concrete implementation of the issue tracker port for GitHub or Linear. It supplies the tracker-native reads — items changed since a cursor, when a label was applied, an item's prose with each comment marked as a person's or not — loads Work Context, and performs catalog actions such as adding a label or posting a comment. It observes nothing by itself; the Tracker Trigger source observes through it. Coordination is a separate authority.
_Avoid_: Work source adapter, client (the HTTP/GraphQL client is a lower-level detail), plugin, Trigger source (the module that reads through it)

**Tracker Trigger source**:
The one Trigger source implementation for issue trackers, instantiated once per tracker system over the issue tracker port. It owns polling, per-workspace cursors, catch-up, the label and comment source revisions, the origin-record cause, and the Cogwork-marker filter; it holds no tracker-specific branch. Each instance keeps its own source id so one tracker's cooldown never stops the other's polling.
_Avoid_: GitHub Trigger source, Linear Trigger source (instances, not modules), pull request Trigger source (the source control port's own)

**Source control provider adapter**:
A concrete implementation of pull-request Trigger sources and Workflow actions, with GitHub the only one today. It also projects the ready-to-merge view from Cogwork origin records and live pull-request state.
_Avoid_: Forge, code host, client (the HTTP client is a lower-level detail), plugin

**Credential store**:
The seam every Connection credential is resolved through. A Connection id selects a stored API key, an environment-variable reference, or a stored browser grant; the caller receives the token and discovered identity, never the persisted secret. Linear, GitHub, Granola, and Slack resolve through it. A stored browser grant refreshes at read time when possible; Slack refresh also replaces the single-use refresh token. A rejected credential can be invalidated. The same store resolves **provider keys** (see below), so one instance holds external-system credentials and AI-provider keys in one file. A keychain-backed layer can arrive behind the same seam later.
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

**Coordination module**:
The authority-neutral fold over claims, attempts, parks, handbacks, source revisions, and lineage. Every item's records live in the Control store, issue-backed items included (ADR 0036). A **hand-off** means only a Workflow Transition routing to another Operation; coordination never uses it to mean escalation or explanation.
_Avoid_: Coordination tracker, role write, hand-off explanation, follow-up marker

**Park notice**:
The one marked comment the Coordination module posts on a parked issue: the park reason and the Attention command that continues the item. It is Workflow output for a person, never a coordination record, so nothing reads it back. The raw failure behind an `exhausted` or `write-failed` park stays in Cogwork. The notice posts on a fiber that the Coordination layer owns, so a park returns before the tracker write ends. A notice that does not post is logged, and the park stands (ADR 0036).
_Avoid_: Coordination comment (the deleted fixed-pipeline ledger), stuck comment (every park kind gets one)

**Worktree manager**:
The git worktree lifecycle for the repos cogwork *drives*: ensure a branch's checkout exists, list it, remove it, and reconcile away idle ones. An implement worktree blocks its normal push path with a worktree-only invalid `pushurl`; follow-up retains agent-owned push. Before the Engine opens a pull request, it refreshes the base and requires the local Engine-cut head to be ahead. The Engine then pushes that head through the selected remote's explicit URL. Pull request readiness does not depend on a Run worktree still existing. "Reconcile" here means worktree cleanup: the maintenance heartbeat keeps the worktrees of open tracker items, open pull requests, and running Runs, and removes the rest. It links only the paths a driven workspace's config declares (`linkPaths`); it is not the setup a coding harness runs when it opens a worktree of *this* repo to work on cogwork itself — that is a repo-local developer concern, deliberately kept separate (see ADR 0005).
_Avoid_: Checkout, clone, worktree setup (that is the repo-local harness concern, not this)

**Branch divergence**:
A worktree branch holding commits its remote branch lacks while the remote holds commits the branch lacks, so no fast-forward can bring them together. The worktree manager resolves it by rebasing the local commits onto the remote; when that rebase will not apply, the divergence is a non-retryable prepare failure that hands the item to a human with its commits untouched (see ADR 0002).
_Avoid_: Conflict (that's one reason a rebase fails), drift, stale branch (that's just being behind)

**Base divergence**:
A pull request's branch and its base branch (`main`) have each gained commits the other lacks and those commits overlap, so the branch can no longer merge into the base. The engine reads it from the source control provider's mergeable signal (GitHub's `dirty`) on the pull request Trigger source's poll and treats it as a **follow-up trigger** in its own right — one the agent clears by working, which is what qualifies it (see ADR 0013); the follow-up agent integrates the base — a merge commit by default, a rebase with `--force-with-lease` only where the repo requires linear history — and pushes to the same branch (see ADR 0003). A branch merely *behind* its base (no overlap, still mergeable) is not this and is left alone.
_Avoid_: Branch divergence (that's the branch versus its own remote, not the base), merge conflict (one reason integrating the base fails), stale branch (that's merely behind)

**Workspace registry**:
The Control-store-backed set of registered workspaces and Workspace-input failures, held in a cell folded from workspace management acts. Register mints each `WorkspaceId`. Loading resolves the selected worktree remote (`origin` by default) and derives one GitHub `owner/repository` for any GitHub tracker or source control provider; register, update, refresh, and re-bind therefore follow the checkout instead of stored repository text. A required missing or unsupported remote makes that Workspace input fail. Update replaces the mutable non-path record and leaves Private workspace overlays intact. Re-bind changes only its checkout path. Deregister removes it from the cell before the next scheduler pick, while a Run already holding its workspace value finishes normally. Each act publishes the matching workspace change or removal. The engine's view of which repos it is driving.
_Avoid_: Config store. Distinct from the harness runner map, which is also a "registry" of sorts.

**Telemetry store**:
The dedicated local SQLite file (`~/.cogwork/telemetry.db`) holding the app's own spans and metric snapshots — observations about the process, disposable and pruned, never authoritative product records (ADR 0020). Deliberately not the Control store, so the instrument never queues behind the write lock it measures.
_Avoid_: Control store (the authoritative store; ADR 0015's one-database rule stands for product records), run ledger (a run's harness events, which are product history), log file

**Performance regression sensor**:
Deterministic engine code that watches the telemetry store's health signals and, on a sustained threshold breach, files a thin evidence ticket at `needs-triage` with an `origin:selfperf` label and a fingerprint marker (ADR 0021). The proactive layer's first non-tracker sensor; it fires on transitions into alarm, dedups against the tracker itself, and never reopens a closed issue.
_Avoid_: Performance sensor (ambiguous once budgets also file), detector, watchdog, monitor (a Datadog-style alert rule), triage (the stage that verifies what the sensor files)

**Performance verdict**:
One sensor's decision that a performance claim holds, handed to the Performance issue filer as data: the kind (health signal, suite comparison, suite budget, test-file budget), the signal, subsystem, and direction, the numbers, and the evidence. The filer renders the ticket from it; a sensor never writes ticket text or a Fingerprint string itself.
_Avoid_: Alarm (the state a health signal is in), finding, report (the comparison tool's JSON, which a verdict is decoded from)

**Performance issue filer**:
The one engine module that turns a Performance verdict into tracker action: dedup by Fingerprint against the tracker, the shared daily cap, file or comment, re-file and never reopen (ADR 0021). Three sensors call it — the regression sensor in the daemon, the suite comparison and the budget check in CI — and one GitHub adapter sits behind it, reached through the GitHub client alone. A capped verdict in CI fails the job rather than vanishing.
Its home is `src/performance-issue-filer.ts`.
_Avoid_: Sensor (the caller that decides), issue tracker adapter (the coordination port, which the filer does not use), script filer (deleted)

**Performance budget sensor**:
A scheduled job that measures a performance budget and files a ticket while the budget is unmet (ADR 0023). It fires on a standing condition rather than a transition, so it files about work the app has never done; it never gates a merge, and it hands a `budget` Performance verdict to the Performance issue filer, sharing its label, Fingerprint, and cap.
_Avoid_: Performance regression sensor (fires on change, not on level), budget gate (nothing here blocks a merge), optimizer (it proposes work, it does not do it)

**Performance budget**:
A named count of the app's own work paired with a target below what the app does today, so that missing it is the normal state until someone improves the code (ADR 0023). Counts, never durations, because wall clock on one laptop is not comparable to itself; met budgets are lowered again rather than retired.
_Avoid_: Threshold (a health signal's alarm line, which sits above healthy), SLO (assumes a fleet and an error budget), quota, limit (the scheduler's caps on concurrent work)

**Replay runner**:
A measurement-only harness runner that decodes an exported Run fixture and streams its recorded AG-UI events at recorded speed or a selected multiplier. It enters through the normal harness seam, so downstream recorder, ledger, bus, transport, and clients are measured without starting an agent subprocess or doing worktree I/O. Count stability is the correctness gate; timing comparison needs at least 10 warm-ups, 10 paired samples, and a confidence interval that excludes no-change.
_Avoid_: Fake runner (a test double asserting behavior; this one generates load), simulator, benchmark (the measurement around it, not the runner)

**Health signal**:
One health number the performance regression sensor watches: a named reading from the telemetry store (the daemon's event-loop delay p99, heap headroom) paired with a fixed threshold and window. The set is enumerated and deliberately small; the filing cap bounds the tickets, never how many signals may be watched (ADR 0021).
_Avoid_: Signal (bare, now that budgets are also watched), performance budget (a target below current behaviour, not an alarm line above it), metric (the raw telemetry reading a signal is defined over), alert (an alerting product's rule), alarm (the state a breached signal enters, not the signal itself)

**Fingerprint**:
The stable identity of one machine-filed performance claim: a string over signal, subsystem, and direction — measured values excluded — carried as a marker in a machine-filed ticket's body, so dedup derives from the tracker itself. Many firings with different numbers share one fingerprint and therefore one open ticket (ADR 0021).
_Avoid_: Hash (an implementation detail), signature (audiodog's word for the same idea), occurrence (one firing, which a fingerprint groups)
