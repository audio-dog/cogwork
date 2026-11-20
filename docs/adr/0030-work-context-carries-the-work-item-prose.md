# 0030 — Work Context carries the work item's prose

- **Status:** accepted
- **Date:** 2026-09-30

> **Amendment (2026-10-27).** [Customizable Workflows §17](../spec/customizable-workflows-documents-and-adrs-the-build-changes.md#17-documents-and-adrs-the-build-changes)
> generalizes Work Context to every source. Each item kind has one frozen shape, read once at
> admission: issue, pull request, transcript, Slack conversation, schedule tick, or a future source.

> **Amendment (2026-09-30).** A follow-up Run also freezes its pull request's description and review
> comments into Work Context at admission, for the same reasons. It is also a prerequisite of ADR
> [0032](./0032-resource-references-make-their-reader-a-required-need.md): the engine can only derive a
> resource reference, and fail before the Run, from prose it read before the Run. Each round's
> admission reads the pull request again, so a comment added between rounds reaches the next Run.

## Context

A Run's Work Context carries the work item's reference and its coordination facts (roles, claim,
blockers, priority, pull request), and nothing else. The Messages then tell the agent to "read the
issue and its comments as the brief", so every Run spends its first turns fetching the brief through
an issue-tracker MCP server. The glossary disagreed with the code the whole time: it defines Work
Context as the facts supplied to a Run, "such as a work item's body and comments", while the Run
Plan entry said the plan keeps only the reference "for live prose reads". No decision records the
live-read choice.

The 2026-09-23 retrospective priced it. Linear read calls ran to roughly two hundred across the
sampled Runs. Codex Runs saw two Linear surfaces — the engine-projected MCP server and the Codex CLI's
own Apps connector — and in PROD-8017 the connector's expired token sent the agent into a
fifteen-minute rebuild of its brief from chat before the first edit.

The first fix, #762 as first written and pull request #765, patched the instance: a
`codex`-and-Linear branch in Run Plan resolution that required the Linear MCP server and Connection,
a literal plugin id, and a hostname check in the codex adapter that switched off one Codex App. It
would still be needed if the system were shaped right, so it treats the symptom (**Fix the class, not
the instance**). The class is that the engine withholds the brief it already reads: both
issue-tracker adapters list a work item's comments for coordination, and the engine is the named
authority for the work item (**Name the authority; derive the rest**). Fetching a ticket is
deterministic work (**Models are for intelligence; the engine is for everything else**), and a Run
that must discover its own brief spends the minutes that are both the latency and the unreliability
(**Build the environment, not the prompt**).

## Decision

- **Work Context carries the work item's prose.** At admission the engine reads the work item's
  body and its comment thread — including the triage proposal and its requirements digest (ADR
  [0029](./0029-triage-owns-context-acquisition.md)) — through the issue-tracker port, and freezes
  them into the Run Plan beside the coordination facts. The Operating Instructions read the brief
  from Work Context.
- **Every operation requires the issue-tracker Connection.** The Operation Definitions of triage,
  implement, and follow-up declare the Workspace's issue-tracker Connection as a required need, for
  every Harness and every tracker. An unready Connection is an ordinary Run Plan rejection, with no
  Harness- or tracker-specific branch. The admission-time read is the proof that the credential
  works.
- **A tracker MCP server is optional context in a headless Run.** A requirement never rests on it
  (**Explicit over ambient**). The engine owns every tracker write a headless Run needs: triage's
  proposal, implement's `stuck` explanation, and follow-up's round summary all ride the structured
  Operation result and are posted by the engine.

## Considered options

- **Live reads through a tracker MCP server** (status quo): every Run re-fetches deterministic data,
  depends on a second credential path, and fails in whatever way the surface it happens to pick
  fails.
- **Suppress the duplicate surface per Harness and require it at planning** (#765): closes one
  Harness–tracker pair, teaches the runner to choose Run membership by hostname, and leaves the
  brief fetch — the cause — in place. Rejected.
- **Fetch the prose at dispatch, not admission**: fresher by seconds, at the cost of a Run Plan that
  is no longer the accepted, immutable resolution. Rejected.

## Consequences

- A steer posted while a Run is in flight does not reach that Run. The follow-up operation's human
  feedback trigger picks it up on the next round; the Run Plan stays immutable.
- Run Plans grow by the size of a work item's thread. The frozen prose is persisted with the plan
  and pruned with it.
- Once headless Runs carry no requirement on a tracker MCP server, the duplicate-Linear-surface
  question loses its stakes without a Codex-specific rule. Whether to switch off Harness-native
  connectors wholesale is a separate question about ambient optional context.
