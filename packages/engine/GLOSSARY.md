# Engine (orchestration runtime)

The work control plane packaged as an embeddable library — the machinery that discovers, schedules,
and runs work. It owns the *verbs*, and the nouns that only it speaks; the shared nouns live in the
shared kernel ([contracts](../contracts/GLOSSARY.md)). It has no process identity of its own; the
daemon hosts it.

Role in the flow: **observe → schedule → run → dispatch to a harness**. See the root
`GLOSSARY-MAP.md` for the end-to-end story.

## Language

Each file below holds one group of terms. Find a term in this list, then read its file.

- [Daemon and scheduling](./GLOSSARY-daemon.md): **Daemon**, **Trigger observation**, **Rate-limit scope**, **Cooldown window**, **Ready-to-merge view**, **Assignee ownership gate**, **Scheduler**, **Drain**, **Crash recovery**, **Candidate**
- [Triggers](./GLOSSARY-triggers.md): **Trigger event**, **Origin record**, **Sweep**, **Catch-up window**, **Quiet period**
- [Runs](./GLOSSARY-runs.md): **Workflow runner**, **Run preparation**, **Run completion**, **Refused result**, **Run recorder**, **Session store**, **Session resume**, **Retry**, **Replacement Run**, **Run takeover**, **Harness switch**, **Run Plan resolution**, **Resource reference**, **Action entry**
- [Coding Workflow template](./GLOSSARY-coding-workflow.md): **Triage role**, **Requirements digest**, **Review requirements**, **Round summary**
- [Harness](./GLOSSARY-harness.md): **Harness request**, **Harness service**, **Harness runner**, **Harness preflight**, **Harness capability profile**, **Harness execution boundary**, **External Harness runtime**, **Harness Workspace projection**, **Skills supply**, **MCP server assembler**, **Context assembler**, **Instruction layer**
- [Sandbox and tools](./GLOSSARY-sandbox.md): **Owned tool set**, **Worktree sandbox**, **Path confinement**, **File-diff feed**, **Policy profile**, **Ask-compiles-to-deny**, **Hard-deny rule**
- [Adapters and credentials](./GLOSSARY-adapters.md): **Issue tracker adapter**, **Tracker Trigger source**, **Source control provider adapter**, **Link key**, **Actor identity**, **Credential store**, **Provider key**, **Supported providers**, **Model catalog**, **Model adapter resolution**, **Token refresh**, **Client-credentials grant**, **Stored credential**
- [Coordination and worktrees](./GLOSSARY-coordination.md): **Coordination module**, **Refused claim**, **Park notice**, **Worktree manager**, **Branch divergence**, **Base divergence**, **Workspace registry**
- [Performance](./GLOSSARY-performance.md): **Telemetry store**, **Performance regression sensor**, **Performance verdict**, **Performance issue filer**, **Performance budget sensor**, **Performance budget**, **Replay runner**, **Health signal**, **Fingerprint**
