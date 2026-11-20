# Contracts glossary: Human touchpoints

Part of the [contracts glossary](./GLOSSARY.md).

**Human touchpoint**:
A point where a Workflow reaches the person instead of a shared system: the Cogwork action entries *Notify me*, *Wait for my approval*, and *Hand to me*, and the parks the engine makes by itself. An author routes to them like any output action, and every client shows them on the **Board**. Human gates are the author's choice; the engine adds no approval gate of its own.
_Avoid_: Human-in-the-loop step, checkpoint, gate (the engine has no approval guard)

**Park**:
The engine holding a Work item for the person, with a **park reason**, until a person acts: approves, rejects, chooses an answer, or hands it back. Any client may send those commands as the Principal; each names what it acts on — a plan digest, a parked attempt — and refuses when that is no longer current. A Workflow Run never gets them as Tools.
_Avoid_: Needs-human (the fixed pipeline's narrower set), blocked (open dependencies), pause, hold

**Park reason**:
Why a Work item is parked, as a tagged set: `stuck`, `exhausted`, `hop-cap`, `missing-operation` (a hand-off to an Operation the current published revision lacks), `write-failed`, `draft-outcome-unknown` (a Slack draft might exist, so Cogwork will not try it again), `no-workspace-recognized`, `worktree-blocked` (the engine cannot prepare the Run's worktree until a person acts: a Git operation is in progress, the branch diverged from its remote, the path is not a registered worktree, or the branch name is unsafe; it carries the branch, the path, and any unmerged paths), `awaiting-approval`, `handed-to-you` (the *Hand to me* action), and `cancelled` (a person cancelled the Run; it carries the person's note, if any). A preparation failure that cannot be retried parks at its first attempt: as `worktree-blocked` for a worktree, otherwise as `exhausted`. `stuck`, `exhausted`, `worktree-blocked`, and `hop-cap` are failures; `awaiting-approval`, `draft-outcome-unknown`, `no-workspace-recognized`, `handed-to-you`, and `cancelled` are not, and move no failure counter.
_Avoid_: Needs-human reason (its two values become labels a Workflow adds), halt reason, error

**Approval**:
A person's consent to one frozen action plan, named by the plan's digest. *Wait for my approval* on any matched Transition holds the element's whole plan behind it. The person approves (the plan runs verbatim), edits agent-input text and approves the new digest, rejects (as *Stop*), or hands back with a note; a new source revision withdraws the plan and admits the item again.
_Avoid_: Approve (the fixed pipeline's triage button, which **Choose an answer** replaces), review (a pull request review is an output action), confirmation

**Choose an answer**:
The command a person uses on a `handed-to-you` park: they choose the parked element's answers and write any empty agent input the matched Transitions need, and the engine builds and runs the plan as if the agent had answered. It names the parked attempt and refuses when that attempt is not current.
_Avoid_: Approve (that names a plan, not an answer), reclassify

**Notification**:
The record *Notify me* makes of one element — its summary, the item, the matched answers, and the artifacts its plan created — kept on the Board until dismissed. It does not park the item, and it lives in the disposable Run ledger. The desktop may also raise it as an OS notification; the daemon never does.
_Avoid_: Alert, park, Daemon event (the client feed)
