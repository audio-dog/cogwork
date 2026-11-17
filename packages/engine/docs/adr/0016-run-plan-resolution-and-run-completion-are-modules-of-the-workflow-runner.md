# Run Plan resolution and Run completion are modules of the Workflow runner

Amends ADR 0012 and ADR 0015.

ADR 0012 named the executor's class of failure — one closure, fifteen services, every decision
reachable only through the whole — and extracted Operation resolution as a module. ADR 0015 deleted
that module with the fixed pipeline and said the Workflow runner resolves the Run Plan. It did not say
the runner must do so inline, but that is what landed: the 2026-11-04 architecture review found
`workflow-run.ts` holding 17 services, a 430-line `execute` body that assembles the Plan, dispatches,
decodes, and routes in one scope, three copies of the plan-execution-to-settlement mapping, and a test
2.3 times the module. The ratio ADR 0012 recorded is back.

Three decisions.

**Run Plan resolution is a pure module.** It decides over facts — the published Operation, the
catalog and machine readiness, the Workspace, the assembled instruction layers, the Work Context
prose, the coordination facts, and the tool needs the Operation's Action entries declare — and
returns an accepted `RunPlan` or a `Rejected` value with its reason. The three imperative declines
(no Harness, a missing need, preflight failure) become that value; the runner records what it is
told. **Run preparation** is the Effect module that gathers those facts: checkout, Session, instruction
provisioning, Harness preflight. It performs every side effect and makes no decision about the Plan.

**Run completion is a pure module.** It takes a Run's result — a failed Harness exit, a decoded
Operation result, or an Action plan execution — with the item's coordination view and returns one
verb: retry, exhaust, park stuck, fan out, complete, or hand off. The runner's fresh path, its
resumed-plan path, and the review-plan refresh all consume it, so the failure counters and park
reasons apply in one place.

**An accepted Run always settles.** One guarantee gives this result. It starts where the Workflow
runner takes the Claim. It does not add a `settle` call to each branch. A failure after the Claim
and before the outcome is recorded is an input to Run completion. This applies to a typed failure
and to a defect. The runner records one failed attempt, with the cause as its reason. It settles the
accepted Run `failed` and returns `retry`. When the attempt counters are exhausted, the Run settles
`exhausted` and the item parks `Exhausted`. Then the runner returns `completed`. If no Run is
accepted yet, the runner records the attempt and creates no Run. On the resumed path, the accepted
Run is the Run of the stored plan. An interruption before the attempt settles the accepted Run
`interrupted` and records no attempt. An interrupted Run is not an outcome. After a replan, the Claim stays open for
the next Run. If a write fails after the runner records the attempt, the runner settles the Run.
Then it sends the failure to the scheduler. It does not record a second attempt.

The open-pull-request readiness check moves into Action plan building, where the shared kernel's
glossary already places it; the runner's copy is deleted.

## Considered Options

- **Leave the runner whole and grow its test.** Rejected: it is the shape ADR 0012 already rejected,
  and the review found the same symptoms — decisions testable only with ten doubles, the same mapping
  written three times.
- **One module for preparation and resolution.** Rejected: the side effects would sit in the same
  interface as the decision, and the decision could not be tested as a value.
- **A `settle` call in each branch.** Rejected. On 2026-11-11, about ten branches each called
  `settle`. An Action plan failure escaped all of them. Four Runs stayed `running` and recorded no
  attempt. The counters did not park the items. The scheduler retried the jobs 44 times and used
  all of the daily budget.
- **Decide from the status of the Run in the ledger.** Rejected. The attempt before a resumed plan
  already settled the Run of that plan. The status cannot show if this attempt recorded an
  outcome.
- **Reopen the fixed Operation-resolution module of ADR 0012.** Rejected: that module resolved
  engine-authored Operation Definitions. The Workflow runner resolves an Operation a document
  declares; the inputs differ, the shape of the decision is the same.

## Consequences

The restructuring lands as behaviour-preserving prefactor pull requests: resolution, then
preparation, then completion. `workflow-run.test.ts` stays green and untouched while they land; each
module is tested through its own interface; duplicated runner coverage is pruned afterwards. The
glossary's **Run Plan resolution**, **Run preparation**, and **Run completion** entries describe the
decision and the step; they name no file until the module lands.
