# Priority orders work within a stage, and a value we can't read defaults to medium

Amended by ADR 0015. Waiting admissions now order by prior action from the same Workflow, priority, then oldest observed revision. Stage order is retired.

The engine ordered eligible work by lifecycle stage alone. Within a stage it fell back to whatever order the tracker listed items in — so two `implement` tickets ran in an order nobody chose. A team that marks one ticket "urgent" and another "low" expects the urgent one to go first, and the engine had no way to honor that.

We add a single canonical **priority** scale — `urgent`, `high`, `medium`, `low` — that every observed item now carries, and we sort by it *after* stage. Stage stays the primary key: a low-priority follow-up still runs before an urgent implement, because the stages are ordered for a reason and priority is not allowed to let a ticket jump its stage. Priority is the secondary key, breaking ties between items of the same stage; the tracker's own stable listing order breaks the remaining ties. Both sorts that matter — the classifier's eligible-work list and the scheduler's cross-workspace candidate list — key on stage, then priority, then stable order, so they agree.

Priority **orders** work; it never **gates** it. This is the load-bearing decision. Because ordering can't drop an item, a priority we can't read is never fatal — it resolves to `medium`, the middle of the scale, and the item still runs in its stage. `resolvePriority` maps whatever a tracker hands us onto the scale case-insensitively; absent, blank, or unrecognized all become `medium`. The scale, its ordering (`priorityRank`), the default, and the resolver all live in `contracts` beside `stagePriority`, so both adapters and both sorts speak one vocabulary.

Each adapter reads its own tracker's notion of priority:

- **Linear** already returns a native `priority` enum on every issue, so the adapter just maps it: Urgent, High, Medium, Low map straight across, and "No priority" maps to `medium`. No extra API call, no config.
- **GitHub** keeps priority in an organization issue field. A GitHub workspace opts in by selecting a single-select field: `issueTracker.priority.field` stores its stable numeric ID. The workspace settings page loads compatible fields through the bound Connection and never asks a person to type an ID or name. The REST issue listing carries each issue's field values, so the adapter joins the selected ID to the value already returned with that issue. An unset or unknown value resolves to `medium`.

The GitHub field read **degrades** rather than fails. Missing `read:org` or Issue Fields read permission, a removed field, or an incompatible field does not stop the reconcile poll. A failed catalog read logs one warning for the field — not one per affected item — and hands back a lookup that resolves every item to `medium`; the poll continues with everything at the default. The warning is deliberately stateless: it recurs on each poll the field stays unreadable, because the degradation path keeps no local memory. A workspace that selects no field reads no catalog and stays silent. The settings picker reports the same permission failure directly.

## Considered Options

- **Make priority gate eligibility, like the assignee allowlist.** Rejected: the two do different jobs. The allowlist decides *whether* to touch a ticket; priority decides *what order* to touch tickets in. If a bad priority read could drop an item, an unconfigured board or an expired token would silently starve the backlog. Keeping priority purely ordinal means the worst a failed read can do is order things by the default — annoying, never harmful.
- **Let a high priority override stage order.** Rejected: the stages are ordered deliberately (`follow-up` before `triage` before `implement` before `verify`) so in-flight work drains before new work starts. Letting an urgent `implement` jump ahead of a pending `follow-up` would defeat that. Priority breaks ties inside a stage; it never crosses one.
- **Add a `priority` field to the `WorkItem` contract.** Rejected: nothing above `classify` needs it yet. Like assignees, priority lives on the engine's internal observed item and flows into the sorts, and it can be lifted onto the read models when a surface wants to show it.
- **Read priority from Projects v2.** Rejected: organization issue fields are the source that colonylabs and GitHub Issues use. A project-scoped source cannot see them and makes a person enter unstable coordinates.
- **Fail the poll when a configured field can't be read.** Rejected: an ordering hint is not worth stopping all work over. Degrading to the default and warning once keeps the daemon making progress while making the misconfiguration obvious.

## Consequences

A GitHub workspace that wants priority ordering selects an organization single-select issue field and grants the token `read:org`, or Issue Fields read permission for a fine-grained token. Without permission, the picker explains the missing grant and reconciliation fails soft: everything sorts as `medium` and one warning per poll explains why. Linear workspaces need nothing — priority comes for free with the issue.

The GitHub adapter makes one organization field-catalog call per poll for a configured workspace, on top of its REST issue list. It never makes one field-value request per issue. A workspace with no field configured makes no extra catalog call.

Ordering is now deterministic within a stage in a way it wasn't: same stage, same priority, and items still fall back to the tracker's stable order, so the sort never reshuffles equal items run to run.
