# 0032 — Resource references make their reader a required need

- **Status:** accepted
- **Date:** 2026-09-30

## Context

PROD-8132 linked its design in Figma. Its triage Run had no Figma MCP server in the Run Plan, found
no Figma Tool of its own, tried a browser, was refused, and parked the ticket `ready-for-human` with
"Linked Figma design was inaccessible." The failure was found by a model, inside the Run, after the
claim.

A Figma server cannot simply be a required need of an Operation. Operation Definition needs are fixed
per Operation, so a required Figma server would stop triage, implement, and follow-up for every work
item — including the many with no Figma link — whenever the Figma desktop app is closed. It cannot be
optional either and still fail before the Run when a ticket does link Figma. And a Plugin may never
mark itself required for an Operation it does not own.

ADR [0030](./0030-work-context-carries-the-work-item-prose.md) gives the engine the missing input: the
work item's prose is frozen into Work Context at admission, before the Harness starts. What the Run
needs can now be read from what the work says.

Figma's hosted MCP server does not admit Cogwork: client registration is gated on an allowlisted
client name, new approvals are paused, and registering under another client's name breaks Figma's
Acceptable Use Policy (§ 2(a) and § 2(d)). The first reader is therefore the Figma desktop app's local
server. See Figma's [remote server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
and [desktop server](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)
docs and its [Acceptable Use Policy](https://www.figma.com/aup/).

## Decision

- **The engine derives resource references.** At admission the engine parses the frozen Work Context
  prose into typed **resource references** — a pointer to one resource in an external system, such as
  `{ system: "figma", fileKey, nodeId, url }` — and freezes them into Work Context beside the prose.
  Every supported link counts, wherever it appears in the prose; a link kind no server can read is
  ignored.
- **A server declares what it reads; the engine makes it required.** An MCP server's file may declare
  the systems it reads (`"reads": ["figma"]`). That is an offer. The one rule, owned by the engine and
  shared by every Operation, is that each resource reference makes a ready MCP server that reads its
  system a required need of that Run.
- **Readiness proves the server works, not the resource.** Before the Run the engine sends MCP
  `initialize` and `tools/list` to the server. It does not probe the referenced nodes; what the Run
  finds inside the resource is the agent's work.
- **A readiness rejection is not a failed attempt.** An unready need releases the claim, records the
  reason, shows the item waiting with that reason, and admits it when the need is ready. It never
  moves the item toward exhaustion and never parks it for a human. A failed attempt is work an agent
  was given and could not do.

## Considered options

- **A conditional need in each Operation Definition** (`requiredWhen: "prose links figma.com"`):
  binds three engine-authored Definitions to one Plugin's server name — the literal-plugin-id shape
  ADR 0030 rejected in #765 — and repeats for every new system. Rejected.
- **A static required need**: stops every Operation whenever Figma is closed, for work that never
  mentions Figma. Rejected.
- **A Plugin that declares itself required when its links appear**: breaks the rule that a Plugin
  only offers. Rejected.
- **A deep probe of each referenced node** (`get_metadata` per reference): proves more, but moves the
  agent's work into the engine and couples readiness to one server's Tool contract. Rejected.
- **The hosted Figma server under a listed client's name**: technically works, forbidden by Figma's
  terms. Rejected.

## Consequences

- A ticket that links Figma waits until the Figma desktop app is running with its server enabled. A
  ticket that does not link Figma never waits on it.
- The desktop server reads the file open in the app. A different open file can answer the same node
  id with the wrong frame, and readiness cannot see that; the Figma Plugin's Rules tell the agent to
  stop and report a mismatch.
- A link that appears only in a pull request's description or review comments makes nothing required
  until follow-up's Work Context freezes that prose too.
- A new system — a Sentry issue, a Notion page — costs one reference parser and one `reads` value,
  with no change to any Operation Definition.
