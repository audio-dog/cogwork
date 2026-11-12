# The first-party agent runtime lives behind the harness seam

> **Amendment (2026-10-27).** [Customizable Workflows §17](../../../../docs/spec/customizable-workflows.md#17-documents-and-adrs-the-build-changes)
> narrows "utility model calls" to direct model calls the app makes for itself, such as ranking,
> drafting, and summaries. The rule does not cover Operations; each Operation uses the Harness its
> author chose.

> **Implementation amendment (2026-09-03).** The external side of this seam is now one engine-owned runtime with thin Claude Code and Codex descriptors and a Cursor descriptor that retains only ACP-specific behavior. A shared public-Harness conformance suite holds their common orchestration contract while capability profiles expose native inequalities. This does not activate durability or takeover.

The engine has always been one tier above the agent: it resolves a playbook into a prompt and hands it to an external CLI over the `HarnessRunner` contract (`prompt in → Stream<HarnessEvent> out`), and that process owns the model loop, the tools, and the context discovery. [Issue #117](https://github.com/taylorfsteele/clanker-forge/issues/117) asked whether cogwork should instead *become* the agent. The wayfinder charting session ([map #159](https://github.com/taylorfsteele/cogwork/issues/159)) answered yes, for three product reasons the wrapped-CLI shape cannot deliver: **bring-your-own-provider** for an audience that trends toward non-coders (log in with your OpenAI or Anthropic account — no CLI installs), **cheap direct model calls** for the utility work the roadmap depends on (triage routing, ranking, drafting, summaries), and **engine-owned context assembly** (the concern ADR 0005 already placed on the engine's side of the seam).

The decision is *where* the owned loop lives: cogwork builds a **first-party runner** — a TanStack AI `chat()` loop with provider adapters, tool calling, and the approval flow — and registers it **behind the existing `HarnessRunner` seam**, beside the external CLI harnesses rather than in place of them. The first-party runner becomes the default path and the only one casual users ever see; cursor-acp and future CLI adapters remain pluggable runners for users whose paid plan lives in a CLI (Cursor has no API — the CLI *is* the access). One hard rule keeps the split coherent: **utility model calls go only through the owned provider layer.** Harnesses exist solely to run coding sessions; nothing else in the app may depend on one being installed.

## Considered Options

- **Own the loop and retire the harness layer** (opencode's shape). Rejected: it deletes the only access path for Cursor-subscription users, throws away a working adapter, and turns an incremental migration into a big bang where nothing ships until the runtime, tools, and permissions all exist.
- **Stay a pure orchestrator and wrap more CLIs** (t3code's shape — Claude Code, Codex, opencode adapters beside cursor-acp). Rejected: "install this CLI and log into it" is developer UX and the long-term audience is not developers; the proactive layer starves without direct model calls; permissions become a facade over five divergent native policies (t3code's own documented pain); and it is a dead end for ever offering our own provider — you never own the loop you would someday sell.
- **First-party runner behind the seam** (chosen). Everything the first option buys — provider login, direct calls, owned context — while cursor-acp keeps working and the daemon keeps running throughout the migration. The seam is already the right width: cursor-acp streams TanStack chunk events today, which is why `HarnessEvent` is AG-UI-shaped.

## Consequences

Two execution paths, deliberately unequal. Harness-run sessions are second-class: owned permissions, context assembly, and per-tool-call events do not reach inside an external CLI's loop, and that asterisk is accepted rather than papered over. The `HarnessRequest`/`HarnessEvent` contract widens (tool calls, permission asks, richer activity for clients) and both paths must honor the one contract — the first-party runner natively, the CLI adapters as best they can.

This confirms and extends ADR 0005's split: the engine assembles a run's capabilities (context, MCP skills, credentials); the runner renders them. The first-party runner is simply the first renderer we own end to end.

Per the map's standing preference, the runtime is architected hosted-ready — multi-user, network-capable contracts, no single-user assumptions — while everything built now runs local-first and single-user.

This ADR records the decision. The provider runner and all three external Harnesses are registered behind the seam.

## Amendment ([#196](https://github.com/taylorfsteele/clanker-forge/issues/196)): the request references a session, it does not carry history

The seam still takes a request in and streams events out — that has not changed. What changed is the shape of the request. It used to be a prompt string plus a loose resume handle; now it carries a `SessionId` (the engine session this run belongs to, or null for a fresh start) alongside the turn's prompt. The runner pulls whatever history it needs from that reference **in-process**, rather than the engine freezing a transcript and pushing it across.

The reason is compaction. Context grows inside the model loop, so the loop is the only place that can decide what to keep — a transcript frozen at dispatch time can't. Pulling by reference keeps that decision where it belongs and, as a bonus, a `SessionId` is the small, network-friendly thing that crosses any future wire; a bundled transcript is neither.

The two paths pull different things from the same reference, which is exactly ADR 0002's session sum type showing through: `cursorRunner` resolves the session's opaque handle (via `SessionStore`) and hands it to Cursor to resume its own history; the owned runner, when it lands, folds the transcript from the ledger through the same store. The prompt on the request is only ever this run's instruction — never accumulated history. cursor-acp keeps working unchanged through the reshaped seam.
