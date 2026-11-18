# Engine glossary: Performance

Part of the [engine glossary](./GLOSSARY.md).

**Telemetry store**:
The dedicated local SQLite file (`~/.cogwork/telemetry.db`) holding the app's own spans and metric snapshots — observations about the process, disposable and pruned, never authoritative product records (ADR 0020). Deliberately not the Control store, so the instrument never queues behind the write lock it measures.
_Avoid_: Control store (the authoritative store; ADR 0015's one-database rule stands for product records), run ledger (a run's harness events, which are product history), log file

**Performance regression sensor**:
Deterministic engine code that watches the telemetry store's health signals and, on a sustained threshold breach, files a thin evidence ticket at `needs-triage` with an `origin:selfperf` label and a fingerprint marker (ADR 0021). The proactive layer's first non-tracker sensor; it fires on transitions into alarm, dedups against the tracker itself, and never reopens a closed issue.
_Avoid_: Performance sensor (ambiguous once budgets also file), detector, watchdog, monitor (a Datadog-style alert rule), triage (the stage that verifies what the sensor files)

**Performance verdict**:
One sensor's decision that a performance claim holds, handed to the Performance issue filer as data: the kind (health signal, suite comparison, suite budget, test-file budget), the signal, subsystem, and direction, the numbers, and the evidence. The filer renders the ticket from it; a sensor never writes ticket text or a Fingerprint string itself.
_Avoid_: Alarm (the state a health signal is in), finding, report (the comparison tool's JSON, which a verdict is decoded from)

**Performance issue filer**:
The one engine module that turns a Performance verdict into tracker action: dedup by Fingerprint against the tracker, the shared daily cap, file or comment, re-file and never reopen (ADR 0021). Three sensors call it — the regression sensor in the daemon, the suite comparison and the budget check in CI — and one GitHub adapter sits behind it, reached through the GitHub client alone. A capped verdict in CI fails the job rather than vanishing.
Its home is `src/performance-issue-filer.ts`.
_Avoid_: Sensor (the caller that decides), issue tracker adapter (the coordination port, which the filer does not use), script filer (deleted)

**Performance budget sensor**:
A scheduled job that measures a performance budget and files a ticket while the budget is unmet (ADR 0023). It fires on a standing condition rather than a transition, so it files about work the app has never done; it never gates a merge, and it hands a `budget` Performance verdict to the Performance issue filer, sharing its label, Fingerprint, and cap.
_Avoid_: Performance regression sensor (fires on change, not on level), budget gate (nothing here blocks a merge), optimizer (it proposes work, it does not do it)

**Performance budget**:
A named count of the app's own work paired with a target below what the app does today, so that missing it is the normal state until someone improves the code (ADR 0023). Counts, never durations, because wall clock on one laptop is not comparable to itself; met budgets are lowered again rather than retired.
_Avoid_: Threshold (a health signal's alarm line, which sits above healthy), SLO (assumes a fleet and an error budget), quota, limit (the scheduler's caps on concurrent work)

**Replay runner**:
A measurement-only harness runner that decodes an exported Run fixture and streams its recorded AG-UI events at recorded speed or a selected multiplier. It enters through the normal harness seam, so downstream recorder, ledger, bus, transport, and clients are measured without starting an agent subprocess or doing worktree I/O. Count stability is the correctness gate; timing comparison needs at least 10 warm-ups, 10 paired samples, and a confidence interval that excludes no-change.
_Avoid_: Fake runner (a test double asserting behavior; this one generates load), simulator, benchmark (the measurement around it, not the runner)

**Health signal**:
One health number the performance regression sensor watches: a named reading from the telemetry store (the daemon's event-loop delay p99, heap headroom) paired with a fixed threshold and window. The set is enumerated and deliberately small; the filing cap bounds the tickets, never how many signals may be watched (ADR 0021).
_Avoid_: Signal (bare, now that budgets are also watched), performance budget (a target below current behaviour, not an alarm line above it), metric (the raw telemetry reading a signal is defined over), alert (an alerting product's rule), alarm (the state a breached signal enters, not the signal itself)

**Fingerprint**:
The stable identity of one machine-filed performance claim: a string over signal, subsystem, and direction — measured values excluded — carried as a marker in a machine-filed ticket's body, so dedup derives from the tracker itself. Many firings with different numbers share one fingerprint and therefore one open ticket (ADR 0021).
_Avoid_: Hash (an implementation detail), signature (audiodog's word for the same idea), occurrence (one firing, which a fingerprint groups)
