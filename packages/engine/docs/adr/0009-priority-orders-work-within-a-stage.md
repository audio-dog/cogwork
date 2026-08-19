# Priority orders work within a stage, and a value we can't read defaults to medium

The engine ordered eligible work by lifecycle stage alone. Within a stage it fell back to whatever order the tracker listed items in — so two `implement` tickets ran in an order nobody chose. A team that marks one ticket "urgent" and another "low" expects the urgent one to go first, and the engine had no way to honor that.

We add a single canonical **priority** scale — `urgent`, `high`, `medium`, `low` — that every observed item now carries, and we sort by it *after* stage. Stage stays the primary key: a low-priority follow-up still runs before an urgent implement, because the stages are ordered for a reason and priority is not allowed to let a ticket jump its stage. Priority is the secondary key, breaking ties between items of the same stage; the tracker's own stable listing order breaks the remaining ties. Both sorts that matter — the classifier's eligible-work list and the scheduler's cross-workspace candidate list — key on stage, then priority, then stable order, so they agree.

Priority **orders** work; it never **gates** it. This is the load-bearing decision. Because ordering can't drop an item, a priority we can't read is never fatal — it resolves to `medium`, the middle of the scale, and the item still runs in its stage. `resolvePriority` maps whatever a tracker hands us onto the scale case-insensitively; absent, blank, or unrecognized all become `medium`. The scale, its ordering (`priorityRank`), the default, and the resolver all live in `contracts` beside `stagePriority`, so both adapters and both sorts speak one vocabulary.

Each adapter reads its own tracker's notion of priority:

- **Linear** already returns a native `priority` enum on every issue, so the adapter just maps it: Urgent, High, Medium, Low map straight across, and "No priority" maps to `medium`. No extra API call, no config.
- **GitHub** has no priority on an issue itself. Teams keep it in a Projects v2 single-select field on a board. So a GitHub workspace opts in by naming the board: `issueTracker.priority` takes a project `number` and an optional `field` name (default `"Priority"`). Reading it means a GraphQL call — the first the GitHub adapter makes — that pages the board's items and builds an issue-number → priority map, which the adapter then joins against the issues it lists. An issue with no card on the board resolves to `medium`, same as an unknown value.

The GitHub board read **degrades** rather than fails. Missing `read:project` scope, a wrong project number, a GraphQL error, an issue that isn't on the board — none of these stop the reconcile poll. A failed read logs one warning for the whole board — not one per affected item — and hands back a lookup that resolves every item to `medium`; the poll continues with everything at the default. The warning is deliberately stateless: it recurs on each poll the board stays unreadable, because the degradation path keeps no local memory (matching the rest of the design, which re-derives everything from the tracker). A workspace that names no board reads nothing at all and stays silent — the feature is simply off. So the warning fires only when a board is configured *and* the read fails, which keeps a real misconfiguration visible without turning a working single-owner setup into noise.

## Considered Options

- **Make priority gate eligibility, like the assignee allowlist.** Rejected: the two do different jobs. The allowlist decides *whether* to touch a ticket; priority decides *what order* to touch tickets in. If a bad priority read could drop an item, an unconfigured board or an expired token would silently starve the backlog. Keeping priority purely ordinal means the worst a failed read can do is order things by the default — annoying, never harmful.
- **Let a high priority override stage order.** Rejected: the stages are ordered deliberately (`follow-up` before `triage` before `implement` before `verify`) so in-flight work drains before new work starts. Letting an urgent `implement` jump ahead of a pending `follow-up` would defeat that. Priority breaks ties inside a stage; it never crosses one.
- **Add a `priority` field to the `WorkItem` contract.** Rejected: nothing above `classify` needs it yet. Like assignees, priority lives on the engine's internal observed item and flows into the sorts, and it can be lifted onto the read models when a surface wants to show it.
- **Read the GitHub board with REST.** Rejected: Projects v2 is GraphQL-only. A single paged GraphQL query against the board is the supported path, and it's isolated behind the adapter's client so the rest of the engine never sees it.
- **Fail the poll when a configured board can't be read.** Rejected: an ordering hint is not worth stopping all work over. Degrading to the default and warning once keeps the daemon making progress while making the misconfiguration obvious.

## Consequences

A GitHub workspace that wants priority ordering must add `issueTracker.priority` and grant the token `read:project`. Without the scope, the read fails soft: everything sorts as `medium` and one warning per poll explains why. Linear workspaces need nothing — priority comes for free with the issue.

The GitHub adapter now makes a GraphQL call per poll for a configured workspace, on top of its REST issue list. It's one paged query, not per-issue, so the cost is bounded by board size, not backlog size. A workspace with no board configured makes no extra calls.

Ordering is now deterministic within a stage in a way it wasn't: same stage, same priority, and items still fall back to the tracker's stable order, so the sort never reshuffles equal items run to run.
