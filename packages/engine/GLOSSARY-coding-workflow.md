# Engine glossary: Coding Workflow template

Part of the [engine glossary](./GLOSSARY.md). These terms belong to the coding Workflow template and
its Operating-instructions packages, which the engine ships.

**Triage role**:
A label value a coding Workflow's Triggers can match and its Transitions can add, such as `needs-triage` or `ready-for-agent`. The engine gives the value no built-in meaning.
_Avoid_: Status, state, label (when you mean the role's meaning)

**Requirements digest**:
The requirement details triage resolves from a work item's linked artifacts — final copy, design node links, decisions made in chat threads — and inlines into its proposal, so the work item becomes a self-contained brief. Context acquisition is triage's job, done once; an implement Run consults an external system only where the digest points at it. See ADR 0029.
_Avoid_: Brief (the whole item and thread — the digest is the part triage adds), work context (the engine-supplied facts, not tracker content), triage proposal (the digest rides in it)

**Review requirements**:
The judgment reviews a work item's shape demands, named by triage in its proposal and honored by the implement Run. Selection, never exemption: the security review runs on every diff regardless of what triage named. See ADRs 0027 and 0029.
_Avoid_: Review policy, gate (the local gate is checks, not reviews), required needs (the Operation definition's contract, not per-item flags)

**Round summary**:
What a follow-up round tells the reviewer, posted by the engine to the pull request under the actor identity with the coordination marker attached. The one control-plane write that lands on the pull request rather than the issue tracker; the marker is what keeps it out of the human-feedback signal, and it stays the engine's to attach.
**A round speaks to answer a question, never to narrate a state.** A round that pushed always posts. A round that pushed nothing returns a `speak` decision and posts only when it declines or answers something a person or a trusted bot asked — a nit it judged wrong, a finding it judged a false positive — so the asker learns why and does not raise it twice. A round that nobody asked anything of stays silent. Its summary still reaches the coordination comment either way, so a silent round is traceable.
_Avoid_: Round comment, agent note (that's free-text operator prose), coordination detail (that lives on the tracker and carries the reason an item parked)
