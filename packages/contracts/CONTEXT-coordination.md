# Coordination

Part of the [Contracts (shared kernel)](CONTEXT.md) glossary.

**Claim**:
A coordination record marking an item as being worked: `by`, `claimedAtMillis`, an optional operation, and its **lineage**. Persisted in the Control store for every item, tracker items included (ADR 0036), so it survives a daemon restart; crash recovery releases one a stopped daemon left behind.
_Avoid_: Lock, lease, reservation

**Refused claim**:
A claim the coordination authority will not accept, such as a claim on an item whose source revision was never observed. Distinct from a *contended* claim (`claim-held`), which the scheduler avoids by offering only unclaimed admissions. A refused claim is not *exhausted*: no run started, so there is no attempt record and no `RunStatus`.
_Avoid_: Contended claim, stale claim (one we release), exhausted (a run that gave up after trying)

**Attempt record**:
A coordination record of one finished operation attempt on an item: its Operation — keyed by Workflow and Operation, not by lifecycle stage — its outcome (`succeeded` / `failed` / `abandoned`), its time, and its **lineage**. Persisted in the item's coordination authority, as a **Claim** is.
_Avoid_: Run — a run is the local execution; an attempt is the durable outcome

**Handback record**:
A coordination record of a person returning a parked item to the control plane: `by` and `atMillis`. Persisted in the item's coordination authority, as a **Claim** is. The failure counters — exhaustion, stall, crash loop, and the **hop** cap — count only what happened after the newest handback, so a handback discounts an item's failure history without erasing it. The inverse of a **park**: the control plane parks an item for a person when it gives up, and a person hands it back. A second handback moves the line forward.
For a Workflow item a handback resumes the Operation that parked — or, after a `write-failed` park, runs the rest of the action plan — and the resumed Run receives the person's note when the handback carries one.
_Avoid_: Retry (the control plane's own automatic re-attempt of a *retryable* failure — a handback is a person acting, not the engine), reset, unpark, pardon

**Lineage**:
The chain of Runs that one person's act or one source event started: a root, and for each Claim and Attempt record its parent, held in the item's own coordination authority. A hand-off, a fan-out child, and an event whose **cause** is Cogwork's own write keep the lineage; an event a person caused, a schedule tick, and a sweep start a new root.
_Avoid_: Trace, thread, history, Session (one Harness conversation)

**Hop**:
One step that extends a lineage — a hand-off, a fan-out child, a Workflow start that inherits a lineage, or a Run admitted on a source revision the lineage itself caused, such as a follow-up push that CI then fails. The **hop cap** for each lineage is engine policy and a failure counter: reaching it parks the item with `hop-cap`.
_Avoid_: Cycle, depth, round

**Round summary**:
What a follow-up round tells the reviewer, posted by the engine to the pull request under the actor identity with the coordination marker attached. The one control-plane write that lands on the pull request rather than the issue tracker; the marker is what keeps it out of the human-feedback signal, and it stays the engine's to attach.
**A round speaks to answer a question, never to narrate a state.** A round that pushed always posts. A round that pushed nothing returns a `speak` decision and posts only when it declines or answers something a person or a trusted bot asked — a nit it judged wrong, a finding it judged a false positive — so the asker learns why and does not raise it twice. A round that nobody asked anything of stays silent. Its summary still reaches the coordination comment either way, so a silent round is traceable.
_Avoid_: Round comment, agent note (that's free-text operator prose), coordination detail (that lives on the tracker and carries the reason an item parked)
