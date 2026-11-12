# ADR 0034: Trigger observation is level-triggered

## Status

Accepted

## Context

Trigger sources can repeat events, reconnect after downtime, and observe a changed subscription set. The engine must not start two Runs for one source revision. It must also recover without a second coordination system.

## Decision

Each source is a value that owns its catalog entries and observes the active subscriptions passed to it. `TriggerObservation` derives those subscriptions only from published, switched-on Workflows. It replaces a source fiber whenever that set changes.

An event carries a stable item key and source revision. Admission records the revision through `Coordination.observe`. Eligibility comes from the resulting Coordination gate. Completion records the revision as processed. A repeated observation is therefore harmless. An unprocessed revision remains eligible after restart.

Schedule items use `(Workflow, scheduled instant)` as their key. The clock emits only the latest missed instant after downtime. Local time is interpreted in the configured IANA zone, then stored as a UTC instant.

## Consequences

- Sources report facts. They do not own claims, retries, or Run state.
- The Control store remains the only coordination authority for engine-minted items.
- Switching a Workflow off removes its subscription and blocks later admission. A claimed Run finishes.
- Adding a source requires one source value and catalog entries, not another scheduler path.
