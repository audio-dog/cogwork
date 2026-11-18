# Technical disposition

How this project decides.

Read this when you are answering a technical question in the maintainer's place and the code cannot
tell you the answer — a finely-tuned call about how much to expose, whether to cap something, which
error shape to use, how to split the work. Read it too when you propose a fix or a design — an ADR,
a ticket's brief or acceptance criteria, a plan — even with the maintainer in the conversation: the
shape of a fix is set where it is first written down, and every stage after it inherits that shape. These are rarely the maintainer's to answer: they follow
from where the product is going and from how mature tools solve the same problem. Resolve them
yourself instead of blocking.

This document teaches *how to decide*. It does not hold the architecture — `GLOSSARY-MAP.md` and the
ADRs do, and they stay current in a way a gist here would not.

## What earns a heuristic

- **The new-question test.** Does it fire on a question nobody has asked yet? A line that only
  restates a decision belongs in that decision's ADR.
- **The default test.** Does an agent behave differently for having read it? When the answer is no,
  delete the whole line rather than trimming it.
- **The single-source test.** Does the reasoning live here, or does an ADR own it? Gist and link.

## What to read first

1. [`GLOSSARY-MAP.md`](../../GLOSSARY-MAP.md) — how the contexts connect. The architecture lives here;
   the per-context glossaries deliberately do not carry it.
2. [`product.md`](./product.md) — what the product is, who it is for, where it is, where it is going.
3. The ADRs for the area — `docs/adr/`, and the per-package `<context>/docs/adr/` beside them.
4. The `GLOSSARY.md` for the context you are answering about, with
   `packages/contracts/GLOSSARY.md` alongside it.

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
you answer it** is the shape of a fork — [#132](https://github.com/taylorfsteele/cogwork/issues/132)'s
first-party-integrations question arrived as a consequence of a resolvable one rather than as its
own ticket, and went to [#172](https://github.com/taylorfsteele/cogwork/issues/172).

**Defer it** — to the open ticket that owns defining the concept — when the question is undecidable
rather than hard: what it asks about is not yet defined, so no answer would be sound. Escalation
waits on a person's judgment; deferral waits on a definition. Say so, mark the term provisional in
the glossary, and name the ticket — one that can hold it, since a planning decision cannot live on
an implementation ticket. Scoping a thing before defining it is how a glossary acquires claims no
ticket ever decided.

The escalation test and the harvest destination are the same documents, which is what stops a
question escalating twice.

## Cite what you resolve from

Every answer names its source — a heuristic by name, an ADR, a line of product direction, a closed
ticket, a `GLOSSARY.md` term. The citation is the answer's load-bearing half: it lets the maintainer
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

- [Evidence](./technical-disposition-evidence-and-scope.md): **Reason from first principles, and let prior art sharpen it.** · **Prior art is a fact, not a decision — go and find out.** · **What a tool writes to disk outranks what it says.** · **Declared is not reachable.** · **Record the strength of a borrow.** · **The reference implementations.**
- [Speculation and scope](./technical-disposition-evidence-and-scope.md): **Enumerate before you model.** · **The ask bounds the design.** · **Split along independent concerns once product judgment is pinned.** · **Take the shape that survives the turn you can see coming.**
- [Shape and change](./technical-disposition-evidence-and-scope.md): **Fix the class, not the instance.** · **Complexity is earned by depth.** · **The structural fix is the ticket.**
- [Models and the engine](./technical-disposition-engine-and-trust.md): **Models are for intelligence; the engine is for everything else.** · **The engine constrains the model.** · **Build the environment, not the prompt.** · **Utility calls skip the harness.**
- [What runs where](./technical-disposition-engine-and-trust.md): **The engine assembles; the runner renders.** · **Explicit over ambient.** · **Put the decision where the information is.** · **Name the authority; derive the rest.**
- [Trust and boundaries](./technical-disposition-engine-and-trust.md): **Secure the channel, not the payload.** · **Data over code.** · **Enforce at the mechanism, not by instructing the agent.** · **A bundle names a secret; the engine holds it.** · **Approval names what it approves.**
- [Failures](./technical-disposition-failures-and-limits.md): **Report a normal failure as data.** · **Decline, don't unwind.** · **Self-halt over gates.**
- [Limits and cost](./technical-disposition-failures-and-limits.md): **Bound the resource, not the axis.** · **Weigh the cost at scale, the benefit at the margin.** · **Pay for capability; reject security theater.** · **Relieve crowding with a loading mechanism, never a scoping gate.** · **Open fork — cost and latency against correctness.**
- [Testing](./technical-disposition-failures-and-limits.md): **Test through the interface, never past it.** · **Test what fails silently.** · **Coverage is a structural diagnostic, not a target.**
- [Naming](./technical-disposition-failures-and-limits.md): **Name the kind.**

## One worked answer

From [#132](https://github.com/taylorfsteele/cogwork/issues/132), on whether an inner contribution
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
