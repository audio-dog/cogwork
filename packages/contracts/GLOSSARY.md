# Contracts (shared kernel)

The Effect schemas that define the orchestration domain's shared vocabulary. Every other
orchestration context (`engine`, `cli`, `cursor-acp`) speaks these terms; this package owns them.
Definitions here are the source of truth — other contexts reference them rather than redefine.

## Language

Each file below holds one group of terms. Find a term in this list, then read its file.

- [Work](./GLOSSARY-work.md): **Issue tracker**, **Source control provider**, **Work item**, **Link key**, **Workspace**, **Actor identity**, **Assignee allowlist**, **Bot allowlist**, **Follow-up trigger**
- [Configuration](./GLOSSARY-configuration.md): **Control store**, **Settings profile**, **Runtime host**, **Workspace input**, **Private workspace overlay**, **Authoring tree**, **Authority**, **Scope**, **Skill, Rules and Subagent have no setting**, **Resolution**, **Plugin**, **Install record**, **Plugin catalog**, **Plugins**, **Customize**, **Connections**, **Workspaces**
- [Contributions](./GLOSSARY-contributions.md): **Contribution kind**, **Connection**, **Connection readiness**, **Tool**, **Skill**, **MCP server**, **MCP server readiness**, **Rules**, **Middleware**, **Hook**, **Subagent**, **Sandbox policy**
- [Workflows](./GLOSSARY-workflows.md): **Workflow**, **Workflow document**, **Working copy**, **Workflow edit**, **Published revision**, **Diagnostic**, **Workspace selection**, **Workflow template**, **Trigger and action catalog**
- [Triggers](./GLOSSARY-triggers.md): **Trigger**, **Trigger filter**, **Condition / occurrence**, **Parameter**, **Catch-up window**, **Quiet period**, **Sweep**, **Trigger source**, **Trigger event**, **Source revision**, **Origin record**
- [Operations](./GLOSSARY-operations.md): **Operation**, **Permission profile**, **Operation definition**, **Operation settings**, **Question**, **Agent input**, **Fan-out**, **Transition**, **Hand-off**, **Output action**, **Action plan**, **Operating instructions**, **Work context**, **Resource reference**, **Priority**, **Triage role**, **Requirements digest**, **Review requirements**, **Blocked / blocker / blocking**
- [Human touchpoints](./GLOSSARY-human-touchpoints.md): **Human touchpoint**, **Park**, **Park reason**, **Approval**, **Choose an answer**, **Notification**
- [Coordination](./GLOSSARY-coordination.md): **Claim**, **Refused claim**, **Attempt record**, **Handback record**, **Lineage**, **Hop**, **Round summary**
- [Credentials](./GLOSSARY-credentials.md): **Credential store**
- [Runs](./GLOSSARY-runs.md): **Run plan**, **Run**, **Run ledger**, **Run event**, **Run activity**, **History end**, **Session**, **Session resume**, **Retry**, **Replacement Run**, **Run takeover**, **Harness switch**, **Exhausted / stuck**, **Interrupted / crashed**
- [Harness contract](./GLOSSARY-harness-contract.md): **Harness**, **Harness-owned authentication**, **Harness option catalog**, **Option descriptor**, **Canonical option id**, **Model options**, **Model level**, **Harness readiness**, **Harness state**, **Harness sign-in**, **Harness preflight**, **Harness capability profile**, **Harness execution boundary**, **Harness request**, **Operation result**, **Refused result**, **Operating-instructions package**, **Harness event**, **Correlation ids**
- [Daemon status (read models)](./GLOSSARY-daemon-status.md): **Daemon status**, **Actionable / claimed / blocked / needs-human / ready-to-merge item**, **Inline triage proposal**, **PR summary**
- [Client RPC](./GLOSSARY-client-rpc.md): **Query RPC / command RPC**, **Principal**, **Daemon event**, **Board**
