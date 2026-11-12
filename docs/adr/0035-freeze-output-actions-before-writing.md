# ADR 0035: Freeze output actions before writing

## Status

Accepted

## Context

A Workflow Run can finish its reasoning before an output write fails. Running the agent again can produce different text or repeat writes. Tracker retries also need stable targets and identities across daemon restarts.

## Decision

The engine decodes each matched Transition into one typed action plan. It freezes every action entry, parameter, used agent input, app, Workspace tracker binding, target, and write key. A later Workspace rebind cannot redirect a stored plan. It records the plan in the Control store before the first write and copies it into the Run ledger.

One executor runs approval, tracker writes in document order, notifications, and the final hand-off or Stop. It records each confirmed step before starting the next one. A retry resumes the stored plan and never reruns the agent.

Each tracker write that creates content, an issue or a comment, carries a stable write key in a hidden body marker. The adapter reads the marker back before it completes the step. Created artifacts also retain their Workflow origin in the plan.

A tracker write that changes state, a label or a close, carries no marker. The adapter reads the state before the write and again after it. A repeated step finds the state already applied and writes nothing. A marker for a state write needs a comment of its own, and that empty comment is noise in the thread.

A retryable failure leaves its step pending. A permanent failure, or the third consecutive failure, marks the step failed and parks the item with `write-failed`. A handback skips completed and failed steps and runs the remaining plan. A new source revision withdraws the old plan.

An action that needs a Workspace receives the agent's constrained Workspace choice. `none` parks the complete plan before any write. An action on the triggering item — comment on it, change its labels, close it, open or push its pull request — targets that item's own Workspace, and the agent's choice does not apply to it.

## Consequences

- The Control store plan is durable execution state, not coordination state.
- The Run ledger explains exactly what the engine intended to write.
- Repeated delivery and process restart do not duplicate confirmed writes.
- Action adapters must support idempotent write markers for content writes, state checks for state writes, and read-back confirmation for both.
- Recovery uses the normal executor. There is no separate approval or retry path.
