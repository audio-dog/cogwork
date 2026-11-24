# Contracts (shared kernel)

The Effect schemas that define the orchestration domain's shared vocabulary. Every other
orchestration context (`engine`, `cli`, `cursor-acp`) speaks these terms; this package owns them.
Definitions here are the source of truth — other contexts reference them rather than redefine.

A term belongs here only when two or more contexts speak it through this package: as a schema in
`src/`, or across the RPC contract a client and the daemon share. A term that one context defines
and acts on lives in that context's glossary, even when another context names it.

## Language

Each file below holds one group of terms. Find a term in this list, then read its file.

- [Work](./GLOSSARY-work.md): **Issue tracker**, **Source control provider**, **Work item**, **Workspace**, **Assignee allowlist**, **Linear teams**, **Bot allowlist**, **Follow-up trigger**
- [Configuration](./GLOSSARY-configuration.md): **Control store**, **Settings profile**, **Runtime host**, **Workspace input**, **Private workspace overlay**, **Authoring tree**, **Authority**, **Scope**, **Skill, Rules and Subagent have no setting**, **Resolution**, **Plugin**, **Install record**, **Plugin catalog**
- [Contributions](./GLOSSARY-contributions.md): **Contribution kind**, **Connection**, **Connection readiness**, **Tool**, **Skill**, **MCP server**, **MCP server readiness**, **Rules**, **Middleware**, **Hook**, **Subagent**, **Sandbox policy**
- [Workflows](./GLOSSARY-workflows.md): **Workflow**, **Workflow document**, **Working copy**, **Workflow edit**, **Published revision**, **Diagnostic**, **Workspace selection**, **Workflow template**, **Trigger and action catalog**
- [Triggers](./GLOSSARY-triggers.md): **Trigger**, **Trigger filter**, **Condition / occurrence**, **Parameter**, **Trigger source**, **Source revision**
- [Operations](./GLOSSARY-operations.md): **Operation**, **Permission profile**, **Operation definition**, **Operation settings**, **Question**, **Agent input**, **Fan-out**, **Transition**, **Hand-off**, **Output action**, **Action plan**, **Operating instructions**, **Work context**, **Priority**, **Blocked / blocker / blocking**
- [Human touchpoints](./GLOSSARY-human-touchpoints.md): **Human touchpoint**, **Park**, **Park reason**, **Start over**, **Approval**, **Choose an answer**, **Notification**
- [Coordination](./GLOSSARY-coordination.md): **Claim**, **Attempt record**, **Handback record**, **Lineage**, **Hop**
- [Runs](./GLOSSARY-runs.md): **Run plan**, **Run**, **Run ledger**, **Run event**, **Run activity**, **History end**, **Session**, **Exhausted / stuck**, **Interrupted / crashed**
- [Harness contract](./GLOSSARY-harness-contract.md): **Harness**, **Harness-owned authentication**, **Harness option catalog**, **Option descriptor**, **Canonical option id**, **Model options**, **Model level**, **Harness readiness**, **Harness state**, **Harness sign-in**, **Operation result**, **Operating-instructions package**, **Harness event**, **Correlation ids**
- [Daemon status (read models)](./GLOSSARY-daemon-status.md): **Daemon status**, **Actionable / claimed / blocked / needs-human / ready-to-merge item**, **Inline triage proposal**, **PR summary**
- [Client RPC](./GLOSSARY-client-rpc.md): **Query RPC / command RPC**, **Principal**, **Daemon event**, **Board**

## Terms other contexts own

Definitions here use these terms, but another context defines each one. Read the term in that
context's glossary.

- [Engine](../engine/GLOSSARY.md): **Link key**, **Actor identity**, **Credential store**, **Trigger event**, **Sweep**, **Resource reference**, **Refused result**, **Session resume**, **Retry**, **Replacement Run**, **Harness request**, **Harness execution boundary**, **Round summary**
- [Desktop](../../apps/desktop/GLOSSARY.md): **Plugins**, **Customize**, **Connections**, **Workspaces**
