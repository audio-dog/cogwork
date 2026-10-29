# ADR 0035: Freeze output actions before writing

## Status

Accepted

## Context

A Workflow Run can finish its reasoning before an output write fails. Running the agent again can produce different text or repeat writes. Tracker retries also need stable targets and identities across daemon restarts.

## Decision

The engine decodes each matched Transition into one typed action plan. It freezes every action entry, parameter, used agent input, app, Workspace tracker binding, target, and write key. A later Workspace rebind cannot redirect a stored plan. It records the plan in the Control store before the first write and copies it into the Run ledger.

One executor runs approval, tracker writes in document order, notifications, and the final hand-off or Stop. It records each confirmed step before starting the next one. A retry resumes the stored plan and never reruns the agent.

Each tracker write carries a stable write key in a hidden body marker. The adapter reads the marker back before it completes the step. Created artifacts also retain their Workflow origin in the plan.

A retryable failure leaves its step pending. A permanent failure, or the third consecutive failure, marks the step failed and parks the item with `write-failed`. A handback skips completed and failed steps and runs the remaining plan. A new source revision withdraws the old plan.

An action that needs a Workspace receives the agent's constrained Workspace choice. `none` parks the complete plan before any write.

## Consequences

- The Control store plan is durable execution state, not coordination state.
- The Run ledger explains exactly what the engine intended to write.
- Repeated delivery and process restart do not duplicate confirmed writes.
- Action adapters must support idempotent write markers and read-back confirmation.
- Recovery uses the normal executor. There is no separate approval or retry path.
