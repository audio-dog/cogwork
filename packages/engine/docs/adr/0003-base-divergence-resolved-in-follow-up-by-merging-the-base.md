# A bot PR that conflicts with its base is resolved in follow-up by merging the base

When the engine cuts an implement branch it starts from `origin/main` at that instant, and nothing re-integrates the base afterward. Once main moves and the two overlap, the pull request is `dirty` — it cannot merge — yet none of the three existing follow-up triggers (failing checks, changes-requested, new human comment) fire on it, so the PR sits silently unmergeable. We name this state **base divergence** (distinct from *branch divergence*, which is a branch versus its own remote) and make it a fourth follow-up trigger, read from GitHub's `mergeable_state` (`dirty`) during the reconcile poll. Only real conflicts count: a branch merely `behind` its base is left alone.

The follow-up agent resolves it by **merging the base into the branch** and pushing to the same branch — the existing plain-push flow, no new authority granted. Only where a repo requires linear history does it **rebase and `git push --force-with-lease`**, escalating to a human if the lease fails rather than looping. The stall counter treats "was `dirty`, now mergeable" as progress, so an agent doing its job while main keeps moving is not mistaken for a stuck one.

## Considered Options

- **Fix it in the implement playbook (rebase before opening).** Rejected as the owner: implement finishes when the PR opens, so it cannot touch a conflict that appears while the PR sits in review. It can at most shrink the window, which is not worth spreading conflict-resolution logic across two playbooks.
- **A dedicated `rebase` lifecycle stage.** Rejected: follow-up is already defined as "move an existing bot PR forward," with a worktree, a gate, and a same-branch push. A new stage duplicates that machinery to do something follow-up already fits.
- **Rebase by default, as ADR 0002 chose for branch divergence.** Rejected as the default here because the two situations differ: branch divergence is an engine-mechanical rebase on a branch that is not necessarily under review, while base divergence happens on a live PR a human is reading. A rebase force-pushes, which re-anchors in-progress review comments and drops "viewed" state; a merge commit avoids that and disappears when the repo squash-merges. Rebase stays only where linear history leaves no choice.
- **Keep every PR rebased on main (`dirty` and `behind`).** Rejected: a `behind`-but-clean PR merges fine unless branch protection requires up-to-date branches, so force-pushing it anyway churns history and steps on reviewers for no merge benefit. We act only on real conflicts.
- **Probe GitHub for each repo's merge policy.** Rejected: whether a repo needs linear history is a near-static per-repo fact; a workspace config flag (default merge-commit) carries it without spending polling budget rediscovering it every tick.

## Consequences

A PR that could previously become permanently unmergeable now has a defined move, and the fix reuses the follow-up stage's resume, gate, stall, and hand-off machinery rather than adding a parallel path. Because the counter treats "became mergeable" as progress, a fast-moving main that re-conflicts across rounds reads as legitimate work rather than a stall — while a conflict the agent genuinely cannot resolve still reaches `ready-for-human` after three rounds.

This ADR sits beside ADR 0002 and deliberately makes the opposite integration choice for a deliberately different situation. A reader comparing the two should read "merge on a live reviewed PR, rebase on a mechanical branch sync" — not an inconsistency to reconcile.

Known limitation: `mergeable_state` is computed asynchronously by GitHub and can read `null` for a short window right after a push. A poll that catches it mid-computation simply does not trigger; the next poll does. We do not block waiting on it.
