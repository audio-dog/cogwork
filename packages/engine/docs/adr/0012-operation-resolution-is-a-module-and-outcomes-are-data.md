# Operation resolution is a module, and operation outcomes are data

The executor is the engine's god-module. One 1,390-line closure holds 78 functions over 15 injected
services, and eight concerns share its lexical scope: claim, worktree hand-off, operation resolution,
session choice, dispatch, event folding, failure policy, and outcome recording. Its pure decisions —
retryability, the exhaustion rule, outcome selection, session choice — are reachable only by driving
the whole executor through fourteen test doubles, which is why `executor.test.ts` is twice the size
of the module and a third of it is scaffolding. The glossary has always defined **Operation
resolution** as the engine's combination of an Operation and its settings into an immutable Run Plan,
but no module owns the concept: `planSession` is its scattered implementation, and the scatter is a
bug class. Contribution admission runs in three places. MCP credentials pair to projected servers by
positional index across two independently computed filters, so a disagreement between them would
attach a bearer token to the wrong MCP server. The Control store's availability narrowing repeats at
every caller.

Two decisions, settled together in the 2026-09-03 architecture review.

**Operation resolution becomes an engine module.** `operation-resolution.ts` takes one candidate's
facts and returns the accepted Run Plan, plus the resolved MCP credential map as a separate value —
secrets ride only the Harness request, never the plan or the ledger. The module absorbs
`planSession`, `resolvePlanStage`, and availability evaluation (the conclusion sits where its inputs
are). Its implementation is a pure core: admission stated once, credential pairing keyed by
contribution identity so the positional-misrouting class is unrepresentable, and `assembleRunPlan`
beneath it with its 17-field input no longer public. The executor keeps claim, worktree, dispatch,
and recording; its fifteen services split into two cohesive sets.

**The decision core is extracted as pure modules** beside the existing `resume-policy.ts`, which is
the shape this records: value in, decision out, tested through the interface with no doubles.
`retry-policy.ts` owns retryability classification. One exhaustion module owns "when is an item
spent" and is consumed by both `classify` and the executor, so the two halves of that rule can no
longer drift apart — a drift fails silently, with classification offering an item the executor
always hands off. Session choice (`compatibleSession`, the prompt selection, the fresh-recovery
switch) is a pure module the resolution module consumes.

**Operation outcomes are data.** An Operation Definition already declares its "possible outcomes";
this puts the declaration to work. Each engine Operation Definition carries an outcome table mapping
the decoded Operation result to a coordination outcome verb plus succeeded / failed / retryable. One
generic completion path replaces the three parallel completion closures, and the
`TriageStageOps | TextStageOps` union with its six near-duplicate fold helpers collapses. A fourth
Operation costs a table row, not a closure and two folds.

## Considered Options

- **A pure `buildRunPlan` only, no module.** Rejected as the instance fix. It repairs admission and
  pairing but keeps the executor ferrying ingredients between services and a pure function, and
  every ferry hop is a place to misalign — the fix would still be needed if the system were shaped
  right. The pure core survives as the module's implementation, not as the seam.
- **Extract only the executor's half of the exhaustion rule.** Rejected: the rule would keep two
  homes (`classify` counts trailing failures; the executor compares attempts to the cap), and
  nothing would force them to agree.
- **Outcome selection as decision functions, keeping the StageOps union.** Rejected: it extracts the
  instances and leaves the class — the parallel-closure structure — in place.
- **A typed `execute` outcome for the scheduler.** Rejected for now. The scheduler has no behavior
  that would branch on held-off versus refused versus unavailable, and a channel with no consumer is
  speculative. The boolean stays until a real consumer varies.

## Consequences

The restructuring lands as behavior-preserving prefactor pull requests, bounded by reviewability;
`executor.test.ts` stays green and untouched while the modules land, then duplicated coverage may be
pruned. `run-control.ts` and `cooldown.ts` — today stubbed to identity in the executor tests — get
their first tests through their own interfaces, because a claim released wrongly on interrupt tells
nobody. The glossary's **Operation resolution** entry gains its module home when the module lands,
not before.

## Amendment (2026-09-11): worktree ensure moves into Run preparation

The 2026-09-11 architecture review found the fresh-versus-resume decision still made twice: the
pure `decideSessionChoice` governed the prompt, an inline comparison in the executor governed the
stage ops, and `SessionChoice.operations` had no reader. **Run preparation** becomes an engine
module between claim and dispatch. It owns worktree ensure, the candidate-session lookup, the call
to Operation resolution, and the derivation of prompt, session, and branch from one Session choice.
The executor keeps claim, dispatch, and recording; "worktree" leaves its list. Operation resolution
is unchanged: it still has no git side effect, and the checkout path it needs arrives from the
preparation step that ensured it.
