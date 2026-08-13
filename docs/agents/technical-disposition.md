# Technical disposition

Guidance for answering **finely-tuned technical open questions** that surface during triage — the kind where a ticket asks the maintainer to make a small technical call (how much to expose, whether to cap something, which error shape, how to split the work). These are rarely the maintainer's to answer: they follow from where the product is going and from how mature tools solve the same problem. Resolve them yourself instead of blocking.

Read this alongside `docs/adr/` (the settled decisions these principles are drawn from) and the per-package `CONTEXT.md`.

## How to use this doc

When a ticket raises a technical open question, first decide whether it's something you can **resolve** or a genuine fork you must **escalate** (see [The line](#the-line)). If it's resolvable, run [the research formula](#the-research-formula): anchor in the product direction, compare prior art, and recommend. Fold the recommendation into your proposal and let it raise your confidence toward `ready-for-agent`.

## Product direction

Where cogwork is going. Every technical call should support this trajectory, not just today's shape. The live planning surface for this direction is the wayfinder map ([#146](https://github.com/taylorfsteele/cogwork/issues/146)); the roadmap below was settled at its charting session.

- **Today:** a single-user, local tool — a CLI plus a daemon over local RPC, orchestrating AFK coding agents against your issue tracker, driven through an external agent CLI (cursor-acp over ACP).
- **Phase 1 — mission control.** A desktop app that is a control tower for the AFK agents: every run streaming live, the lifecycle board, triage overrides (not approval gates — see principle 11), PR handoffs, budget dials, kick-off/cancel. No chat surface. Audience: the maintainer, dogfooding — cogwork builds cogwork.
- **Phase 2 — the first-party agent runtime.** cogwork owns the model loop: a TanStack AI runner (provider adapters, tool calling, approval flow) registered *behind* the existing `HarnessRunner` seam, beside the CLI harnesses rather than replacing them. Bring-your-own-provider (log in with your OpenAI/Anthropic account or an API key); CLI harnesses remain for subscriptions that live in a CLI. See engine ADR-0006.
- **Phase 3 — the proactive assistant layer.** The Feldspar product model folded in: background ingestion of meetings/Slack/calendar, precision-gated suggestions, tickets minted from real-world context. The north-star capstone: a meeting mentions a bug, cogwork mints the ticket, triages it, implements it, and opens the PR.
- **Later, explicitly sequenced after phases 1–2:** interactive sessions (chat, steer/queue, mid-run approvals). Session contracts are designed interactive-ready from the start; the surface comes later.
- **Audience trajectory:** maintainer-dogfooding first, trending toward casual non-coders as the Feldspar model lands. Provider login UX and simplified vocabulary matter more over time.
- **The web/hosted future:** the daemon becomes remote and multi-user someday. Architect every contract hosted-ready; build none of the hosting now. Selling our own AI provider is a far-future product, not a current concern.
- **Config direction:** workspace config moves toward **declarative, schema-validated, syncable data** — GUI-editable and cloud-syncable, the way Cursor and Codex keep settings. (It's executable TypeScript today; that's a migration, not the destination.)

**Reference implementations.** Learn from how mature coding-agent tools solve these problems: Cursor, Codex, and Claude Code, plus two apps vendored on disk for you to read directly — `.repos/opencode` (the model for *owning* the agent loop: session drain, System Context, provider routes) and `.repos/t3code` (the model for the control plane: event-sourced orchestration, typed contracts, Electron-supervised server). For the proactive layer, Feldspar (`~/sites/feldspar`) is the product reference — take its product lessons (prepared next steps over briefings, precision over recall, human-approved tool plans), not its code. Ground a recommendation in how one of these actually does it rather than reasoning from first principles alone.

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

10. **Architect hosted-ready; build local-first.** When a contract, transport, or storage decision has a cheap shape that survives "the daemon goes remote and multi-user" and an equally cheap shape that doesn't, take the one that survives. Don't build the hosting itself — no auth systems, no tenancy — just don't bake single-user, single-machine assumptions into seams that are expensive to reopen. (map #146)

11. **The pipeline is autonomous-with-override, not approval-gated.** Agents run end-to-end unattended; the one hard human gate is PR review + merge. Triage exercises judgment — it drives well-defined work straight to a PR and *self-halts* (parks as `needs-info` / `ready-for-human`, with its reasoning) when requirements are unclear, conflict with the code, or the work is too big for one session. So a new surface's default posture is to *inform and offer override*, never to block the agent behind a human's approval; and when autonomy quality is the question, invest in the agent's self-halt judgment over building gates. (ADR-0007)

## The line

The whole point: know which questions to resolve and which to escalate.

**Resolve it yourself** when the answer follows from the direction and principles above, or from prior art. These are finely-tuned technical one-offs — how much to expose, whether to cap, which error shape, how to split. Research, compare, recommend, and let your confidence rise toward `ready-for-agent`. Put the recommendation and its rationale in the proposal.

**Escalate it** — via `ready-for-human`, with the question stated — only when the answer would establish **new product direction** not yet covered here or in an ADR. Signs it's a real fork: it trades off the product's identity, moves the roadmap, or principled people would genuinely disagree and the choice *defines* the product.

**The corpus compounds.** Every fork the maintainer answers should become a new principle here or a new ADR. So the same question never escalates twice — over time, more questions fall on the "resolve" side, and escalations shrink to only the genuinely new.

## The research formula

1. **Anchor in the direction.** Where is the product going (see [Product direction](#product-direction)), and what does this decision need to support *there*, not just today?
2. **Compare prior art.** How do the reference implementations handle it? Read the vendored `.repos/opencode` and `.repos/t3code`; recall Cursor / Codex / Claude Code.
3. **Recommend.** Lay out the options, pick one, and justify it against the direction and principles. A recommendation with a rationale beats a question kicked back.

## Worked examples

Keep this to the one or two examples that teach the line most clearly; it grows as better ones arrive.

From #25 (harden the daemon RPC/socket trust boundary): four of its five open questions were resolvable straight from the principles above. The one genuine fork:

- **Should workspace config be data or code?** → *Escalate.* This sets product direction — it defines how config is authored, synced, and secured for the desktop/web future. The maintainer chose **data**; that answer is now principle 2 / ADR-0006, so the next config question resolves instead of escalating.
