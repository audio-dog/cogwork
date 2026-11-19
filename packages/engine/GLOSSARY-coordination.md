# Engine glossary: Coordination and worktrees

Part of the [engine glossary](./GLOSSARY.md).

**Coordination module**:
The authority-neutral fold over claims, attempts, parks, handbacks, source revisions, and lineage. Every item's records live in the Control store, issue-backed items included (ADR 0036). A **hand-off** means only a Workflow Transition routing to another Operation; coordination never uses it to mean escalation or explanation.
_Avoid_: Coordination tracker, role write, hand-off explanation, follow-up marker

**Refused claim**:
A claim the coordination authority will not accept, such as a claim on an item whose source revision was never observed. Distinct from a *contended* claim (`claim-held`), which the scheduler avoids by offering only unclaimed admissions. A refused claim is not *exhausted*: no run started, so there is no attempt record and no `RunStatus`.
_Avoid_: Contended claim, stale claim (one we release), exhausted (a run that gave up after trying)

**Park notice**:
The one marked comment the Coordination module posts on a parked issue: the park reason and the Attention command that continues the item. It is Workflow output for a person, never a coordination record, so nothing reads it back. The raw failure behind an `exhausted` or `write-failed` park stays in Cogwork. The notice posts on a fiber that the Coordination layer owns, so a park returns before the tracker write ends. A notice that does not post is logged, and the park stands (ADR 0036).
_Avoid_: Coordination comment (the deleted fixed-pipeline ledger), stuck comment (every park kind gets one)

**Worktree manager**:
The git worktree lifecycle for the repos cogwork *drives*: ensure a branch's checkout exists, list it, remove it, and reconcile away idle ones. An implement worktree blocks its normal push path with a worktree-only invalid `pushurl`; follow-up retains agent-owned push. Before the Engine opens a pull request, it refreshes the base and requires the local Engine-cut head to be ahead. The Engine then pushes that head through the selected remote's explicit URL. Pull request readiness does not depend on a Run worktree still existing. "Reconcile" here means worktree cleanup: the maintenance heartbeat keeps the worktrees of open tracker items, open pull requests, and running Runs, and removes the rest. It runs only the **Worktree setup** a driven workspace's config declares; it is not the setup a coding harness runs when it opens a worktree of *this* repo to work on cogwork itself — that is a repo-local developer concern, deliberately kept separate (see ADR 0005).
_Avoid_: Checkout, clone, worktree setup (that is one step the manager runs, not the manager)

**Worktree setup**:
The linked paths (`linkPaths`) and setup commands (`setup`) a driven workspace's config declares. The Worktree manager runs them in a Run's worktree, outside the sandbox: when it prepares the worktree, and again when a writable Run's agent calls the `worktree-setup` engine tool after it changes a dependency manifest or lockfile. The agent cannot choose the commands or the directory.
_Avoid_: Install step, bootstrap

**Branch divergence**:
A worktree branch holding commits its remote branch lacks while the remote holds commits the branch lacks, so no fast-forward can bring them together. The worktree manager resolves it by rebasing the local commits onto the remote; when that rebase will not apply, the divergence is a non-retryable prepare failure that hands the item to a human with its commits untouched (see ADR 0002).
_Avoid_: Conflict (that's one reason a rebase fails), drift, stale branch (that's just being behind)

**Base divergence**:
A pull request's branch and its base branch (`main`) have each gained commits the other lacks and those commits overlap, so the branch can no longer merge into the base. The engine reads it from the source control provider's mergeable signal (GitHub's `dirty`) on the pull request Trigger source's poll and treats it as a **follow-up trigger** in its own right — one the agent clears by working, which is what qualifies it (see ADR 0013); the follow-up agent integrates the base — a merge commit by default, a rebase with `--force-with-lease` only where the repo requires linear history — and pushes to the same branch (see ADR 0003). A branch merely *behind* its base (no overlap, still mergeable) is not this and is left alone.
_Avoid_: Branch divergence (that's the branch versus its own remote, not the base), merge conflict (one reason integrating the base fails), stale branch (that's merely behind)

**Workspace registry**:
The Control-store-backed set of registered workspaces and Workspace-input failures, held in a cell folded from workspace management acts. Register mints each `WorkspaceId`. Loading resolves the selected worktree remote (`origin` by default) and derives one GitHub `owner/repository` for any GitHub tracker or source control provider; register, update, refresh, and re-bind therefore follow the checkout instead of stored repository text. A required missing or unsupported remote makes that Workspace input fail. Update replaces the mutable non-path record and leaves Private workspace overlays intact. Re-bind changes only its checkout path. Deregister removes it from the cell before the next scheduler pick, while a Run already holding its workspace value finishes normally. Each act publishes the matching workspace change or removal. The engine's view of which repos it is driving.
_Avoid_: Config store. Distinct from the harness runner map, which is also a "registry" of sorts.
