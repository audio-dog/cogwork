### 16. The migration path

From #789, in `/prefactor` order: a structural (S) pull request never changes output; each behaviour (B) change is its own pull request. If an S step changes any output, it moves to B. The S steps may run in parallel.

**Structural**

- **S1. Attempt records keyed by Operation, not stage.** The failure limit and the handback barrier take a `(Workflow, Operation)` key; the fixed pipeline passes `("coding", stage)`.
- **S2. The checkout from the permission profile, not the stage.** Triage `read-only`; implement `full` on the issue's branch; follow-up `full` on the pull request's head.
- **S3. One coordination interface, then the Control store adapter** (ADR 0033). Classification, the failure limit, and the handback barrier read through one interface; the tracker adapter is today's code; the Control store adapter is added and unused.
- **S4. The completion path takes the result schema and outcome table from the Operation** (engine ADR 0012), not from a switch on the stage.

**Behaviour**

- **B5. The engine pushes**, first on the fixed pipeline. Also: pass the `SessionId` as TanStack `threadId` unconditionally; pending interrupt rows from before TanStack 1.0 are dropped, not resolved, and no code detects them (TanStack 1.0 landed in [#792](https://github.com/taylorfsteele/cogwork/pull/792)).
- **B6. The Workflow engine, proven on Granola → Issue.** A build effort of several pull requests, engine first: the document schema, validator, edit vocabulary, and result-schema derivation in contracts; the Control store row and RPCs; the Trigger source seam with the Granola and clock sources; engine-minted items and lineage with the hop rule; the action plan executor; Create an issue and Comment on an existing issue; the issue search Tool; the Granola Connection (login + optional key) and `connections_system` widening; the owned runner registered in the daemon and able to run in a scratch directory; then the editor wired to the RPCs and the Attention page wired to the read model and the touchpoint commands; the Granola → Issue templates. Needs S3.
- **B7. The catalog entries for the coding Workflow:** the tracker and source-control Trigger sources on modified-since reads; the follow-up entries and "New comment from a person"; Push to this pull request; the label actions; Hand to me; Choose an answer; the coding templates.
- **B8. The cut-over**, one pull request that ships the coding default and deletes the fixed pipeline: the reconcile snapshot and its generation (engine ADR 0001), classification, the stages, the hand-written stage schemas, `Reclassify`, `HandBack.role`, Linear `roleLabels`, the Workflow and Operation setting levels and `bindings` and the `"coding"` hard-code, the no-progress limit and `stalled`, the `ready-for-human` label on exhaustion, the needs-human reason. The order of waiting work (§6) and the "Ready to merge" view (§11) land here. The engine glossary's older sense of *hand-off* (`handOff`, "hand-off explanation") is rewritten with the code. The cut-over happens with no Runs in flight; new code ignores old stage-keyed attempt records (at worst an item gets three fresh attempts); rollback is a revert; no switch runs both systems. **At the cut-over the coding pipeline stops until the person creates it from a template, publishes it, and switches it on.**

**After B8**, in their own pull requests: the Slack Connection, Slack Trigger source, Slack write port and entries, review entries, the pull request Tool, Draft a review, and the Slack → Review template; the sweep entry and the Staleness sweep templates.

