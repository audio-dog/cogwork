# Contracts (shared kernel)

The Effect schemas that define the orchestration domain's shared vocabulary. Every other
orchestration context (`engine`, `cli`, `cursor-acp`) speaks these terms; this package owns them.
Definitions here are the source of truth — other contexts reference them rather than redefine.

## Language

The glossary is split into parts, one for each concept:

- [Work](CONTEXT-work.md) — The Issue tracker, Work items, Workspaces, and the identities and allowlists that decide which work Cogwork picks up.
- [Configuration: settings and Resolution](CONTEXT-configuration-settings.md) — The Control store, the four settings layers, Authority, Scope, and how Resolution combines them.
- [Configuration: Plugins and Customize](CONTEXT-configuration-plugins.md) — Plugins, Install records, the Plugin catalog, and the Customize, Connections, and Workspaces surfaces.
- [Configuration: Contribution kinds](CONTEXT-configuration-contribution-kinds.md) — The Contribution kinds a Plugin bundles, Connections and their readiness, and the Sandbox policy.
- [Workflows](CONTEXT-workflows.md) — The Workflow, its document, Working copy, Published revision, Diagnostics, and templates.
- [Triggers](CONTEXT-triggers.md) — Triggers, Trigger filters, Trigger sources and events, and the rules that decide when a Workflow starts.
- [Operations](CONTEXT-operations.md) — Operations, their definitions and settings, Transitions, Output actions, Work context, and triage terms.
- [Human touchpoints](CONTEXT-human-touchpoints.md) — The points where a Workflow reaches a person: Park, Approval, Choose an answer, and Notification.
- [Coordination](CONTEXT-coordination.md) — Claims, Attempt and Handback records, Lineage, and Round summaries.
- [Credentials](CONTEXT-credentials.md) — The Credential store that supplies Connections with their secrets.
- [Runs](CONTEXT-runs.md) — The Run plan, the Run and its ledger and events, Sessions, Retry, and Run takeover.
- [Harness contract](CONTEXT-harness-contract.md) — The Harness, its options, readiness, capability profile, request, Operation result, and events.
- [Daemon status (read models)](CONTEXT-daemon-status.md) — The Daemon status snapshot and the item read models that clients display.
- [Client RPC](CONTEXT-client-rpc.md) — Query and command RPCs, the Principal, Daemon events, and the Board.
