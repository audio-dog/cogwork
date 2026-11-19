# Technical disposition: Evidence, scope, and shape

Part of [Technical disposition](./technical-disposition.md). Cite these heuristics by name.

## Evidence

**Reason from first principles, and let prior art sharpen it.** Work the problem from first
principles — that is the primary tool. Then research how the reference implementations solve the
same thing, compare, and let the evidence check and strengthen your reasoning rather than replace it.

**Prior art is a fact, not a decision — go and find out.** When the question *is* the prior art,
reasoning is the wrong tool entirely. Dispatch a `/research` subagent and keep working: a
recommendation delivered before the evidence arrives tends to survive by anchoring rather than by
being right, and costs a correction later. Two of
[#132](https://github.com/taylorfsteele/cogwork/issues/132)'s answers were reversed by research after a
confident first recommendation.

**What a tool writes to disk outranks what it says.** The strongest prior art is not the vendored
source or the docs — it is the data the shipped product leaves on this machine, because that is the
design after every compromise. Before escalating or inferring anything about how a mature tool
handles a problem, look for its artifact: `~/.codex/`, `~/.cursor/`, `~/.claude/`. Read the files.
Four of [#125](https://github.com/taylorfsteele/cogwork/issues/125)'s answers were reasoned out — one
escalated as an open fork — where three folders on disk settled the question in minutes. A folder
beats a paragraph.

**Declared is not reachable.** A symbol, stage, config key, or field existing in the code is no
evidence that anything reaches it. A dispatch table missing an entry, a branch nothing selects, or a
resolver returning null kills the whole path while every definition upstream still reads as live.
Trace forward to where the work is dispatched before calling a path live, and rank the definition
site as the weakest evidence there is.

**Record the strength of a borrow.** When a decision copies prior art, say which of three it is: a
**standard** (a published spec others conform to), a **convergence** (independent implementations
arriving at the same shape, with no spec between them), or a **borrow** (one vendor's private choice
you liked). Convergence is strong evidence and no guarantee; a borrow is taste — and taste runs both
ways, so a borrow can be evidence *against* the shape it carries. The test: **could you link the
spec?** If not, it is not a standard. A future reader decides whether they may deviate from this
label, and an overstated one reads as settled when it is merely copied.

**The reference implementations.** Learn from how mature coding-agent tools solve these problems.
Cursor, Codex, and Claude Code are the products to recall; three apps are vendored on disk to read
directly. Run `pnpm vendor` to hydrate them.

- `.repos/opencode` — owning the model loop: session drain, System Context, provider routes.
- `.repos/t3code` — the control plane: event-sourced orchestration, typed contracts,
  Electron-supervised server.
- `.repos/codex` — external-harness config: layered settings, profiles, approval policy.

The *product* reference for the proactive layer is a different list and lives in
[`product.md`](./product.md).

## Speculation and scope

**Enumerate before you model.** Before reasoning about how a set of things composes — precedence,
merging, conflicts, scopes — *list the set*. Design built over an uncounted set defends itself well
and is expensive to unwind, and the list usually collapses it: the members turn out to be few, or
identical, or to have one setting rather than many. Corollary: **one adapter means a hypothetical
seam, two means a real one** — do not introduce a seam until something actually varies across it.
Second corollary: before building a mechanism to reconcile something, check whether a decision
already made means the collision cannot occur.
(ADR [0013](../adr/0013-two-settings-families-with-different-scope-sets.md))

**The ask bounds the design.** Answer the question that was asked, at the scope it was asked at. A
capability nobody requested is not a free bonus: it becomes a premise the next twenty answers are
built on, and unwinding it costs more than the rounds it saved. #125 assumed installs sync between
machines — no harness does this, and no map asked for it — and then spent four answers on the
portability problem that assumption created. The test: **which line of the ask does this serve?** No
answer means cut it.

**Split along independent concerns once product judgment is pinned.** Push the mechanical slices to
`ready-for-agent`; keep only the vision- or direction-setting piece as `ready-for-human`. Small,
concern-scoped tickets over one bundle.

**Take the shape that survives the turn you can see coming.** When a contract, transport, or storage
decision has a cheap shape that survives "the daemon goes remote and multi-user" and an equally cheap
shape that does not, take the one that survives — but build no hosting, no auth systems, no tenancy.
Looking the other way, nothing is publicly released, so a breaking change costs a migration of zero
installs: when the clean shape and the compatible shape differ, take the clean one and migrate.
Compatibility owed to nobody has no beneficiary.
(map [#159](https://github.com/taylorfsteele/cogwork/issues/159); [`product.md`](./product.md))

## Shape and change

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
