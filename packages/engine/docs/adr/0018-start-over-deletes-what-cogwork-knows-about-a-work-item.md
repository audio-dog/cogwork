# Start over deletes what Cogwork knows about a Work item

ADR 0011 makes coordination records append-only: Hand Back adds a barrier, and the failures before it stay as evidence. That fits a person who judges old attempts stale. It does not fit a person who wants Cogwork to forget an item, for example after Runs started in the wrong order, or after a hand edit of the Control store left the item in a state no command reaches. **Start over** is that command, and it is the one exception to ADR 0011: for one tracker item it stops any active Run, then deletes the item's coordination records (admissions, source revisions, claims, attempts, parks, and handbacks), its Workflow action plans, its Run history, its worktree and local branch with any unpushed commits, the remote branch Cogwork pushed, the open pull request Cogwork opened, and Cogwork's park notices. It keeps the item's labels and Workflow output, so the item's Triggers admit it again on the next poll, as new work.

## Considered Options

- **A start-over barrier, like Hand Back.** Rejected by the maintainer: the item would look new to the engine but would keep its history, and the request is a clean start. Hand Back stays the barrier for "these attempts do not count".
- **Delete only the coordination records.** Rejected: a worktree, a branch, or an open pull request from the old Runs would then meet the new Run, which is the state that made the reset necessary.

## Consequences

- Start over applies only to tracker items (GitHub and Linear issues and pull requests). An engine-minted item (a Slack message, a Granola note) has no label to admit it again, so it would disappear until its source sends a new event.
- Before it deletes anything, the confirmation names the branch, the number of unpushed commits, the pull request, and the number of Runs.
- ADR 0011's rule stays for every other writer: only Start over deletes coordination records.
