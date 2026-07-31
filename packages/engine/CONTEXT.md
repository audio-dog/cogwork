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
The background worker that polls every workspace's work source, classifies the results, and stores them in an in-memory reconcile snapshot. One of the daemon's two heartbeats.
_Avoid_: Sync, poll loop. Distinct from worktree reconcile (cleanup) and claim recovery (releasing stale claims).

**Classification**:
The partition of a work source's observed items into eligible, claimed, and blocked, each tagged with a lifecycle stage. Produced by `classify`.
_Avoid_: Filtering, triage (triage is a stage, not this)

**Scheduler**:
The in-memory concurrency gate. It picks candidates from the reconcile snapshot under a global limit, per-workspace limits, and a daily budget, then forks an executor for each. In-flight counts and budgets live here and nowhere else.
_Avoid_: Queue, dispatcher, runner

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
A workspace's binding of a lifecycle stage to a prompt template, skill, and harness/model choice. The engine resolves a stage's playbook into a `ResolvedStage` before executing. Stages can be disabled per workspace; only `triage` and `implement` are wired today.
_Avoid_: Workflow, pipeline

**Work source adapter**:
A concrete implementation of the work source port. `GitHub.adapterLayer` is the only real one; it reads issues, labels, and comments, and writes coordination markers into a bot-owned comment.
_Avoid_: Client (the GitHub HTTP client is a lower-level detail), plugin

**Coordination markers**:
The HTML-comment records (claim, attempt, ledger anchor) the GitHub adapter writes into a single bot-owned comment on an issue, so the control plane's coordination state travels with the work source.
_Avoid_: Metadata. The "ledger" marker here is not the run ledger.

**Worktree manager**:
The git worktree lifecycle: ensure a branch's checkout exists, list them, remove them, and reconcile away idle ones. "Reconcile" here means worktree cleanup — not the reconcile worker.
_Avoid_: Checkout, clone

**Workspace registry**:
The loaded set of registered workspaces (and the failures from loading), built by folding workspace registration events. The engine's view of which repos it's driving.
_Avoid_: Config store. Distinct from the harness runner map, which is also a "registry" of sorts.
