# Work

Part of the [Contracts (shared kernel)](CONTEXT.md) glossary.

**Issue tracker**:
The external system that is authoritative for backlog work — its items, their human-visible roles, and the coordination markers written back onto them. Configured per workspace; GitHub Issues and Linear are the adapters today. Renamed from "work source": once pull requests moved to their own port (the source control provider), what remained was purely the tracker.
_Avoid_: Work source, backlog, control-plane database, internal store

**Source control provider**:
The port that answers what trusted pull request belongs to each observed work item and what that PR's state is (checks, reviews, mergeable / base divergence, human comments, draft status). It resolves the PR by the item's link key. A coordination comment is not required for observation. A draft pull request remains linked but cannot trigger follow-up. Its narrow writes open a pull request and post the daemon's marked round summary. Coordination stays on the issue tracker; push and rebase stay with the agent. Chosen per workspace independently of the tracker; GitHub is the only provider today, and a GitHub issue tracker doubles as its own provider by default.
_Avoid_: Forge, code host, work source, git client (the HTTP client is a lower-level detail)

**Work item**:
The one thing a Run acts on. An issue tracker supplies it, identified by a branded `WorkItemId` (e.g. a GitHub issue like `#13`, or a Linear identifier like `AUD-1`), or the engine **mints** it from a Trigger event — a Granola note, a Slack message or conversation, a schedule instant, a pull request no issue links, or a fan-out element. An engine-minted item's identity derives from an immutable source identity, never from model output, and no author writes a key; its coordination lives in the Control store (ADR 0033). Each item has a kind, which fixes its Work context.
A tracker item carries a title and, once observed, its roles, claim, and attempts; its pull request is resolved separately by the source control provider, not carried as a tracker property.
_Avoid_: Task, job, ticket (except when naming the tracker's own UI), Trigger event (it names an item; it is not one)

**Link key**:
The stable key tying a work item to its pull request across systems. GitHub numeric work items first match an open PR's GitHub-resolved closing reference (`Closes #N`); all items retain the `ticketSlug(item.id)` branch-prefix fallback (`fel-157-…`, `13-…`). The engine-cut branch remains stable because it derives from the immutable item id rather than the title. A same-repository closing-reference match carries its actual head branch into follow-up.
_Avoid_: PR reference, branch name (the full branch also carries a title slug that can drift)

**Workspace**:
A repo registered with the daemon under a minted `WorkspaceId`: a checkout path bound to an issue tracker and, optionally, a source control provider, plus workflow and operation settings. Checkout path is a re-binding hint, never identity. The unit of isolation and per-repo configuration.
When either Engine port uses GitHub, its `owner/repository` is runtime data derived from the checkout's selected worktree remote (`origin` by default). It is not a second configurable repository.
_Avoid_: Project; not pnpm's or TanStack's "workspace"

**Actor identity**:
Who the daemon acts *as* on a tracker — the authenticated account discovered from the bound **Connection**. It authors the daemon's tracker writes and marks which comments and pull requests are the daemon's own. A workspace stores only the Connection binding; it has no separate actor selector.
Because that account is the person's own, it cannot tell Cogwork's writes from the person's. In a Workflow the **origin record** decides which writes are Cogwork's, never the account.
_Avoid_: Bot id, owner (that's the allowlist), principal (that's an RPC caller)

**Assignee allowlist**:
`issueTracker.assigneeAllowlist` — an optional, non-empty-when-present list of tracker-native identities whose assigned tickets this workspace is *allowed to pick up*. Absent means no gate: every item is eligible, as before. Distinct from the actor identity: this is whose work the daemon may take, not who it acts as. Enforced by the engine's Trigger observation, not here.
_Avoid_: Assignee filter, owner list (it's an allowlist of several), actor

**Bot allowlist**:
`sourceControl.botAllowlist` (with the same fallback field on `issueTracker` the source-control target already borrows) — an optional, non-empty-when-present list of bot logins whose PR feedback is trusted to *wake a follow-up*. Absent means the gate is off: no bot ever wakes one, exactly as before.
**A trusted bot wakes a follow-up only when it opens a new thread on a line of the diff.** A bot's narration of the pull request — a summary comment, a review header, an automation note — is not a finding and wakes nothing, and neither is a reply inside a thread somebody else opened. An entry ending in `:any` drops the shape test and takes every comment that bot writes; it is the escape hatch for a bot that only speaks at pull-request level. Human feedback is unaffected: a person's PR-level comment still wakes a follow-up and can still set `/fresh`.
A listed bot's finding is a wake signal only. It can never set `/fresh` and grants no steering: a trusted-bot finding is actionable context, like a failing check, never an instruction. Distinct from the actor identity (who the daemon acts as) and the assignee allowlist (whose tickets it may pick up).
_Avoid_: Bot filter, trusted authors (humans aren't on it), steering (a bot never steers), *bot comment* as a synonym for *finding* (most of what a bot writes on a PR is neither)

**Follow-up trigger**:
A source-control **Trigger** entry for failing required checks, a **base divergence**, new human feedback, or a trusted bot's finding. Source revisions make the rule structural: a standing state has no new revision, so it cannot wake follow-up again.
**A trigger must be a condition the agent can clear** — either by working or by answering it once. A condition the agent has no power to clear is pull-request state, not a Trigger. A standing `changes-requested` review therefore wakes nothing on its own; its prose and inline comments remain human-feedback occurrences. See engine ADR 0013.
_Avoid_: Follow-up reason; *wake signal* as a synonym (that names a trusted bot's finding in particular); review decision (that's a state a trigger is defined against)
