# Engine glossary: Daemon and scheduling

Part of the [engine glossary](./GLOSSARY.md).

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
Only a successful read decides "not on the list". A failed lookup is not an answer: the event waits, and the Trigger source reports the failure.
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
