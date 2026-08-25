# Technical disposition

How this project decides.

Read this when you are answering a technical question in the maintainer's place and the code cannot
tell you the answer — a finely-tuned call about how much to expose, whether to cap something, which
error shape to use, how to split the work. These are rarely the maintainer's to answer: they follow
from where the product is going and from how mature tools solve the same problem. Resolve them
yourself instead of blocking.

This document teaches *how to decide*. It does not hold the architecture — `CONTEXT-MAP.md` and the
ADRs do, and they stay current in a way a gist here would not.

## What earns a heuristic

- **The new-question test.** Does it fire on a question nobody has asked yet? A line that only
  restates a decision belongs in that decision's ADR.
- **The default test.** Does an agent behave differently for having read it? When the answer is no,
  delete the whole line rather than trimming it.
- **The single-source test.** Does the reasoning live here, or does an ADR own it? Gist and link.

## What to read first

1. [`CONTEXT-MAP.md`](../../CONTEXT-MAP.md) — how the contexts connect. The architecture lives here;
   the per-context glossaries deliberately do not carry it.
2. [`product.md`](./product.md) — what the product is, who it is for, where it is, where it is going.
3. The ADRs for the area — `docs/adr/`, and the per-package `<context>/docs/adr/` beside them.
4. The `CONTEXT.md` for the context you are answering about, with
   `packages/contracts/CONTEXT.md` alongside it.

## The line

Know which questions you resolve, which you escalate, and which you defer because nobody can answer
them yet.

**Resolve it yourself** when the answer follows from a heuristic below, an ADR, a line of product
direction, or prior art. Research, compare, recommend, and let your confidence rise toward
`ready-for-agent`. Put the recommendation and its rationale in the proposal.

**Escalate it** — via `ready-for-human`, with the question stated — only when the answer would
establish **new product direction** not yet covered in [`product.md`](./product.md) or an ADR. The
signs of a real fork: it trades off the product's identity, it moves the roadmap, or principled
people would genuinely disagree and the choice *defines* the product. A question that **grows while
you answer it** is the shape of a fork — [#132](https://github.com/colonylabs/cogwork/issues/132)'s
first-party-integrations question arrived as a consequence of a resolvable one rather than as its
own ticket, and went to [#172](https://github.com/colonylabs/cogwork/issues/172).

**Defer it** — to the open ticket that owns defining the concept — when the question is undecidable
rather than hard: what it asks about is not yet defined, so no answer would be sound. Escalation
waits on a person's judgment; deferral waits on a definition. Say so, mark the term provisional in
the glossary, and name the ticket. Scoping a thing before defining it is how a glossary acquires
claims no ticket ever decided.

The escalation test and the harvest destination are the same documents, which is what stops a
question escalating twice.

## Cite what you resolve from

Every answer names its source — a heuristic by name, an ADR, a line of product direction, a closed
ticket, a `CONTEXT.md` term. The citation is the answer's load-bearing half: it lets the maintainer
check the step from source to answer. An answer that no source entails is still worth giving, and
marking it as one is what keeps it from borrowing a cited answer's authority. How that mark is
expressed is the caller's business.

## The research formula

1. **Anchor.** Where is the product going, and what does this decision need to support *there*,
   not just today?
2. **Compare.** How do the reference implementations handle it? See **Evidence** below.
3. **Recommend.** Lay out the options, pick one, and justify it. A recommendation with a rationale
   beats a question kicked back.

## The heuristics

Grouped by the shape of the question they answer, in the order you meet them working a problem.
Cite them by name. A new group needs two members — a rule that fits nowhere waits in the closest
group rather than founding a group of one.

### Evidence

**Reason from first principles, and let prior art sharpen it.** Work the problem from first
principles — that is the primary tool. Then research how the reference implementations solve the
same thing, compare, and let the evidence check and strengthen your reasoning rather than replace it.

**Prior art is a fact, not a decision — go and find out.** When the question *is* the prior art,
reasoning is the wrong tool entirely. Dispatch a `/research` subagent and keep working: a
recommendation delivered before the evidence arrives tends to survive by anchoring rather than by
being right, and costs a correction later. Two of
[#132](https://github.com/colonylabs/cogwork/issues/132)'s answers were reversed by research after a
confident first recommendation.

**Record the strength of a borrow.** When a decision copies prior art, say which of three it is: a
**standard** (a published spec others conform to), a **convergence** (independent implementations
arriving at the same shape, with no spec between them), or a **borrow** (one vendor's private choice
you liked). Convergence is strong evidence and no guarantee; a borrow is taste. The test: **could you
link the spec?** If not, it is not a standard. A future reader decides whether they may deviate from
this label, and an overstated one reads as settled when it is merely copied.

**The reference implementations.** Learn from how mature coding-agent tools solve these problems.
Cursor, Codex, and Claude Code are the products to recall; three apps are vendored on disk to read
directly. Run `pnpm vendor` to hydrate them.

- `.repos/opencode` — owning the model loop: session drain, System Context, provider routes.
- `.repos/t3code` — the control plane: event-sourced orchestration, typed contracts,
  Electron-supervised server.
- `.repos/codex` — external-harness config: layered settings, profiles, approval policy.

The *product* reference for the proactive layer is a different list and lives in
[`product.md`](./product.md).

### Speculation and scope

**Enumerate before you model.** Before reasoning about how a set of things composes — precedence,
merging, conflicts, scopes — *list the set*. Design built over an uncounted set defends itself well
and is expensive to unwind, and the list usually collapses it: the members turn out to be few, or
identical, or to have one setting rather than many. Corollary: **one adapter means a hypothetical
seam, two means a real one** — do not introduce a seam until something actually varies across it.
Second corollary: before building a mechanism to reconcile something, check whether a decision
already made means the collision cannot occur.
(ADR [0013](../adr/0013-two-settings-families-with-different-scope-sets.md))

**Split along independent concerns once product judgment is pinned.** Push the mechanical slices to
`ready-for-agent`; keep only the vision- or direction-setting piece as `ready-for-human`. Small,
concern-scoped tickets over one bundle.

**Take the shape that survives the turn you can see coming.** When a contract, transport, or storage
decision has a cheap shape that survives "the daemon goes remote and multi-user" and an equally cheap
shape that does not, take the one that survives — but build no hosting, no auth systems, no tenancy.
Looking the other way, nothing is publicly released, so a breaking change costs a migration of zero
installs: when the clean shape and the compatible shape differ, take the clean one and migrate.
Compatibility owed to nobody has no beneficiary.
(map [#159](https://github.com/colonylabs/cogwork/issues/159); [`product.md`](./product.md))

### Shape and change

**Fix the class, not the instance.** When a bug's cause is structural, the correct fix changes the
structure. A guard clause that catches one instance of a systemic bug is a rejected fix, not a
smaller one. The test: **would this fix still be needed if the system were shaped right?** If yes,
you are patching a symptom. The same question runs at design time — *what would this look like in a
production system* — before a shape is proposed, not only after one breaks.

**Complexity is earned by depth.** Complexity belongs in one place callers never see. A change earns
its complexity when the *caller* gets simpler, even where the implementation gets harder, and it
earns the most when it makes a bug class unrepresentable rather than merely handled — then the caller
pays nothing, because the branch it would have written no longer exists. The test: **the deletion
test** — imagine deleting the module; if complexity vanishes it was a pass-through, and if complexity
reappears across N callers it was earning its keep. The vocabulary for this is the `codebase-design`
skill's: *deep*, *shallow*, *seam*, *interface*.

**The structural fix is the ticket.** When a ticket's problem is caused by the structure, changing
the structure is the correct scope and the one-line fix is the out-of-scope one. Where the
restructuring is large enough to obscure the behaviour change, it lands first as its own prefactor
pull request. The bound is reviewability, enforced by **self-halt over gates**: **can a reviewer see
the behaviour change in this diff?** If the restructuring hides it, that is two pull requests.

### Models and the engine

**Models are for intelligence; the engine is for everything else.** Reach for a model when the work
needs synthesis, reasoning, or creativity — putting pieces of information together into something
new. Everything else is deterministic code, and the more of the system that is deterministic, the
better. An application that asks a model to interact with large parts of itself is expensive, slow
(the model spends its first minutes discovering tools and details), and unpredictable. The test:
**could two runs on the same input disagree, and would that disagreement be a bug?** Then it belongs
in code.

**The engine constrains the model.** Predictability and cost come from the constraint, not from the
model. A model that is not confined can return work wildly different from what was asked, so the
deterministic layer stays in charge of what happens next — it decides, checks, and disposes, whatever
the model returns.

**Build the environment, not the prompt.** What surrounds a model matters more to its success than
the model itself. Give it prepared context and deterministic checks up front rather than making it
discover them, since the minutes spent discovering are both the latency and the unreliability. A
check being deterministic is a reason to hand it to the model, not a reason to withhold it.
(engine ADR [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md)
is this rule implemented.)

**Utility calls skip the harness.** Triage routing, ranking, drafting, summaries — anything that is
not a coding session — goes through the owned provider layer and must not depend on an external agent
CLI being installed. Harnesses exist solely to run coding sessions.
(engine ADR [0006](../../packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md))

### What runs where

**The engine assembles; the runner renders.** The engine resolves what a run gets — context,
instructions, MCP skills, credentials — and each runner projects that into its own native channel.
A runner chooses presentation, never membership.
(engine ADRs [0005](../../packages/engine/docs/adr/0005-mcp-skills-engine-assembles-harness-runner-renders.md)
and [0006](../../packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md))

**Explicit over ambient.** Anything mandatory arrives because the engine supplied it. Ambient
discovery — a CLI finding a config file, a tool the host happens to have installed — may add optional
context and may never carry a requirement. The test: **would this still work on a clean machine the
engine had just provisioned?**
(engine ADRs [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md)
and [0010](../../packages/engine/docs/adr/0010-codex-cli-is-an-external-harness.md))

**Put the decision where the information is.** A choice made where the inputs are stale or partial is
a choice made wrong. Context grows inside the model loop, so only the loop can decide what to keep —
a transcript frozen at dispatch time cannot. When a decision keeps needing data from elsewhere, the
decision is in the wrong place, not the data.
(engine ADR [0006](../../packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md))

**Name the authority; derive the rest.** Exactly one system is authoritative for a given fact, and
everything else derives from it. A key derived from an immutable id beats a dual write that has to be
reconciled. It follows that anything derived is disposable: losing the daemon's local store is safe
because the issue tracker stays authoritative for coordination, and new state is derivable until it
demonstrably cannot be.
(ADR [0003](../adr/0003-work-source-as-coordination-substrate.md); engine ADR
[0004](../../packages/engine/docs/adr/0004-issue-tracker-and-source-control-provider-are-separate-ports.md))

### Trust and boundaries

**Secure the channel, not the payload.** The client is the user's own UI and needs rich detail to
render a good experience — full error messages, file paths, live agent output. Keep RPC payloads
rich and secure the channel instead: owner-only socket now, real auth and TLS when it goes remote.
The one thing withheld is a *raw, unexpected* exception — return a generic message, log the detail —
and that is robustness, not secrecy.
(ADR [0005](../adr/0005-trust-boundary-is-authentication-not-payload-redaction.md))

**Data over code.** Prefer declarative, schema-validated, syncable config to executable config. Data
cannot `rm -rf` you, and it syncs and edits in a GUI for free. Reserve executable code for an
explicit, opt-in plugin layer trusted by provenance. This sidesteps sandboxing entirely.
(ADR [0006](../adr/0006-workspace-config-trends-toward-declarative-data.md))

**Enforce at the mechanism, not by instructing the agent.** A guarantee holds because the transport,
the schema, or the policy makes the alternative impossible — not because a prompt asked for it or a
tool allowlist named it. Linear's read-only MCP endpoint enforces read-only at the transport; the
engine, not the agent, cuts the branch.
(engine ADRs [0005](../../packages/engine/docs/adr/0005-mcp-skills-engine-assembles-harness-runner-renders.md)
and [0010](../../packages/engine/docs/adr/0010-codex-cli-is-an-external-harness.md))

🛑 **Open fork — who owns a secret across an update.** Undecided. Live options: the Plugin declares a
requirement and the engine owns every credential; the Plugin owns its own and the engine brokers; or
ownership follows the Connection. Escalate rather than infer; the concept lands with
[#125](https://github.com/colonylabs/cogwork/issues/125) and
[#135](https://github.com/colonylabs/cogwork/issues/135).

### Failures

**Report a normal failure as data.** Where a failure is an ordinary state to report, it belongs in
the success payload, as `DaemonStatus.failures` does. Add a typed error channel when the first real
failure mode lands, never a speculative one for an operation that cannot fail today.

**Decline, don't unwind.** A gate is a precondition, not an action. It re-evaluates every poll and
only ever declines to act: it never releases a claim, never interrupts an in-flight run, never posts
a note. Work already in flight finishes as it always did, and the next poll simply stops picking it
up. Honouring a changed condition by declining is cheap and safe; unwinding is neither.
(engine ADR [0008](../../packages/engine/docs/adr/0008-assignee-ownership-gate.md))

**Self-halt over gates.** Agents run end-to-end unattended, and the one hard human gate is pull
request review and merge. Triage exercises judgment — it drives well-defined work straight to a PR
and *self-halts*, parking as `needs-info` or `ready-for-human` **with its reasoning**, when
requirements are unclear, conflict with the code, or the work is too big for one session. A new
surface's default posture is to inform and offer override; when autonomy quality is the question,
invest in the agent's self-halt judgment rather than building a gate.
(ADR [0007](../adr/0007-autonomous-with-override-triage-self-halts.md))

### Limits and cost

**Bound the resource, not the axis.** When a question asks whether to cap something, find what
actually grows. An axis that grows with the user's own work — open UI windows, not workload — is not
the thing to cap; bound what each one holds instead, so one stuck client cannot hurt the daemon.
Artificial limits on legitimate axes are a smell.

**Pay for capability; reject security theater.** Auth is a fair price for going remote. Crippling a
payload, or capping a legitimate axis, to avoid that cost is the wrong trade.

🛑 **Open fork — cost and latency against correctness.** Undecided. Live options: correctness wins
outright because the pipeline is unattended and nobody is waiting; cost and latency are first-class
and an expensive-but-right design is rejected; or the answer splits by surface, with the AFK pipeline
optimising correctness and interactive surfaces optimising latency. Note that high cost is often a
symptom rather than a budget problem — see **Models are for intelligence**.

### Testing

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

### Naming

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

## One worked answer

From [#132](https://github.com/colonylabs/cogwork/issues/132), on whether an inner contribution
inside a Plugin carries its own version.

The first answer was a confident yes, reasoned from first principles: versioned parts compose
independently, so version them. It cited nothing, because nothing entailed it.

The research came back and reversed it. No platform does it — VS Code, Cursor, and Codex all version
the bundle and nothing inside it — and the reason is that an inner version is a promise nobody can
keep, since the parts ship together anyway. The answer became: the Plugin carries the version, the
contributions do not, and the borrow is a **convergence** rather than a standard, because no spec
exists to link.

Three things that answer did, and the first attempt did not. It **named its source** — three
implementations, read directly. It showed the **one step** from source to answer, so the inference
can be checked rather than trusted. And it **labelled the strength** of what it copied, so a future
reader knows they may deviate.

The failure worth noticing is not that the first answer was wrong. It is that it read as sourced
when it was not — which is why **prior art is a fact, not a decision** sits first in this document.
