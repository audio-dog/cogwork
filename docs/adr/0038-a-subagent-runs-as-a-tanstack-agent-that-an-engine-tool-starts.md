# 0038 — A Subagent runs as a TanStack agent that an engine tool starts

- **Status:** accepted
- **Date:** 2026-11-17

## Context

[#884](https://github.com/taylorfsteele/cogwork/issues/884) asked for delegation through TanStack
AI's `chat({ subagents })`. Two facts about TanStack AI stop that for a Run:

- **`chat()` refuses `subagents` together with `outputSchema`.** It throws
  `chat() does not support subagents together with outputSchema`. Every workflow Run has a
  Structured Output. The guard is in `@tanstack/ai` 1.0.0 and in each release up to 1.5.0. The docs
  and the types do not show it.
- **The MCP tool bridge gives a tool no channel for child events.** `chat({ subagents })` puts the
  events of a child into the parent stream through a private field of the tool context. TanStack
  sets that field only when its own engine runs the tool loop. Claude Code and Codex run their own
  tool loop and call `chat()` tools through the host MCP tool bridge. The bridge gives a tool
  `threadId`, `context`, `abortSignal`, and `emitCustomEvent`. It gives no tool call id and no child
  event channel. This is true in `@tanstack/ai-sandbox` 1.0.0 and 1.3.0.

TanStack's own design has the reverse shape of a Run. Its `codingAgents` plugin makes a provider
model the parent, and makes Claude Code and Codex the children.

## Decision

The Harness stays the parent of a Run. Each Available Subagent is a TanStack agent (`defineAgent`).
An engine tool with the Subagent's name starts that agent through `runAgentStream`, the TanStack API
that runs an agent with no parent `chat({ subagents })`. The Subagent runner chooses the adapter and
the model of the child. A sink collects the usage of the child, and `SubagentBudget` holds the limits.

## Considered options

- **`chat({ subagents })`, and a second `chat({ outputSchema })` for the Structured Output**: adds
  one turn to each Run. It gives child events only on the provider runner, because of the bridge.
- **A provider model as the parent of each Run** (TanStack's `codingAgents`, on
  `@tanstack/ai-harness`): gives everything that `chat({ subagents })` has. But another model
  executes the Run Plan, the Harness gets only a task text, each Run needs a provider key beside
  Harness-owned authentication, and the Harness cannot delegate in the middle of its work. That
  changes what a Run is. Deferred to the BYOK work, not rejected.
- **A plain tool that starts a hand-made child `chat()`** (the first version of #884): the child
  yields no subagent events, so a later change has nothing to carry to the Run view.

## Consequences

- `runAgentStream` yields `SUBAGENT_STARTED`, the events of the child with a `subagentRunId`, and
  `SUBAGENT_FINISHED` or `SUBAGENT_ERROR`. The Subagent tool reads them for the result and drops
  them. [#983](https://github.com/taylorfsteele/cogwork/issues/983) sends them into the Run's event
  stream, and [#885](https://github.com/taylorfsteele/cogwork/issues/885) shows each child as a card.
- On Claude Code and Codex, a child event has no `parentToolCallId`.
- A follow-up call to the same child, child persistence, and interrupts in a child are not
  available. They are part of `chat({ subagents })` only.
- TanStack reserves the agent name `main`. A Subagent with that name is left out, as is a Subagent
  with the name of a parent tool.
- When TanStack permits `subagents` together with `outputSchema`, and the bridge carries child
  events, a Run can pass the same agents to `chat({ subagents })` and the engine tool can go.
