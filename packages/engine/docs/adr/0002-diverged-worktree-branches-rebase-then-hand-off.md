# A diverged worktree branch is rebased onto the remote, then handed to a human

`Worktree.ensure` used to know only two moves: create a worktree, or fast-forward an existing one onto `<remote>/<branch>`. A branch that had diverged from its remote — local commits the remote lacks *and* remote commits the branch lacks — failed the fast-forward every time, so no stage could ever prepare that branch again. The failure was also classified retryable, which turned a permanent condition into a claim/fail/release loop.

We now measure the divergence before syncing and pick per case. Only behind, or in sync: fast-forward, unchanged. Behind and ahead: rebase the local commits onto `<remote>/<branch>`, which preserves every local commit and leaves the branch a descendant of the remote so a later push still fast-forwards. If that rebase does not apply cleanly we abort it, leave the worktree exactly as it was, and fail with `WorktreeError` reason `diverged` — a non-retryable prepare failure, so the executor hands the item to `ready-for-human` on the first recorded attempt with the ahead/behind counts and the git error in the note.

The second half of the wedge was the remote branch being *deleted*, which is how #71 got stuck. `git fetch` without `--prune` leaves the local `refs/remotes/<remote>/<branch>` behind at its old SHA, so `remoteBranchExists` answered `true` for a branch that no longer existed and the fast-forward could never succeed. We fetch with `--prune`. Once the phantom ref is gone that state is no longer a failure at all: `ensure` sees no remote branch, keeps the existing worktree and its commits untouched, logs that the branch has no remote counterpart, and lets the stage run. The commits are the only copy of that work, so leaving them in place and saying so is the conservative move.

## Considered Options

- **Reset the branch to the remote when there is no unpushed local work.** Rejected: that is only safe when nothing is ahead, which the fast-forward already covers. In the genuinely diverged case it discards the local commits, which the ticket forbids doing silently.
- **Merge the remote into the branch instead of rebasing.** Rejected: a merge commit on an agent branch muddies the pull request diff, and every conflict that fails a rebase fails a merge too.
- **Tear the worktree down and recreate it from the remote.** Rejected: it destroys un-pushed local commits with no record, and throws away the harness session's working state for a condition we can usually resolve in place.
- **Classify every prepare-time `GitError` as non-retryable.** Rejected: a fetch that fails on a flaky network is exactly what retries are for. Only the divergence we cannot resolve is deterministic enough to earn a hand-off.
- **Distinguish "pushed then deleted" from "never pushed" via the branch's upstream, and hand off on the first.** Rejected: it does not work on our own branches. `git worktree add -B <branch> <path> <remote>/<base>` records `<remote>/<base>` as the upstream, so `%(upstream:track)` reports `[ahead n]` rather than `[gone]` no matter what happens to `<remote>/<branch>` — verified end to end. Making it reliable would mean stamping the upstream ourselves on a path this change is meant to leave alone, to power a signal that would still miss any branch pushed and deleted between two `ensure` calls.

## Consequences

The permanent wedge is gone: every state an existing worktree can be in now has a defined move, and the one unrecoverable state reaches `ready-for-human` on its first recorded attempt instead of failing forever. Neither new failure path discards a commit — both leave the worktree untouched and explain themselves on the work item.

A closed pull request whose branch was deleted now leaves its commits in the reused worktree, so the next `implement` run can carry them into a fresh pull request. That is right when the branch was simply never pushed, and arguable when the commits are the residue of a deliberately abandoned pull request. We log a warning rather than guess; the alternative needs work-source knowledge (was there a pull request, and how did it end) that the worktree manager does not have today.

Known limitations, all pre-existing but worth naming because this ADR claims commits are safe:

- Until #87 lands, the scheduler can re-pick an item from a stale reconcile snapshot on each execute tick, so a single divergence can still produce several claim/fail cycles within one poll interval — and because the failure is now non-retryable, each cycle writes its own hand-off note. The item does reach `ready-for-human` immediately; the noise is the stale-snapshot defect, not this one.
- `addWorktree` uses `git worktree add -B`, which force-resets the branch. If a worktree is reaped while its branch still holds unpushed commits, the next `ensure` resets those commits away with only the reflog as a record. That is the create path, which this change deliberately leaves alone.
- A worktree left dirty by a killed harness run fails both the fast-forward and the rebase. When it also happens to be diverged, the rebase failure is reported as a divergence and escalates on the first attempt, even though the real fix is to clean the tree. Deciding whose uncommitted changes those are, and whether they may be dropped, is its own ticket.
