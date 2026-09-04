# The assignee allowlist gates eligibility as a passive precondition

The daemon picks up any issue carrying `ready-for-agent` (or `needs-triage`, or a daemon-owned PR). That is fine when one person owns the backlog. It breaks the moment a shared team adopts the same labels: onboarding `colony`'s Growth team means other engineers use `ready-for-agent` for their own tickets, and the daemon would happily claim work that was never meant for it — stepping on people who share the tracker.

We gate eligibility on an **assignee allowlist**. A workspace may set `issueTracker.assigneeAllowlist` to a non-empty list of tracker-native identities (GitHub logins, Linear user UUIDs). When set, `classify` drops any observed item whose assignees don't intersect the list — across *every* stage and bucket, not just `implement`. When absent, the gate is off and behavior is exactly as before, so no existing single-owner workspace changes. Both adapters now fetch assignees (GitHub's many, Linear's one) and carry them onto the observed item, even though only `colony` uses the gate today — so a future shared GitHub workspace can't silently pick up everyone's tickets for lack of the data.

The gate is a **precondition, not an action**. It is re-evaluated on every poll and only ever *declines* to act. It never releases a claim, never interrupts an in-flight run, never posts a note. If a ticket we've already claimed and opened a PR for loses its owner, the current run finishes and releases its claim as it always did, and the next poll simply stops picking it up — the PR goes quiet. The ticketing system stays the source of truth for ownership; we honor an unassignment by declining, not by unwinding.

The allowlist (whose tickets the daemon may pick up) is deliberately separate from the bound Connection's authenticated account (who the daemon acts *as* when it claims and comments). The account can belong to a human or a service, not only a bot.

## Considered Options

- **Filter at the tracker API query.** Rejected: Linear can filter by assignee server-side, GitHub's REST issue list less cleanly, and pushing the rule into each adapter's query splits one policy across two call sites and hides it from `classify`, where every other eligibility decision already lives. Fetching assignees and gating once in `classify` keeps the rule in one readable place.
- **Actively relinquish claims when ownership is lost.** Rejected by design: a reconcile sweep that calls `release` on unowned-but-claimed items adds a write path, races the executor, and can interrupt a run mid-flight. A passive precondition needs none of that — an expiring claim and a poll that declines get the same end state with no moving parts.
- **Surface gated-out tickets in a "not mine" bucket.** Rejected: the point is to stay out of other people's way, so a dropped item produces no bucket, no note, and no board entry. Silence is the feature.
- **A single `assignee` field instead of a list.** Rejected: the workspace owner wants to allow several identities (their own account plus a future service account), so the list is non-empty-when-present and matches on intersection.

## Consequences

The gate trusts tracker-side assignment: it raises the bar to "can assign an issue to an allowlisted identity," not "is a trusted actor." Anyone with write access to the shared tracker can assign a ticket to an allowlisted identity and draw the daemon onto it. That is the intended scope — staying out of teammates' way in a cooperative tracker — not a defense against a hostile insider, who is already inside the trust boundary of a repo the daemon runs agents against.

`colony` runs with `assigneeAllowlist` set to a single identity for its first supervised run; other workspaces leave it unset and are unaffected. The `WorkItem`/status contracts are untouched — assignees live only on the engine's internal observed item, since nothing above `classify` needs them. The manual reclassify command path keeps the gate off (it acts on an item a human explicitly named), so only the reconcile poll enforces ownership.
