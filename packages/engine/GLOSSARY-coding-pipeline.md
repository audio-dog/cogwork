# Engine glossary: Coding pipeline

Part of the [engine glossary](./GLOSSARY.md).

**Requirements digest**:
The requirement details triage resolves from a work item's linked artifacts — final copy, design node links, decisions made in chat threads — and inlines into its proposal, so the work item becomes a self-contained brief. Context acquisition is triage's job, done once; an implement Run consults an external system only where the digest points at it. See ADR 0029.
_Avoid_: Brief (the whole item and thread — the digest is the part triage adds), work context (the engine-supplied facts, not tracker content), triage proposal (the digest rides in it)

**Review requirements**:
The judgment reviews a work item's shape demands, named by triage in its proposal and honored by the implement Run. Selection, never exemption: the security review runs on every diff regardless of what triage named. See ADRs 0027 and 0029.
_Avoid_: Review policy, gate (the local gate is checks, not reviews), required needs (the Operation definition's contract, not per-item flags)
