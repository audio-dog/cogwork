# Technical disposition

Guidance for **answering on the maintainer's behalf** — the finely-tuned technical open questions where a ticket asks for a small technical call (how much to expose, whether to cap something, which error shape, how to split the work). These are rarely the maintainer's to answer: they follow from where the product is going and from how mature tools solve the same problem. Resolve them yourself instead of blocking.

Read this alongside [`docs/agents/product.md`](./product.md) (what the product is and where it is going), `docs/adr/` (the settled decisions these principles are drawn from), and the per-package `CONTEXT.md`.

## How to use this doc

Two callers reach this doc, and the procedure is the same for both.

- **`/triage`** — a ticket raises a technical open question mid-triage.
- **`/grill-afk`** — a griller subagent interviews you, and you answer in the maintainer's place from what is written here.

First decide whether the question is one you can **resolve** or a genuine fork you must **escalate** (see [The line](#the-line)). If it's resolvable, run [the research formula](#the-research-formula): anchor in the product direction, compare prior art, and recommend.

**Cite what you resolve from** — a numbered principle, an ADR, a line of product direction, a closed ticket, a `CONTEXT.md` term. The citation is the answer's load-bearing half: it lets the maintainer check the step from source to answer. An answer that no source entails is not wrong, but it is a weaker kind of answer and must be marked as one rather than borrow the authority of a cited one. How that mark is expressed is the caller's business.

## Product direction

Where cogwork is going lives in [`docs/agents/product.md`](./product.md) — what the product is,
who it is for, where it is, and where it is heading. Every technical call should support that
trajectory, not just today's shape. Read it before running [the research formula](#the-research-formula).

**Reference implementations.** Learn from how mature coding-agent tools solve these problems: Cursor, Codex, and Claude Code, plus three apps vendored on disk for you to read directly — `.repos/opencode` (the model for *owning* the agent loop: session drain, System Context, provider routes), `.repos/t3code` (the model for the control plane: event-sourced orchestration, typed contracts, Electron-supervised server), and `.repos/codex` (the model for external-harness config: layered settings, profiles, approval policy). Run `pnpm vendor` to hydrate them. Ground a recommendation in how one of these actually does it rather than reasoning from first principles alone. The *product* reference for the proactive layer is a different list and lives in `product.md`.

## Decision principles

Durable heuristics, drawn from decisions already made (see the linked ADRs). Apply them to new questions of the same kind.

1. **The trust boundary is authentication, not payload scrubbing.** The client is the user's own UI and needs rich detail to render a good experience — full error messages, file paths, live agent output. Keep RPC payloads rich. Secure the *channel* instead: owner-only socket now, real auth + TLS when it goes remote. The only thing withheld is *raw, unexpected* exceptions (return a generic message, log the detail) — and that's for robustness, not secrecy. (ADR-0005)

2. **Settings are data, not code.** Prefer declarative, schema-validated, syncable config over executable config. Data can't `rm -rf` you, and it syncs and edits in a GUI for free. Reserve executable code for an explicit, opt-in plugin layer trusted by provenance. This sidesteps sandboxing entirely. (ADR-0006)

3. **Live streams are one-per-client, not one-per-entity.** A client subscribes once to the full feed and fans out or filters its own views. So "concurrent subscribers" is bounded by open UI windows, not by workload — don't cap it. Defend against abuse at the trust boundary; bound each subscriber's buffer so one stuck client can't hurt the daemon. Artificial limits on legitimate axes are a smell.

4. **Model typed errors only for real failure modes.** Where a failure is a normal state to report, report it as *data* in the success payload (as `DaemonStatus.failures` does). Add a typed error channel when the first real failure mode lands — never a speculative one for an operation that cannot fail today.

5. **Reason from first principles, and let prior art sharpen it.** Work the problem from first principles — that's the primary tool. Then research how the reference implementations solve the same thing, compare, and let that evidence check and strengthen your recommendation rather than replace your reasoning. The vendored repos are on disk under `.repos/` — read them.

6. **Accept operational cost for capability; reject security theater.** Auth is a fair price for going remote. Crippling the payload, or capping a legitimate axis, to avoid that cost is the wrong trade.

7. **Build the experience you'd want to use.** When a call affects what the user sees or feels, optimize for developer/client UX.

8. **Once product judgment is pinned, split along independent concerns.** Push the mechanical slices to `ready-for-agent`; keep only the vision- or direction-setting piece (the ADR) as `ready-for-human`. Small, concern-scoped tickets over one bundle.

9. **Utility model calls go through the owned provider layer, never a harness.** Triage routing, ranking, drafting, summaries — anything that isn't a coding session — must not depend on an external agent CLI being installed. Harnesses exist solely to run coding sessions. (engine ADR-0006)

10. **Architect hosted-ready; build local-first.** When a contract, transport, or storage decision has a cheap shape that survives "the daemon goes remote and multi-user" and an equally cheap shape that doesn't, take the one that survives. Don't build the hosting itself — no auth systems, no tenancy — just don't bake single-user, single-machine assumptions into seams that are expensive to reopen. (map #159)

11. **The pipeline is autonomous-with-override, not approval-gated.** Agents run end-to-end unattended; the one hard human gate is PR review + merge. Triage exercises judgment — it drives well-defined work straight to a PR and *self-halts* (parks as `needs-info` / `ready-for-human`, with its reasoning) when requirements are unclear, conflict with the code, or the work is too big for one session. So a new surface's default posture is to *inform and offer override*, never to block the agent behind a human's approval; and when autonomy quality is the question, invest in the agent's self-halt judgment over building gates. (ADR-0007)

12. **Name the kind.** When a set of things resists one collective term, that is the domain telling you they are not one thing — reach for the specific name, not an invented umbrella. Prefer a flat list of typed, separately-named concepts over an invented umbrella, and let two lists differ where they genuinely differ. Align vocabulary with **TanStack AI**, the standing naming reference: it has no collective noun for what you give an agent (`tools`, `skills`, `plugins`, `instructions`, `secrets` are siblings, never rolled up) and has spent a breaking change to *stop* overloading one of its words. Check a candidate term against TanStack AI before coining it — "capability" was already spent there three times over. (ADR-0011)

13. **"How do other tools do it" is a fact, not a decision — go and find out.** Prior art questions are answerable, so answer them with research rather than a confident recommendation from memory. This is not the same as principle 5: that one says let prior art sharpen your reasoning; this one says when the question *is* the prior art, reasoning is the wrong tool entirely. Dispatch a `/research` subagent and keep working — a recommendation delivered before the evidence arrives tends to survive by anchoring rather than by being right, and costs a correction later. Two of #132's answers were reversed by research after a confident first recommendation.

14. **Record the strength of a borrow, not just the borrow.** When a decision copies prior art, say which of three it is: a **standard** (a published spec others conform to), a **convergence** (independent implementations arriving at the same shape, with no spec between them), or a **borrow** (one vendor's private choice you liked). Convergence is strong evidence and no guarantee; a borrow is taste. Never call any of them a standard unless a spec exists you could link. A future reader decides whether they may deviate based on this label, and an overstated one reads as settled when it is merely copied — a citation that looks authoritative and resolves to nothing.

## The line

The whole point: know which questions to resolve and which to escalate.

**Resolve it yourself** when the answer follows from the direction and principles above, or from prior art. These are finely-tuned technical one-offs — how much to expose, whether to cap, which error shape, how to split. Research, compare, recommend, and let your confidence rise toward `ready-for-agent`. Put the recommendation and its rationale in the proposal.

**Escalate it** — via `ready-for-human`, with the question stated — only when the answer would establish **new product direction** not yet covered in [`docs/agents/product.md`](./product.md) or an ADR. Signs it's a real fork: it trades off the product's identity, moves the roadmap, or principled people would genuinely disagree and the choice *defines* the product.

**The corpus compounds.** Every fork the maintainer answers is written back, to exactly one of three places: a fork about **what the product is or where it goes** becomes a claim in [`product.md`](./product.md); a fork about **how to decide** becomes a new principle here; a fork that is hard to reverse and surprising without context also earns an ADR, which the other two then gist and link. Escalation and harvest read against the same documents, so the same question never escalates twice — over time, more questions fall on the "resolve" side, and escalations shrink to only the genuinely new.

## The research formula

1. **Anchor in the direction.** Where is the product going (read [`product.md`](./product.md)), and what does this decision need to support *there*, not just today?
2. **Compare prior art.** How do the reference implementations handle it? Read the vendored `.repos/opencode`, `.repos/t3code`, and `.repos/codex`; recall Cursor and Claude Code.
3. **Recommend.** Lay out the options, pick one, and justify it against the direction and principles. A recommendation with a rationale beats a question kicked back.

## Worked examples

Keep this to the one or two examples that teach the line most clearly; it grows as better ones arrive.

From #25 (harden the daemon RPC/socket trust boundary): four of its five open questions were resolvable straight from the principles above. The one genuine fork:

- **Should workspace config be data or code?** → *Escalate.* This sets product direction — it defines how config is authored, synced, and secured for the desktop/web future. The maintainer chose **data**; that answer is now principle 2 / ADR-0006, so the next config question resolves instead of escalating.

From [#132](https://github.com/colonylabs/cogwork/issues/132) (the contribution kinds and Plugin contract): sixteen questions over four rounds, and exactly one escalated.

- **Which contributions may a Plugin bundle? What are the ids, the scopes, the schemas, the versioning?** → *Resolve.* Every one followed from the direction, the principles, or prior art. Two were **reversed by research** after a confident first recommendation — whether inner contributions carry versions (no platform does it) and whether the scope ladder is uniform (it is not, for trust reasons). That is principle 13 earning its place.
- **Should first-party integrations — the issue tracker, the source control provider — become installable Plugins?** → *Escalate.* It moves the roadmap and redraws what the Engine owns, and the issue tracker is the coordination substrate (ADR-0003), not merely an integration. Parked as [#172](https://github.com/colonylabs/cogwork/issues/172) rather than answered in passing.

The tell for the fork was that it arrived as a *consequence* of a resolvable question — "does a Plugin need an auth recipe?" — rather than as its own ticket. A question that grows while you answer it is the shape of a fork; the manifest field was left permitting an auth recipe so the door stays unbolted, and the direction question went to its own session.
