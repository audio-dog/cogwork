# Technical disposition: Failures, limits, testing, and naming

Part of [Technical disposition](./technical-disposition.md). Cite these heuristics by name.

## Failures

**Report a normal failure as data.** Where a failure is an ordinary state to report, it belongs in
the success payload, as `DaemonStatus.failures` does. Add a typed error channel when the first real
failure mode lands, never a speculative one for an operation that cannot fail today.

**Decline, don't unwind.** A gate is a precondition, not an action. It re-evaluates every poll and
only ever declines to act: it never releases a claim, never interrupts an in-flight run, never posts
a note. Work already in flight finishes as it always did, and the next poll simply stops picking it
up. Honouring a changed condition by declining is cheap and safe; unwinding is neither.
(engine ADR [0008](../../packages/engine/docs/adr/0008-assignee-ownership-gate.md))

**Self-halt over gates.** Agents run end-to-end unattended unless the Workflow author adds a human
gate. The shipped coding template ends with a person reviewing and merging the pull request, as does
the process used to build Cogwork. Cogwork does not enforce that gate; branch protection can enforce
it when wanted. Triage exercises judgment — it drives well-defined work straight to a PR and
*self-halts*, parking as `needs-info` or `ready-for-human` **with its reasoning**, when requirements
are unclear, conflict with the code, or the work is too big for one session. A new surface's default
posture is to inform and offer override; when autonomy quality is the question, invest in the agent's
self-halt judgment rather than building a gate.
(ADR [0007](../adr/0007-autonomous-with-override-triage-self-halts.md))

## Limits and cost

**Bound the resource, not the axis.** When a question asks whether to cap something, find what
actually grows. An axis that grows with the user's own work — open UI windows, not workload — is not
the thing to cap; bound what each one holds instead, so one stuck client cannot hurt the daemon.
Artificial limits on legitimate axes are a smell.

**Weigh the cost at scale, the benefit at the margin.** When a choice trades tidiness for a
convenience, count both sides at the size the product is going to be. A dead row retained per user
"just in case they roll back" is one row in a demo and millions of rows of cruft at scale — harder
maintenance, weirder bugs, a schema nobody trusts — bought for the fraction of users who ever hit the
edge case. Prefer the simpler state: delete it, and let the rare case pay the rare cost. Reserve
retention for data whose loss is expensive rather than merely inconvenient.

**Pay for capability; reject security theater.** Auth is a fair price for going remote. Crippling a
payload, or capping a legitimate axis, to avoid that cost is the wrong trade.

**Relieve crowding with a loading mechanism, never a scoping gate.** When a set the user assembles
grows large — enabled contributions, tools in a context window — the fix is a mechanism that loads on
demand, not a second control surface that narrows the set per consumer. A per-consumer gate turns the
user's one setting into a request the system may decline, and it has to be designed, rendered, and
maintained forever; lazy loading costs the user nothing and is simply the right way to build it.
Where the loading mechanism is not ours yet, say so and wait for it rather than shipping the gate in
its place. Resolved on [#130](https://github.com/taylorfsteele/cogwork/issues/130): every enabled
contribution flows into every Run Plan for its workspace, and `TextOptions.lazyToolsConfig` is the
mechanism now that the owned model loop exists. Note the corollary — **requiring is not narrowing**.
An Operation Definition declaring a required need is a precondition, and it never implies the power
to exclude everything it did not name.

🛑 **Open fork — cost and latency against correctness.** Undecided. Live options: correctness wins
outright because the pipeline is unattended and nobody is waiting; cost and latency are first-class
and an expensive-but-right design is rejected; or the answer splits by surface, with the AFK pipeline
optimising correctness and interactive surfaces optimising latency. Note that high cost is often a
symptom rather than a budget problem — see **Models are for intelligence**.

## Testing

**Test through the interface, never past it.** An interface is everything a caller must know to use
a module correctly, and it is also the test surface. Implementation details are the things a caller
never sees, so a test that reaches them buys false negatives (it breaks on refactors that broke
nothing) and false positives (it passes while the real usage is broken). Wanting to test past an
interface means the module is the wrong shape. Integration over unit by default; every mock removes
confidence in the integration it replaces.

**Test what fails silently.** An unattended pipeline's characteristic failure is being quietly
wrong — coordination, claiming, precedence, recovery, idempotency, generation guards. One triage
silently producing two proposals is what engine ADR
[0001](../../packages/engine/docs/adr/0001-scheduler-acts-once-per-snapshot-generation.md) exists to
prevent. The test: **if this broke, would anything tell us?** When the answer is "the next run just
does the wrong thing", it needs a test. A bug fix starts with the failing test that reproduces it.

**Coverage is a structural diagnostic, not a target.** Use-case coverage is what you are actually
after: a function at 100% code coverage can still miss every case that matters. But code you *cannot*
cover is usually code shaped wrong — a dependency created instead of accepted, a side effect where a
return value belonged, a seam in the wrong place. Chase the number to find the shape problem, then
stop. Write it at 100% where 100% comes naturally; this project does not require it.

## Naming

**Name the kind.** When a set of things resists one collective term, that is the domain telling you
they are not one thing — reach for the specific name rather than an invented umbrella. Prefer a flat
list of typed, separately-named concepts, and let two lists differ where they genuinely differ. Align
vocabulary with **TanStack AI**, the standing naming reference: it has no collective noun for what
you give an agent (`tools`, `skills`, `plugins`, `instructions`, `secrets` are siblings, never rolled
up) and has spent a breaking change to *stop* overloading one of its words. The test: **a grouping
noun earns its place when the group has a rule its members lack, and no existing glossary term
already names the group.** Check a candidate against TanStack AI before coining it — "capability"
was already spent there three times over.
(ADR [0011](../adr/0011-contribution-kinds-are-flat-and-have-no-umbrella-noun.md))
