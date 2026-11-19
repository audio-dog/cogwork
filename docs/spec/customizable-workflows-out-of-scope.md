## Out of Scope

From the map, and confirmed by the grills:

- **Workflow sharing** — export/import and repo-shipped definitions. The document is shaped so export is get-the-published-copy and import is `create`; the trust fight over repo-shipped executable behaviour is a later effort.
- **Preview-environment infrastructure.** Verify stays a validation case; the Step node slot exists; what fills it is separate.
- **Hosted multi-user.** Single-user; a Principal column and machine-local Control store, no tenancy.
- **The chat surface** — the authoring agent a person talks to, steer/queue, interactive sessions, and the **Cogwork Bot** (Cogwork posting about its own state in Slack). This spec shapes the contract it will drive. `@tanstack/ai-skills` (an authoring skill with examples) and `@tanstack/ai-mcp` (the same `toolDefinition` list projected to an external Harness) are "later"; Code Mode is never used for authoring.
- **The generic webhook Trigger** and webhook payloads as Work context; **receiving GitHub, Linear, and Granola events** instead of polling. Both need a public address: hosting.
- **A decisions tier** between typed Trigger parameters and a full Operation.
- **Per-Workflow budgets.** The global daily budget and concurrency stay engine-level.
- **A Model level** (`light` / `standard` / `deep`) in the document; waits for Harness adapters to own the mapping (ADR 0028).
- **Review line comments on removed lines**; the first shape covers the new side.
- **An authored `onFailure` Transition**; the engine's failure path is fixed and additive later.
- **A per-Operation round cap** separate from the hop cap.
- **Merge a pull request, delete anything, Monday digest, PR Merged → Verify as a template** — absent because nobody asked, not banned.
- **Agent-managed self-repair of Workflows** (Zapier's pattern) — a later Workflow, never engine behaviour.
- **Not borrowed:** TypeScript as the document, live-on-save, silent key dropping, a startup trust dialog, Feldspar's fail-soft deterministic fallback on judgement failure, a tracker issue per Trigger event, an event log as the Trigger authority.

