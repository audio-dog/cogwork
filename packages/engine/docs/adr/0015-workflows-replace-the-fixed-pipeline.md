# Workflows replace the fixed coding pipeline

The engine no longer owns a coding pipeline. A fresh daemon has no active Workflow. It offers GitHub and Linear coding templates, and work starts only after a person creates a Workflow from one, publishes it, and switches it on.

Trigger observation is the waiting-work authority. The scheduler orders open admissions by whether the Workflow has already acted on the item, then priority, then the oldest observed revision. Coordination keys attempts by Workflow and Operation. Old stage-keyed records do not participate. Operation settings have only the Default level. A template names no model, so the person's Default setting supplies it.

The fixed reconcile snapshot, classification, lifecycle stages, role reads, and stage schemas are deleted. `Reclassify` and tracker role-label configuration are deleted. Labels such as `needs-triage` are ordinary values that a Workflow Trigger can match or an Action can write. Exhaustion parks coordination state and writes no role label. The follow-up no-progress limit and `stalled` outcome are deleted; lineage's hop cap bounds the loop.

Ready to merge is a read-model view, not a Workflow state. It contains only Cogwork-opened pull requests with a recorded origin that are open, not drafts, green, conflict-free, and approved.

The cut-over requires no Runs in flight. Rollback is a revert. There is no compatibility mode and no process runs both systems.

## Consequences

This supersedes ADR 0001. Snapshot generations and their per-generation scheduler guard no longer exist.

It amends ADR 0009: waiting work is ordered first by prior action from the same Workflow, then priority, then oldest observed revision. No lifecycle-stage order remains.

It amends ADR 0012: the fixed Operation-resolution and executor modules are deleted. A Workflow document defines Operations, the Workflow runner resolves a Run Plan, and structured outputs are derived from the document.

It amends ADR 0013: pull-request Trigger sources emit the clearable conditions and occurrences directly. There is no fixed follow-up classifier, marker, no-progress counter, or stalled hand-off.
